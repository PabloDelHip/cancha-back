import { describe, expect, it } from 'vitest';
import { MatchStatus, SanctionCause, SanctionKind, SanctionStatus, SendOff, TournamentStatus } from '../../common/enums/index.js';
import { DEFAULT_DISCIPLINE, type DisciplineRules } from './schemas/discipline-rules.schema.js';
import { accumulationKey, classify, computeDiscipline, orderKey, redKey, suspendedIn, type DMatch, type DMembership, type DRecord, type DStat } from './discipline.js';

const A = 'teamA';
const B = 'teamB';
const P = 'player1';
const rules = (r: Partial<DisciplineRules> = {}): DisciplineRules => ({ ...DEFAULT_DISCIPLINE, enabled: true, ...r });

/** Partido n del equipo A (jornada n, una semana entre partidos). */
const m = (n: number, status = MatchStatus.FINISHED, extra: Partial<DMatch> = {}): DMatch => ({
  id: `m${n}`,
  homeTeamId: A,
  awayTeamId: B,
  status,
  date: `2027-01-${String(n * 7).padStart(2, '0')}`,
  time: '18:00',
  round: n,
  phase: 0,
  ...extra,
});
const stat = (matchId: string, s: Partial<DStat> = {}): DStat => ({ matchId, playerId: P, teamId: A, played: true, yellowCards: 0, redCards: 0, sendOff: null, ...s });
const run = (matches: DMatch[], stats: DStat[], r = rules(), records: DRecord[] = [], tournamentStatus = TournamentStatus.ACTIVE) =>
  computeDiscipline({ rules: r, tournamentStatus, matches, stats, records });

describe('classify', () => {
  it('captura nueva: distingue roja directa y doble amarilla', () => {
    expect(classify({ yellowCards: 2, redCards: 1, sendOff: SendOff.SECOND_YELLOW })).toEqual({ accumulate: 0, sendOff: SendOff.SECOND_YELLOW, unclassified: false });
    // Amarilla y después roja directa: la amarilla sí acumula.
    expect(classify({ yellowCards: 1, redCards: 1, sendOff: SendOff.DIRECT })).toEqual({ accumulate: 1, sendOff: SendOff.DIRECT, unclassified: false });
  });

  it('captura anterior: roja o dos amarillas quedan sin clasificar (no se interpretan)', () => {
    expect(classify({ yellowCards: 2, redCards: 0 })).toMatchObject({ unclassified: true, accumulate: 0, sendOff: null });
    expect(classify({ yellowCards: 2, redCards: 1 })).toMatchObject({ unclassified: true });
    expect(classify({ yellowCards: 0, redCards: 1 })).toMatchObject({ unclassified: true });
    expect(classify({ yellowCards: 1, redCards: 0 })).toEqual({ accumulate: 1, sendOff: null, unclassified: false });
  });
});

describe('sanciones automáticas', () => {
  it('roja directa: suspende el siguiente partido y se cumple al jugarlo sin el jugador', () => {
    const matches = [m(1), m(2, MatchStatus.SCHEDULED)];
    const before = run(matches, [stat('m1', { redCards: 1, sendOff: SendOff.DIRECT })]);
    expect(before.sanctions).toHaveLength(1);
    expect(before.sanctions[0]).toMatchObject({ ref: redKey('m1', P), cause: SanctionCause.DIRECT_RED, status: SanctionStatus.ACTIVE, remaining: 1, upcomingMatchIds: ['m2'] });
    expect(suspendedIn(before, 'm2').map((s) => s.playerId)).toEqual([P]);

    const after = run([m(1), m(2)], [stat('m1', { redCards: 1, sendOff: SendOff.DIRECT })]);
    expect(after.sanctions[0]).toMatchObject({ status: SanctionStatus.SERVED, served: 1, remaining: 0 });
  });

  it('duración distinta para roja directa y doble amarilla', () => {
    const r = rules({ directRedMatches: 3, secondYellowMatches: 1 });
    const res = run([m(1), m(2)], [stat('m1', { redCards: 1, sendOff: SendOff.DIRECT }), stat('m2', { yellowCards: 2, redCards: 1, sendOff: SendOff.SECOND_YELLOW })], r);
    expect(res.sanctions.map((s) => [s.cause, s.matches])).toEqual([
      [SanctionCause.DIRECT_RED, 3],
      [SanctionCause.SECOND_YELLOW, 1],
    ]);
  });

  it('acumulación: cada N amarillas; la doble amarilla no cuenta, la amarilla antes de roja directa sí', () => {
    const r = rules({ yellowsForSuspension: 3 });
    const res = run(
      [m(1), m(2), m(3), m(4)],
      [
        stat('m1', { yellowCards: 1 }),
        stat('m2', { yellowCards: 2, redCards: 1, sendOff: SendOff.SECOND_YELLOW }),
        stat('m3', { yellowCards: 1, redCards: 1, sendOff: SendOff.DIRECT }),
        stat('m4', { yellowCards: 1 }),
      ],
      r,
    );
    const acc = res.sanctions.filter((s) => s.cause === SanctionCause.ACCUMULATION);
    expect(acc.map((s) => s.ref)).toEqual([accumulationKey('m4', P)]);
    expect(res.players[0]).toMatchObject({ yellows: 3, towardNext: 0, directReds: 1, secondYellows: 1 });
  });

  it('reinicio por fase: las amarillas de la fase anterior no cuentan', () => {
    const matches = [m(1), m(2), m(3, MatchStatus.FINISHED, { phase: 1 })];
    const stats = [stat('m1', { yellowCards: 1 }), stat('m2', { yellowCards: 1 }), stat('m3', { yellowCards: 1 })];
    expect(run(matches, stats, rules({ yellowsForSuspension: 3 })).sanctions).toHaveLength(1);
    const reset = run(matches, stats, rules({ yellowsForSuspension: 3, resetAccumulationOnPhaseChange: true }));
    expect(reset.sanctions).toHaveLength(0);
    expect(reset.players[0].towardNext).toBe(1);
  });

  it('reglamento desactivado: sin automáticas; las capturas sin clasificar se listan', () => {
    const res = run([m(1)], [stat('m1', { redCards: 1, sendOff: undefined })], rules({ enabled: false }));
    expect(res.sanctions).toEqual([]);
    expect(res.unclassified).toEqual([{ matchId: 'm1', playerId: P, teamId: A, yellowCards: 0, redCards: 1 }]);
  });
});

describe('cumplimiento', () => {
  const red = stat('m1', { redCards: 1, sendOff: SendOff.DIRECT });

  it('cancelados y pospuestos no cuentan ni reservan: abarca el siguiente programado', () => {
    const res = run([m(1), m(2, MatchStatus.CANCELLED), m(3, MatchStatus.POSTPONED), m(4, MatchStatus.SCHEDULED)], [red]);
    expect(res.sanctions[0]).toMatchObject({ status: SanctionStatus.ACTIVE, coveredMatchIds: ['m4'], served: 0 });
  });

  it('jugar suspendido es incidencia, no cuenta como cumplido y la sanción se extiende', () => {
    const res = run([m(1), m(2), m(3, MatchStatus.SCHEDULED)], [red, stat('m2')]);
    expect(res.sanctions[0]).toMatchObject({ served: 0, incidentMatchIds: ['m2'], upcomingMatchIds: ['m3'], status: SanctionStatus.ACTIVE });
    expect(res.incidents).toEqual([{ ref: redKey('m1', P), matchId: 'm2', playerId: P, teamId: A }]);
  });

  it('reprogramar no hace que se cumpla dos veces: el orden sigue a la fecha actual', () => {
    const r = rules({ directRedMatches: 1 });
    // m2 pasa a jugarse después de m3: la sanción la cumple m3, una sola vez.
    const moved = run([m(1), m(2, MatchStatus.SCHEDULED, { date: '2027-02-28' }), m(3)], [red], r);
    expect(moved.sanctions[0]).toMatchObject({ served: 1, coveredMatchIds: ['m3'], status: SanctionStatus.SERVED });
    expect(suspendedIn(moved, 'm2')).toEqual([]);
  });

  it('captura tardía: el partido ocupa su lugar por fecha, no por el momento de captura', () => {
    // m2 se capturó después de m3, pero se jugó antes: es el que cumple.
    const res = run([m(1), m(2), m(3)], [red, stat('m3')]);
    expect(res.sanctions[0]).toMatchObject({ served: 1, coveredMatchIds: ['m2'] });
    expect(res.incidents).toEqual([]);
  });

  it('desempate determinista con misma fecha: hora, jornada e id', () => {
    const a = { phase: 0, date: '2027-01-01', time: '10:00', round: 2, id: 'b' };
    expect(orderKey(a) < orderKey({ ...a, time: '11:00', round: 1, id: 'a' })).toBe(true);
    expect(orderKey({ ...a, round: 1 }) < orderKey(a)).toBe(true);
    expect(orderKey({ ...a, id: 'a' }) < orderKey(a)).toBe(true);
    expect(orderKey({ ...a, phase: 1, date: '2026-01-01' }) > orderKey(a)).toBe(true);
  });

  it('sin partidos programados o con el torneo finalizado queda pendiente, no cumplida', () => {
    expect(run([m(1)], [red]).sanctions[0].status).toBe(SanctionStatus.PENDING);
    expect(run([m(1), m(2, MatchStatus.SCHEDULED)], [red], rules(), [], TournamentStatus.FINISHED).sanctions[0]).toMatchObject({
      status: SanctionStatus.PENDING,
      remaining: 1,
    });
  });

  it('el cambio de fase no reinicia una suspensión pendiente', () => {
    const res = run([m(1), m(2, MatchStatus.FINISHED, { phase: 1 })], [red]);
    expect(res.sanctions[0]).toMatchObject({ status: SanctionStatus.SERVED, coveredMatchIds: ['m2'] });
  });
});

describe('decisiones humanas', () => {
  const red = stat('m1', { redCards: 1, sendOff: SendOff.DIRECT });
  const override = (r: Partial<DRecord>): DRecord => ({
    id: 'o1',
    kind: SanctionKind.AUTO,
    key: redKey('m1', P),
    playerId: P,
    teamId: A,
    cause: SanctionCause.DIRECT_RED,
    matchId: 'm1',
    matches: null,
    reason: null,
    annulled: false,
    ...r,
  });

  it('ajuste de duración y anulación de una automática', () => {
    const matches = [m(1), m(2), m(3, MatchStatus.SCHEDULED)];
    expect(run(matches, [red], rules(), [override({ matches: 2 })]).sanctions[0]).toMatchObject({ matches: 2, ruleMatches: 1, adjusted: true, served: 1, status: SanctionStatus.ACTIVE });
    const annulled = run(matches, [red], rules(), [override({ annulled: true })]);
    expect(annulled.sanctions[0]).toMatchObject({ status: SanctionStatus.ANNULLED, remaining: 0, coveredMatchIds: [] });
    expect(suspendedIn(annulled, 'm3')).toEqual([]);
  });

  it('corregir tarjetas: la automática desaparece y su ajuste queda como huérfano (no se pierde)', () => {
    const res = run([m(1), m(2)], [stat('m1')], rules(), [override({ matches: 3 })]);
    expect(res.sanctions).toEqual([]);
    expect(res.orphans.map((o) => o.key)).toEqual([redKey('m1', P)]);
  });

  it('volver a guardar el mismo resultado no duplica la sanción (clave estable)', () => {
    const a = run([m(1), m(2)], [red]);
    const b = run([m(1), m(2)], [{ ...red }]);
    expect(a.sanctions.map((s) => s.ref)).toEqual(b.sanctions.map((s) => s.ref));
    expect(a.sanctions).toHaveLength(1);
  });

  it('manual: aplica desde el partido indicado (incluido)', () => {
    const manual: DRecord = { ...override({}), id: 'man1', kind: SanctionKind.MANUAL, key: null, cause: SanctionCause.MANUAL, matchId: 'm2', matches: 2, reason: 'Agresión' };
    const res = run([m(1), m(2), m(3), m(4, MatchStatus.SCHEDULED)], [], rules({ enabled: false }), [manual]);
    expect(res.sanctions[0]).toMatchObject({ ref: 'man1', kind: SanctionKind.MANUAL, coveredMatchIds: ['m2', 'm3'], status: SanctionStatus.SERVED });
  });
});

describe('cierre: cambio de equipo, fechas sin actualizar y partido de inicio borrado', () => {
  const C = 'teamC';
  const red = stat('m1', { redCards: 1, sendOff: SendOff.DIRECT });
  /** Partido del equipo C (contra B) en una fecha dada. */
  const c = (id: string, date: string, status = MatchStatus.FINISHED): DMatch => ({ id, homeTeamId: C, awayTeamId: B, status, date, time: '18:00', round: 9, phase: 0 });
  const moved = (date: string): DMembership[] => [
    { playerId: P, teamId: A, startDate: '2026-12-01', endDate: date, active: false },
    { playerId: P, teamId: C, startDate: date, endDate: null, active: true },
  ];

  it('la sanción sigue al jugador: se cumple con el equipo nuevo, solo desde su incorporación', () => {
    // Expulsado con A el 7 ene; pasa a C el 15 ene. C jugó el 10 ene (antes de llegar) y el 20 ene.
    const matches = [m(1), m(2), c('c1', '2027-01-10'), c('c2', '2027-01-20'), c('c3', '2027-01-27', MatchStatus.SCHEDULED)];
    const res = computeDiscipline({ rules: rules({ directRedMatches: 2 }), tournamentStatus: TournamentStatus.ACTIVE, matches, stats: [red], records: [], memberships: moved('2027-01-15') });
    // m2 (14 ene, con A, antes de irse) cuenta; c1 (10 ene) no: llegó después. c2 completa.
    expect(res.sanctions[0]).toMatchObject({ served: 2, coveredMatchIds: ['m2', 'c2'], status: SanctionStatus.SERVED });
  });

  it('sin cumplimiento retroactivo: los partidos del equipo nuevo previos a su alta no cuentan', () => {
    const matches = [m(1), c('c1', '2027-01-10'), c('c2', '2027-01-12'), c('c3', '2027-02-01', MatchStatus.SCHEDULED)];
    const res = computeDiscipline({ rules: rules(), tournamentStatus: TournamentStatus.ACTIVE, matches, stats: [red], records: [], memberships: moved('2027-01-08') });
    // Se fue de A el 8 ene: A ya no cuenta. C cuenta desde el 8: c1 cumple.
    expect(res.sanctions[0]).toMatchObject({ served: 1, coveredMatchIds: ['c1'] });
    const late = computeDiscipline({ rules: rules(), tournamentStatus: TournamentStatus.ACTIVE, matches, stats: [red], records: [], memberships: moved('2027-01-20') });
    // Llegó a C el 20 ene: c1 y c2 ya se jugaron sin él; queda reservado c3.
    expect(late.sanctions[0]).toMatchObject({ served: 0, coveredMatchIds: ['c3'], status: SanctionStatus.ACTIVE });
    expect(suspendedIn(late, 'c3').map((x) => x.playerId)).toEqual([P]);
  });

  it('un pospuesto con su fecha original no cuenta ni reserva y se avisa', () => {
    const matches = [m(1), m(2, MatchStatus.SCHEDULED, { stale: true }), m(3, MatchStatus.SCHEDULED)];
    const res = run(matches, [red]);
    expect(res.sanctions[0]).toMatchObject({ coveredMatchIds: ['m3'], staleMatchIds: ['m2'] });
    expect(res.staleMatchIds).toEqual(['m2']);
    // Capturado con la fecha original: tampoco cuenta (ni como cumplido ni como incidencia).
    const captured = run([m(1), m(2, MatchStatus.FINISHED, { stale: true }), m(3)], [red, stat('m2')]);
    expect(captured.sanctions[0]).toMatchObject({ served: 1, coveredMatchIds: ['m3'], incidentMatchIds: [] });
  });

  it('manual cuyo partido de inicio se borró: aplica desde la posición guardada', () => {
    const manual: DRecord = {
      id: 'man1', kind: SanctionKind.MANUAL, key: null, playerId: P, teamId: A, cause: SanctionCause.MANUAL,
      matchId: 'borrado', matches: 1, reason: 'Agresión', annulled: false,
      start: { phase: 0, date: '2027-01-14', time: '18:00', round: 2 },
    };
    const res = run([m(1), m(2, MatchStatus.SCHEDULED, { id: 'nuevo2' }), m(3, MatchStatus.SCHEDULED)], [], rules({ enabled: false }), [manual]);
    expect(res.sanctions[0]).toMatchObject({ ref: 'man1', coveredMatchIds: ['nuevo2'], status: SanctionStatus.ACTIVE });
  });
});
