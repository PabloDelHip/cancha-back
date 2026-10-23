import { describe, expect, it } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { DEFAULT_TEAM_RULES, DEFAULT_TOURNAMENT_RULES, type Booked, type EvaluationContext, type TeamRules, type TournamentRules } from './scheduling-rules.js';
import { applyAssignments, autoSchedule, rescheduleSearch, roundsWithDates, timesOf, type AutoOptions, type Fixture, type RescheduleItem, type RescheduleOptions } from './auto-scheduler.js';
import { minutesOf as minutesOfLocal } from '../venues/occupancy.js';
import { generateRoundRobin } from '../rounds/round-robin.js';

const T = 'T1';
// 2027-01-08 es viernes; 09 sábado; 10 domingo.
const FRI = '2027-01-08';
const SAT = '2027-01-09';
const SUN = '2027-01-10';
const NAMES: Record<string, string> = { A: 'Tigres', B: 'Chivas', C: 'Leones', D: 'Halcones', E: 'Pumas', F: 'Toros', G: 'Lobos', H: 'Osos' };

function ctx(over: { rules?: Partial<TournamentRules>; teams?: Record<string, Partial<TeamRules>>; matches?: Booked[]; duration?: number } = {}): EvaluationContext {
  return {
    tournamentId: T,
    duration: over.duration ?? 60,
    rules: { ...DEFAULT_TOURNAMENT_RULES, ...over.rules },
    teamRules: new Map(Object.entries(over.teams ?? {}).map(([id, r]) => [id, { ...DEFAULT_TEAM_RULES, ...r }])),
    teamNames: new Map(Object.entries(NAMES)),
    tournamentMatches: over.matches ?? [],
    otherFieldMatches: [],
    fields: new Map(),
  };
}
const opts = (over: Partial<AutoOptions> = {}): AutoOptions => ({
  from: SAT,
  to: '2027-03-31',
  days: [],
  firstKickoff: '18:00',
  lastKickoff: '21:00',
  step: 90,
  daysBetweenRounds: 7,
  fields: [],
  parallel: 1,
  fieldBookings: [],
  ...over,
});
const fx = (round: number, home: string, away: string): Fixture => ({ key: `${round}|${home}|${away}`, round, homeTeamId: home, awayTeamId: away });
/** Liga de todos contra todos con el round robin de siempre. */
const league = (teams: string[], legs: 1 | 2 = 1) => generateRoundRobin(teams, legs).flatMap((r, i) => r.pairs.map(([h, a]) => fx(i + 1, h, a)));
const at = (r: ReturnType<typeof autoSchedule>, key: string) => r.placements.find((p) => p.key === key);

describe('6B — sin restricciones', () => {
  it('cada jornada en su fecha de siempre, partidos uno tras otro (como el generador de siempre)', () => {
    const r = autoSchedule(league(['A', 'B', 'C', 'D']), ctx(), opts());
    expect(r.unplaced).toEqual([]);
    expect(r.placements).toHaveLength(6);
    expect([...new Set(r.placements.map((p) => `${p.round}:${p.date}`))]).toEqual(['1:2027-01-09', '2:2027-01-16', '3:2027-01-23']);
    expect(r.placements.filter((p) => p.round === 1).map((p) => p.time).sort()).toEqual(['18:00', '19:30']);
    expect(r.metrics).toMatchObject({ placed: 6, unplaced: 0, lateRounds: 0, withWarnings: 0, truncated: false });
  });

  it('no repite ni pierde partidos y cada equipo juega una vez por jornada', () => {
    const fixtures = league(['A', 'B', 'C', 'D', 'E', 'F'], 2);
    const r = autoSchedule(fixtures, ctx(), opts({ parallel: 3 }));
    expect(r.placements.map((p) => p.key).sort()).toEqual(fixtures.map((f) => f.key).sort());
    for (const round of new Set(fixtures.map((f) => f.round))) {
      const teams = r.placements.filter((p) => p.round === round).flatMap((p) => [p.homeTeamId, p.awayTeamId]);
      expect(new Set(teams).size).toBe(teams.length);
    }
  });

  it('las jornadas quedan en orden: la siguiente empieza después del último partido de la anterior', () => {
    const r = autoSchedule(league(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']), ctx({ rules: { maxMatchesPerDay: 2 } }), opts({ daysBetweenRounds: 1 }));
    expect(r.unplaced).toEqual([]);
    const rounds = [...new Set(r.placements.map((p) => p.round))].sort((a, b) => a - b);
    for (let i = 1; i < rounds.length; i++) {
      const prevLast = r.placements.filter((p) => p.round === rounds[i - 1]).map((p) => p.date).sort().pop()!;
      const first = r.placements.filter((p) => p.round === rounds[i]).map((p) => p.date).sort()[0];
      expect(first > prevLast).toBe(true);
    }
  });

  it('un partido que no cabe en su jornada queda pendiente sin retrasar al resto; sus equipos respetan el orden', () => {
    // C no puede el primer fin de semana: su partido de la jornada 1 se va al sábado 16.
    const fixtures = [fx(1, 'A', 'B'), fx(1, 'C', 'D'), fx(1, 'E', 'F'), fx(2, 'A', 'C'), fx(2, 'B', 'E'), fx(2, 'D', 'F')];
    const r = autoSchedule(fixtures, ctx({ rules: { days: [0, 6] }, teams: { C: { unavailableDates: [SAT, SUN] } } }), opts({ parallel: 3 }));
    expect(r.unplaced).toEqual([]);
    expect(at(r, '1|C|D')!.date).toBe('2027-01-16');
    // La jornada 2 de quienes no esperan nada sigue en su fecha.
    expect(at(r, '2|B|E')!.date).toBe('2027-01-16');
    // C y D juegan la jornada 2 después de terminar la 1.
    const end1 = `${at(r, '1|C|D')!.date} ${at(r, '1|C|D')!.time}`;
    for (const k of ['2|A|C', '2|D|F']) expect(`${at(r, k)!.date} ${at(r, k)!.time}` > end1).toBe(true);
  });

  it('es determinista', () => {
    const run = () => autoSchedule(league(['A', 'B', 'C', 'D', 'E', 'F']), ctx({ teams: { A: { unavailableDays: [6] } }, rules: { days: [0, 6] } }), opts());
    expect(run().placements).toEqual(run().placements);
  });
});

describe('6B — restricciones obligatorias', () => {
  it('días permitidos: desde un viernes, la jornada va al sábado', () => {
    const r = autoSchedule([fx(1, 'A', 'B')], ctx({ rules: { days: [6] } }), opts({ from: FRI }));
    expect(at(r, '1|A|B')).toMatchObject({ date: SAT, time: '18:00' });
  });

  it('horario del torneo y medianoche: con fin a las 24:00 el último inicio de 60 min es 23:00', () => {
    const r = autoSchedule(
      [fx(1, 'A', 'B'), fx(1, 'C', 'D'), fx(1, 'E', 'F')],
      ctx({ rules: { days: [6], startTime: '22:00', endTime: '24:00' } }),
      opts({ firstKickoff: '22:00', lastKickoff: '23:30', step: 30, daysBetweenRounds: 1, to: SAT }),
    );
    expect(r.placements.map((p) => p.time).sort()).toEqual(['22:00', '23:00']);
    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0].reasons.map((x) => x.code)).toContain('CAPACITY');
    // 23:30 + 60 min termina después de las 24:00: fuera del horario.
    const late = autoSchedule([fx(1, 'A', 'B')], ctx({ rules: { startTime: '22:00', endTime: '24:00' } }), opts({ firstKickoff: '23:30', lastKickoff: '23:30', to: SAT }));
    expect(late.unplaced[0].reasons.map((x) => x.code)).toEqual(['OUTSIDE_HOURS']);
  });

  it('un equipo que no juega sábados va al domingo; el resto sigue el sábado', () => {
    const r = autoSchedule([fx(1, 'A', 'B'), fx(1, 'C', 'D')], ctx({ rules: { days: [0, 6] }, teams: { A: { unavailableDays: [6] } } }), opts());
    expect(at(r, '1|A|B')!.date).toBe(SUN);
    expect(at(r, '1|C|D')!.date).toBe(SAT);
  });

  it('descanso mínimo: con jornadas diarias, el equipo con 48 h de descanso juega en días alternos', () => {
    const fixtures = [fx(1, 'A', 'B'), fx(2, 'A', 'C'), fx(3, 'A', 'D')];
    const r = autoSchedule(fixtures, ctx({ teams: { A: { minRestHours: 48 } } }), opts({ daysBetweenRounds: 1 }));
    expect(r.placements.map((p) => p.date)).toEqual(['2027-01-09', '2027-01-11', '2027-01-13']);
    expect(r.metrics.lateRounds).toBe(2);
    expect(r.metrics.shortestRestHours).toBeGreaterThanOrEqual(48);
  });

  it('máximo diario del torneo: dos partidos por día como máximo', () => {
    const r = autoSchedule(league(['A', 'B', 'C', 'D', 'E', 'F']).filter((f) => f.round === 1), ctx({ rules: { maxMatchesPerDay: 2 } }), opts({ parallel: 3 }));
    const perDay = Object.values(r.placements.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.date]: (acc[p.date] ?? 0) + 1 }), {}));
    expect(Math.max(...perDay)).toBe(2);
    expect(r.unplaced).toEqual([]);
  });

  it('máximo diario del equipo y simultáneos', () => {
    const r = autoSchedule([fx(1, 'A', 'B'), fx(1, 'C', 'D')], ctx({ rules: { maxSimultaneous: 1 } }), opts({ parallel: 5 }));
    expect(new Set(r.placements.map((p) => p.time)).size).toBe(2);
  });

  it('partidos ya programados del torneo cuentan (no se ponen encima)', () => {
    const existing: Booked = { id: 'm1', tournamentId: T, homeTeamId: 'C', awayTeamId: 'D', date: SAT, time: '18:00', fieldId: null, duration: 60 };
    const r = autoSchedule([fx(5, 'A', 'B')], ctx({ matches: [existing] }), opts());
    expect(at(r, '5|A|B')).toMatchObject({ date: SAT, time: '19:30' });
  });
});

describe('6B — preferencias', () => {
  it('evita el rango preferido si puede (sin avisos)', () => {
    const r = autoSchedule([fx(1, 'A', 'B')], ctx({ teams: { A: { unavailableTimes: [{ day: null, from: '18:00', to: '19:00' }], strict: false } } }), opts());
    expect(at(r, '1|A|B')).toMatchObject({ date: SAT, time: '19:30', warnings: [] });
  });

  it('si no hay otra opción, la incumple y lo dice', () => {
    const r = autoSchedule([fx(1, 'A', 'B')], ctx({ teams: { A: { unavailableDays: [6], strict: false } } }), opts({ days: [6], to: SAT }));
    const p = at(r, '1|A|B')!;
    expect(p.warnings.map((w) => w.code)).toEqual(['TEAM_DAY']);
    expect(r.metrics.withWarnings).toBe(1);
  });

  it('días del torneo como preferencia (softRules): se usa otro día solo si hace falta', () => {
    const c = ctx({ rules: { days: [6], softRules: ['DAYS'], maxMatchesPerDay: 1 } });
    const r = autoSchedule([fx(1, 'A', 'B'), fx(1, 'C', 'D')], c, opts({ daysBetweenRounds: 2 }));
    expect(r.placements.map((p) => [p.date, p.warnings.map((w) => w.code)])).toEqual([
      [SAT, []],
      [SUN, ['DAY_NOT_ALLOWED']],
    ]);
  });

  it('la separación en cancha nunca es preferencia', () => {
    const c = ctx({ rules: { fieldGapMinutes: 30, softRules: ['DAYS', 'HOURS', 'DAILY_LIMIT'] } });
    const field = { id: 'F1', label: 'Sede · 1', buffer: 0 };
    const r = autoSchedule([fx(1, 'A', 'B'), fx(1, 'C', 'D')], c, opts({ fields: [field], step: 60, lastKickoff: '19:00', to: SAT }));
    expect(r.placements).toHaveLength(1);
    expect(r.unplaced[0].reasons.map((x) => x.code)).toContain('FIELD_GAP');
  });
});

describe('6B — canchas', () => {
  const F1 = { id: 'F1', label: 'Unidad · 1', buffer: 15 };
  const F2 = { id: 'F2', label: 'Unidad · 2', buffer: 15 };

  it('varias canchas: cuatro partidos en dos horarios', () => {
    const r = autoSchedule(league(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']).filter((f) => f.round === 1), ctx(), opts({ fields: [F1, F2], lastKickoff: '19:30', to: SAT }));
    expect(r.unplaced).toEqual([]);
    expect(r.placements.map((p) => `${p.time} ${p.fieldId}`).sort()).toEqual(['18:00 F1', '18:00 F2', '19:30 F1', '19:30 F2']);
  });

  it('respeta lo que otro torneo ya tiene en la cancha (con el margen de la sede)', () => {
    const other: Booked = { id: 'x', tournamentId: 'T2', homeTeamId: 'Y', awayTeamId: 'Z', date: SAT, time: '17:30', fieldId: 'F1', duration: 60 };
    const r = autoSchedule([fx(1, 'A', 'B')], ctx(), opts({ fields: [F1, F2], fieldBookings: [other] }));
    expect(at(r, '1|A|B')).toMatchObject({ date: SAT, time: '18:00', fieldId: 'F2' });
  });

  it('un equipo no juega dos partidos a la vez aunque haya canchas libres', () => {
    const existing: Booked = { id: 'm1', tournamentId: T, homeTeamId: 'A', awayTeamId: 'C', date: SAT, time: '18:00', fieldId: 'F1', duration: 60 };
    const r = autoSchedule([fx(2, 'A', 'B')], ctx({ matches: [existing] }), opts({ fields: [F1, F2], fieldBookings: [existing], to: SAT }));
    expect(at(r, '2|A|B')).toMatchObject({ date: SAT, time: '19:30' });
    // Con más días, el equilibrio prefiere no repetir al equipo el mismo día.
    const spread = autoSchedule([fx(2, 'A', 'B')], ctx({ matches: [existing] }), opts({ fields: [F1, F2], fieldBookings: [existing] }));
    expect(at(spread, '2|A|B')!.date).toBe(SUN);
  });
});

describe('6B — orden de búsqueda y casos sin solución', () => {
  it('encuentra la solución que un voraz en orden fallaría: primero el partido más restringido', () => {
    // Una sola hora a la vez. A–B puede a las 18:00 o 19:30; C–D solo a las 18:00 (D no puede después de las 19:00).
    const c = ctx({ teams: { D: { unavailableTimes: [{ day: null, from: '19:00', to: '24:00' }] } } });
    const r = autoSchedule([fx(1, 'A', 'B'), fx(1, 'C', 'D')], c, opts({ lastKickoff: '19:30', to: SAT, daysBetweenRounds: 1 }));
    expect(r.unplaced).toEqual([]);
    expect(at(r, '1|C|D')!.time).toBe('18:00');
    expect(at(r, '1|A|B')!.time).toBe('19:30');
  });

  it('sin solución: no inventa horario y explica qué lo impide', () => {
    const blocked = ['2027-01-09', '2027-01-10', '2027-01-11', '2027-01-12', '2027-01-13', '2027-01-14', '2027-01-15'];
    const r = autoSchedule([fx(1, 'A', 'B'), fx(1, 'C', 'D')], ctx({ teams: { A: { unavailableDates: blocked } } }), opts({ to: '2027-01-15' }));
    expect(r.placements.map((p) => p.key)).toEqual(['1|C|D']);
    expect(r.unplaced).toEqual([expect.objectContaining({ key: '1|A|B', reasons: [expect.objectContaining({ code: 'TEAM_DATE', teamId: 'A' })] })]);
  });

  it('periodo agotado: las jornadas que no caben quedan sin horario (NO_SLOTS)', () => {
    const r = autoSchedule(league(['A', 'B', 'C', 'D']), ctx(), opts({ to: '2027-01-16' }));
    expect(r.placements.map((p) => p.round)).toEqual([1, 1, 2, 2]);
    expect(r.unplaced.map((u) => [u.round, u.reasons[0].code])).toEqual([
      [3, 'NO_SLOTS'],
      [3, 'NO_SLOTS'],
    ]);
  });

  it('límite de búsqueda: corta y lo informa (SEARCH_LIMIT)', () => {
    const r = autoSchedule(league(['A', 'B', 'C', 'D', 'E', 'F']), ctx(), opts({ maxEvaluations: 40 }));
    expect(r.metrics.truncated).toBe(true);
    expect(r.unplaced.length).toBeGreaterThan(0);
    expect(r.unplaced.every((u) => u.reasons.some((x) => x.code === 'SEARCH_LIMIT'))).toBe(true);
  });
});

describe('6B — equilibrio', () => {
  it('reparte el descanso: con dos días en la ventana prefiere no repetir equipo el mismo día', () => {
    // Jornadas cada 2 días (sábado y domingo en la misma ventana no aplica): ventana de 7 días, 2 jornadas.
    const fixtures = [fx(1, 'A', 'B'), fx(2, 'A', 'C')];
    const r = autoSchedule(fixtures, ctx(), opts({ daysBetweenRounds: 7 }));
    expect(r.placements.map((p) => p.date)).toEqual([SAT, '2027-01-16']);
    expect(r.metrics.longestGapDays).toBeGreaterThan(6);
  });

  it('prefiere la hora preferida (eliminatoria: el horario previsto)', () => {
    const r = autoSchedule([fx(1, 'A', 'B')], ctx(), opts({ firstKickoff: '08:00', lastKickoff: '22:00', step: 30, preferredTime: '17:00' }));
    expect(at(r, '1|A|B')!.time).toBe('17:00');
  });

  it('timesOf: inicios cada step minutos entre el primero y el último', () => {
    expect(timesOf({ firstKickoff: '18:00', lastKickoff: '21:00', step: 90 })).toEqual(['18:00', '19:30', '21:00']);
  });
});

describe('6B — confirmación', () => {
  const planned = [
    { round: 1, homeTeamId: 'A', awayTeamId: 'B', date: SAT, time: '18:00' },
    { round: 1, homeTeamId: 'C', awayTeamId: 'D', date: SAT, time: '19:30' },
  ];
  const a = (round: number, home: string, away: string, date = SUN, time = '10:00') => ({ round, homeTeamId: home, awayTeamId: away, date, time, fieldId: null });

  it('aplica los horarios a los mismos partidos', () => {
    expect(applyAssignments(planned, [a(1, 'A', 'B'), a(1, 'C', 'D', SUN, '11:30')])).toEqual([
      { ...planned[0], date: SUN, time: '10:00', fieldId: null, pending: false },
      { ...planned[1], date: SUN, time: '11:30', fieldId: null, pending: false },
    ]);
  });

  it('6C: si falta un partido sin confirmarlo, 409 PENDING_NOT_CONFIRMED', () => {
    expect(() => applyAssignments(planned, [a(1, 'A', 'B')])).toThrow(/sin horario/);
  });

  it.each([
    ['sobra un partido', [a(1, 'A', 'B'), a(1, 'C', 'D'), a(2, 'A', 'C')]],
    ['repetido', [a(1, 'A', 'B'), a(1, 'A', 'B')]],
    ['local y visitante cambiados', [a(1, 'B', 'A'), a(1, 'C', 'D')]],
  ])('409 PROPOSAL_STALE: %s', (_, assignments) => {
    try {
      applyAssignments(planned, assignments);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e as ConflictException).getResponse()).toMatchObject({ error: 'PROPOSAL_STALE' });
    }
  });

  it('la fecha de cada jornada es la de su primer partido', () => {
    expect(roundsWithDates([{ number: 1, name: null, date: SAT }, { number: 2, name: null, date: '2027-01-16' }], [{ round: 1, date: SUN }, { round: 1, date: SAT }])).toEqual([
      { number: 1, name: null, date: SAT },
      { number: 2, name: null, date: '2027-01-16' },
    ]);
  });
});

describe('6C — reprogramación parcial', () => {
  const F1 = { id: 'F1', label: 'Unidad · 1', buffer: 15 };
  const F2 = { id: 'F2', label: 'Unidad · 2', buffer: 15 };
  const NEXT_SAT = '2027-01-16';
  const ropts = (over: Partial<RescheduleOptions> = {}): RescheduleOptions => ({
    from: SAT,
    to: '2027-01-31',
    days: [0, 6],
    firstKickoff: '18:00',
    lastKickoff: '21:00',
    step: 90,
    fields: [F1, F2],
    parallel: Infinity,
    fieldBookings: [],
    keepValid: true,
    avoidDates: [],
    avoidFieldIds: [],
    restDays: 6,
    ...over,
  });
  const item = (key: string, home: string, away: string, origin: RescheduleItem['origin'], extra: Partial<RescheduleItem> = {}): RescheduleItem => ({ key, matchId: key, round: 1, homeTeamId: home, awayTeamId: away, origin, ...extra });
  const placed = (r: ReturnType<typeof rescheduleSearch>, key: string) => r.placements.find((p) => p.key === key);

  it('conserva todo lo que sigue siendo válido (cero cambios)', () => {
    const items = [item('m1', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' }), item('m2', 'C', 'D', { date: SAT, time: '18:00', fieldId: 'F2' })];
    const r = rescheduleSearch(items, ctx(), ropts());
    expect(r.metrics).toMatchObject({ kept: 2, moved: 0, unplaced: 0 });
    expect(r.placements.every((p) => !p.changed)).toBe(true);
  });

  it('cancha cerrada: cambia solo la cancha (mismo día y hora) antes que la fecha', () => {
    const items = [item('m1', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' })];
    const r = rescheduleSearch(items, ctx(), ropts({ avoidFieldIds: ['F1'] }));
    expect(placed(r, 'm1')).toMatchObject({ date: SAT, time: '18:00', fieldId: 'F2', changed: true });
    expect(r.metrics).toMatchObject({ moved: 1, dateChanges: 0, fieldChanges: 1, timeChanges: 0 });
  });

  it('día cerrado: prefiere el día más cercano permitido y conserva la cancha y la hora', () => {
    const items = [item('m1', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' })];
    const r = rescheduleSearch(items, ctx(), ropts({ avoidDates: [SAT] }));
    expect(placed(r, 'm1')).toMatchObject({ date: SUN, time: '18:00', fieldId: 'F1' });
  });

  it('mínimo de cambios: de dos elegidos, solo se mueve el que ya no es válido', () => {
    // A no puede jugar sábados (regla nueva): su partido se mueve; el de C–D se queda.
    const items = [item('m1', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' }), item('m2', 'C', 'D', { date: SAT, time: '19:30', fieldId: 'F1' })];
    const r = rescheduleSearch(items, ctx({ teams: { A: { unavailableDays: [6] } } }), ropts());
    expect(placed(r, 'm2')!.changed).toBe(false);
    expect(placed(r, 'm1')).toMatchObject({ date: SUN, changed: true });
    expect(r.metrics).toMatchObject({ kept: 1, moved: 1 });
  });

  it('los partidos no elegidos son contexto fijo: no se tocan y se respetan', () => {
    const fixed: Booked = { id: 'x', tournamentId: T, homeTeamId: 'E', awayTeamId: 'F', date: SUN, time: '18:00', fieldId: 'F1', duration: 60 };
    const items = [item('m1', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' })];
    const r = rescheduleSearch(items, ctx({ matches: [fixed] }), ropts({ avoidDates: [SAT], avoidFieldIds: ['F2'], fieldBookings: [fixed] }));
    expect(placed(r, 'm1')).toMatchObject({ date: SUN, fieldId: 'F1' });
    expect(placed(r, 'm1')!.time).not.toBe('18:00');
    expect(r.placements.map((p) => p.key)).toEqual(['m1']);
  });

  it('keepValid=false obliga a moverlo', () => {
    const r = rescheduleSearch([item('m1', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' })], ctx(), ropts({ keepValid: false, fields: [F1] }));
    // El cambio más pequeño: misma fecha y cancha, siguiente horario.
    expect(placed(r, 'm1')).toMatchObject({ date: SAT, fieldId: 'F1', time: '19:30', changed: true });
  });

  it('por programar (sin horario previo): recibe el primer horario razonable', () => {
    const r = rescheduleSearch([item('p1', 'A', 'B', null)], ctx(), ropts());
    expect(placed(r, 'p1')).toMatchObject({ date: SAT, time: '18:00', changed: true });
    expect(r.metrics.dateChanges).toBe(1);
  });

  it('eliminatoria: respeta los partidos que lo alimentan y los que dependen de él', () => {
    const notBefore = minutesOfLocal(NEXT_SAT, '19:00');
    const r = rescheduleSearch([item('f', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' }, { notBefore, notAfter: minutesOfLocal('2027-01-17', '23:00') })], ctx(), ropts());
    const p = placed(r, 'f')!;
    expect(`${p.date} ${p.time}` >= `${NEXT_SAT} 19:00`).toBe(true);
    expect(p.date <= '2027-01-17').toBe(true);
    const impossible = rescheduleSearch([item('f', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' }, { notBefore, notAfter: notBefore + 30 })], ctx(), ropts());
    expect(impossible.unplaced[0].reasons[0].code).toBe('BRACKET_ORDER');
  });

  it('sin horario posible: no inventa nada y explica el motivo', () => {
    const blocked = Array.from({ length: 23 }, (_, i) => `2027-01-${String(9 + i).padStart(2, '0')}`);
    const r = rescheduleSearch([item('m1', 'A', 'B', { date: SAT, time: '18:00', fieldId: 'F1' })], ctx({ teams: { A: { unavailableDates: blocked } } }), ropts());
    expect(r.placements).toEqual([]);
    expect(r.unplaced[0]).toMatchObject({ matchId: 'm1', reasons: [expect.objectContaining({ code: 'TEAM_DATE', teamId: 'A' })] });
  });

  it('regresión: calendario anual con una cancha cerrada no agota la búsqueda (todo se mueve de cancha, misma fecha)', () => {
    const teams = Array.from({ length: 20 }, (_, i) => `T${i}`);
    const fixtures = generateRoundRobin(teams, 2).flatMap((r, i) => r.pairs.map(([h, a]) => fx(i + 1, h, a)));
    const fields = ['F0', 'F1', 'F2', 'F3'].map((id) => ({ id, label: id, buffer: 15 }));
    const base = { from: SAT, to: '2027-12-31', days: [0, 6], firstKickoff: '08:00', lastKickoff: '21:00', step: 75, fields, parallel: Infinity, fieldBookings: [] as Booked[] };
    const g = autoSchedule(fixtures, ctx({ rules: { days: [0, 6] } }), { ...base, daysBetweenRounds: 7 });
    const pick = g.placements.filter((p) => p.fieldId === 'F0');
    const fixed: Booked[] = g.placements.filter((p) => p.fieldId !== 'F0').map((p) => ({ id: p.key, tournamentId: T, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, date: p.date, time: p.time, fieldId: p.fieldId, duration: 60 }));
    const r = rescheduleSearch(
      pick.map((p) => item(p.key, p.homeTeamId, p.awayTeamId, { date: p.date, time: p.time, fieldId: p.fieldId })),
      ctx({ rules: { days: [0, 6] }, matches: fixed }),
      { ...base, fieldBookings: fixed, keepValid: true, avoidDates: [], avoidFieldIds: ['F0'], restDays: 6 },
    );
    expect(r.metrics).toMatchObject({ truncated: false, unplaced: 0, moved: pick.length, dateChanges: 0 });
  });

  it('confirmación de por programar: allowPending debe ser exactamente cuántos quedan', () => {
    const planned = [
      { round: 1, homeTeamId: 'A', awayTeamId: 'B', date: SAT, time: '18:00' },
      { round: 1, homeTeamId: 'C', awayTeamId: 'D', date: SAT, time: '19:30' },
    ];
    const one = [{ round: 1, homeTeamId: 'A', awayTeamId: 'B', date: SUN, time: '10:00', fieldId: null }];
    expect(() => applyAssignments(planned, one)).toThrow(ConflictException);
    try {
      applyAssignments(planned, one, 2);
    } catch (e) {
      expect((e as ConflictException).getResponse()).toMatchObject({ error: 'PENDING_NOT_CONFIRMED', pending: 1 });
    }
    expect(applyAssignments(planned, one, 1).map((m) => [m.date, m.pending])).toEqual([
      [SUN, false],
      [SAT, true],
    ]);
  });
});
