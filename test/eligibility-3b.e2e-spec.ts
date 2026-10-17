/**
 * Módulo 3B (2026-10-14): elegibilidad de jugadores para participar en partidos.
 * Lo que 3A y 2D ya garantizan está en memberships-3a, match-2d y discipline; aquí, la regla
 * que faltaba: una participación YA REGISTRADA en el partido no se revalida al corregirlo
 * (ficha o captura). Solo se valida a quien empieza a participar. Así, un cambio posterior
 * (una sanción derivada después, una corrección autorizada) no bloquea corregir la historia.
 */
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U;
const as = (u: U) => authed(http, u.token);
let seq = 0;

async function tournament(teamNames: string[]) {
  seq++;
  const t = (await as(O).post('/api/tournaments').send({ name: `Eleg ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (const name of teamNames) {
    const id = (await as(O).post('/api/teams').send({ name: `${name} E${seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
async function player(t: string, team: string, name: string, jerseyNumber: number) {
  const id = (await as(O).post('/api/players').send({ firstName: name, lastName: `E${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
  await as(O).put(`/api/tournaments/${t}/players/${id}`).send({ teamId: team, jerseyNumber, startDate: '2027-01-01' }).expect(200);
  return id;
}
const match = async (t: string, round: number, home: string, away: string, date: string) =>
  (await as(O).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date, time: '18:00' }).expect(201)).body.id as string;
const row = (playerId: string, teamId: string, extra: Record<string, unknown> = {}) => ({ playerId, teamId, goals: 0, assists: 0, yellowCards: 0, redCards: 0, sendOff: null, ...extra });
const result = (m: string, playerStats: unknown[], extra: Record<string, unknown> = {}) =>
  as(O).put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 0, status: 'FINISHED', playerStats, ...extra });
const saveTeam = (m: string, team: string, body: Record<string, unknown>) => as(O).put(`/api/matches/${m}/sheet/teams/${team}`).send(body);
const starters = (...ids: string[]) => ({ players: ids.map((playerId) => ({ playerId, starter: true })), substitutions: [] });

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  O = await registerOrganizer(http, 'DueñoEleg');
});
afterAll(async () => ctx?.close());

describe('participación ya registrada vs. nueva participación', () => {
  it('suspensión derivada después (BLOCK): corregir la ficha del partido ya jugado no se bloquea; alinear a un suspendido nuevo, sí', async () => {
    const { t, teams: [home, away] } = await tournament(['Halcones', 'Tigres']);
    const [x, y, z] = [await player(t, home, 'Xavi', 1), await player(t, home, 'Yago', 2), await player(t, home, 'Zeta', 3)];
    const v = await player(t, away, 'Visita', 10);
    const [m1, m2, m3] = [await match(t, 1, home, away, '2027-01-07'), await match(t, 2, home, away, '2027-01-14'), await match(t, 3, home, away, '2027-01-21')];
    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ enabled: true, eligibility: 'BLOCK', justification: 'Reglamento' }).expect(200);

    // La jornada 2 se captura primero (Xavi jugó). Después, la 1: Xavi expulsado → suspendido para la 2.
    await saveTeam(m2, home, starters(x, y)).expect(200);
    await result(m2, [row(x, home), row(y, home), row(v, away)]).expect(200);
    await result(m1, [row(x, home, { redCards: 1, sendOff: 'DIRECT' }), row(v, away)]).expect(200);

    // Corregir la jornada 2 (captura y ficha) con Xavi, que ya figuraba: se permite y no se recalcula nada.
    await result(m2, [row(x, home), row(y, home), row(v, away)]).expect(200);
    await saveTeam(m2, home, { ...starters(x, y), reason: 'Dorsales de la cédula' }).expect(200);
    // Agregar a un suspendido que no figuraba sigue bloqueado (aquí, Xavi en la jornada 3).
    expect((await saveTeam(m3, home, starters(x, z)).expect(409)).body.message).toMatch(/suspendidos para este partido: Xavi/);
  });

  it('alineación guardada antes de la sanción (BLOCK, partido sin jugar): se revalida; la salida es corregir la alineación', async () => {
    const { t, teams: [home, away] } = await tournament(['Halcones', 'Tigres']);
    const [x, y] = [await player(t, home, 'Xavi', 1), await player(t, home, 'Yago', 2)];
    const v = await player(t, away, 'Visita', 10);
    const [m1, m2] = [await match(t, 1, home, away, '2027-01-07'), await match(t, 2, home, away, '2027-01-14')];
    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ enabled: true, eligibility: 'BLOCK', justification: 'Reglamento' }).expect(200);

    await saveTeam(m2, home, starters(x, y)).expect(200);
    await result(m1, [row(x, home, { redCards: 1, sendOff: 'DIRECT' }), row(v, away)]).expect(200);
    expect((await result(m2, [row(x, home), row(y, home), row(v, away)]).expect(409)).body.message).toMatch(/suspendidos para este partido: Xavi/);
    expect((await saveTeam(m2, home, starters(x, y)).expect(409)).body.message).toMatch(/suspendidos para este partido: Xavi/);
    expect((await result(m2, [row(y, home), row(v, away)]).expect(409)).body.error).toBe('LINEUP_MISMATCH');
    await saveTeam(m2, home, { players: [{ playerId: y, starter: true }, { playerId: x, starter: false }], substitutions: [] }).expect(200);
    await result(m2, [row(y, home), row(v, away)]).expect(200);
  });

  it('misma fecha deportiva corregida con motivo: volver a guardar cualquiera de los dos partidos no exige otra corrección; un jugador nuevo en conflicto, sí', async () => {
    const { t, teams: [a, b, c, d] } = await tournament(['Águilas', 'Búhos', 'Cóndores', 'Delfines']);
    const x = await player(t, a, 'Xavi', 1);
    const w = await player(t, a, 'Walter', 2);
    const [vc, vd] = [await player(t, c, 'VisitaC', 10), await player(t, d, 'VisitaD', 10)];
    const m1 = await match(t, 1, a, c, '2027-02-07');
    const m2 = await match(t, 2, b, d, '2027-02-07');

    await result(m1, [row(x, a), row(w, a), row(vc, c)]).expect(200);
    await as(O).put(`/api/tournaments/${t}/players/${x}`).send({ teamId: b, fromTeamId: a, transferReason: 'Cambio de prueba', startDate: '2027-02-07' }).expect(200);
    expect((await result(m2, [row(x, b), row(vd, d)]).expect(409)).body.error).toBe('SAME_DATE_OTHER_TEAM');
    await result(m2, [row(x, b), row(vd, d)], { sameDateReason: 'Autorizado por la junta' }).expect(200);

    // Correcciones de los dos partidos con la participación ya autorizada: sin repetir la corrección.
    await result(m2, [row(x, b), row(vd, d)]).expect(200);
    await result(m1, [row(x, a), row(w, a), row(vc, c)]).expect(200);
    await saveTeam(m2, b, starters(x)).expect(200);
    // Walter (que jugó con Águilas) se mueve a Búhos: entrar NUEVO en el otro partido del día sigue bloqueado.
    await as(O).put(`/api/tournaments/${t}/players/${w}`).send({ teamId: b, fromTeamId: a, transferReason: 'Cambio de prueba', startDate: '2027-02-07' }).expect(200);
    expect((await saveTeam(m2, b, { ...starters(x, w), reason: 'Faltaba Walter' }).expect(409)).body.conflicts).toEqual([{ playerId: w, teamId: a, matchId: m1 }]);
  });
});

const patch = (m: string, body: Record<string, unknown>) => as(O).patch(`/api/matches/${m}`).send({ reason: 'Ajuste de calendario', ...body });
const dateOf = async (m: string) => (await as(O).get(`/api/matches/${m}`).expect(200)).body as { date: string; round: number; time: string };
const playedIn = async (m: string) => ((await as(O).get(`/api/matches/${m}/sheet`).expect(200)).body.teams as { stats: { playerId: string; played: boolean }[] }[]).flatMap((t) => t.stats.filter((s) => s.played).map((s) => s.playerId)).sort();

describe('decisión 1: fecha deportiva = mismo día o misma jornada, también reprogramado', () => {
  it('jugó la jornada 1 con un equipo: no juega con otro el partido de la jornada 1 reprogramado a otro día; con corrección auditada sí', async () => {
    const { t, teams: [a, b, c, d] } = await tournament(['Águilas', 'Búhos', 'Cóndores', 'Delfines']);
    const x = await player(t, a, 'Xavi', 1);
    const [vc, vd] = [await player(t, c, 'VisitaC', 10), await player(t, d, 'VisitaD', 10)];
    const m1 = await match(t, 1, a, c, '2027-03-07');
    const m2 = await match(t, 1, b, d, '2027-03-07');
    await patch(m2, { status: 'POSTPONED' }).expect(200);
    await result(m1, [row(x, a), row(vc, c)]).expect(200);
    await as(O).put(`/api/tournaments/${t}/players/${x}`).send({ teamId: b, fromTeamId: a, transferReason: 'Cambio de prueba', startDate: '2027-03-10' }).expect(200);
    await patch(m2, { status: 'SCHEDULED', date: '2027-03-21' }).expect(200);
    expect((await result(m2, [row(x, b), row(vd, d)]).expect(409)).body).toMatchObject({ error: 'SAME_DATE_OTHER_TEAM', conflicts: [{ playerId: x, teamId: a, matchId: m1 }] });
    expect((await saveTeam(m2, b, starters(x)).expect(409)).body.error).toBe('SAME_DATE_OTHER_TEAM');
    await result(m2, [row(x, b), row(vd, d)], { sameDateReason: 'Reglamento: el reprogramado admite refuerzos' }).expect(200);
    const log = (await as(O).get(`/api/matches/${m2}/log`).expect(200)).body.entries as { action: string; reason: string }[];
    expect(log.find((e) => e.action === 'ELIGIBILITY_OVERRIDE')?.reason).toBe('Reglamento: el reprogramado admite refuerzos');
  });
});

describe('decisión 2: WARN y BLOCK se aplican igual en ficha y captura', () => {
  it('WARN: ficha avisa y captura registra la incidencia una vez; BLOCK: las dos rechazan', async () => {
    const { t, teams: [home, away] } = await tournament(['Halcones', 'Tigres']);
    const [x, y] = [await player(t, home, 'Xavi', 1), await player(t, home, 'Yago', 2)];
    const v = await player(t, away, 'Visita', 10);
    const [m1, m2, m3] = [await match(t, 1, home, away, '2027-01-07'), await match(t, 2, home, away, '2027-01-14'), await match(t, 3, home, away, '2027-01-21')];
    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ enabled: true, directRedMatches: 2 }).expect(200);
    await result(m1, [row(x, home, { redCards: 1, sendOff: 'DIRECT' }), row(v, away)]).expect(200);

    expect((await saveTeam(m2, home, starters(x, y)).expect(200)).body.warnings[0]).toMatch(/suspendidos: Xavi/);
    await result(m2, [row(x, home), row(y, home), row(v, away)]).expect(200);
    await result(m2, [row(x, home), row(y, home), row(v, away)]).expect(200);
    const log = (await as(O).get(`/api/tournaments/${t}/discipline/history`).expect(200)).body as { action: string; matchId: string | null }[];
    expect(log.filter((e) => e.action === 'PLAYED_WHILE_SUSPENDED').map((e) => e.matchId)).toEqual([m2]);

    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ eligibility: 'BLOCK', justification: 'Reglamento' }).expect(200);
    expect((await saveTeam(m3, home, starters(x, y)).expect(409)).body.message).toMatch(/suspendidos para este partido: Xavi/);
    expect((await result(m3, [row(x, home), row(y, home), row(v, away)]).expect(409)).body.message).toMatch(/suspendidos para este partido: Xavi/);
  });
});

describe('decisión 3: cambiar fecha o jornada de un partido con participaciones', () => {
  it('nueva fecha antes de la inscripción efectiva → 409 con los afectados; nada se altera; una fecha válida pasa', async () => {
    const { t, teams: [home, away] } = await tournament(['Halcones', 'Tigres']);
    const x = await player(t, home, 'Xavi', 1);
    const late = (await as(O).post('/api/players').send({ firstName: 'Tardío', lastName: `E${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
    await as(O).put(`/api/tournaments/${t}/players/${late}`).send({ teamId: home, jerseyNumber: 2, startDate: '2027-01-10' }).expect(200);
    const v = await player(t, away, 'Visita', 10);
    const m = await match(t, 1, home, away, '2027-01-14');
    await saveTeam(m, home, starters(x, late)).expect(200);
    await result(m, [row(x, home), row(late, home), row(v, away)]).expect(200);

    const res = (await patch(m, { date: '2027-01-08' }).expect(409)).body;
    expect(res).toMatchObject({ error: 'RESCHEDULE_AFFECTS_ELIGIBILITY', players: [{ playerId: late, teamId: home, cause: 'NOT_REGISTERED_ON_DATE', name: `Tardío E${seq}` }] });
    expect(res.message).toMatch(/Tardío E\d+ \(no está inscrito con su equipo en la nueva fecha\)/);
    expect((await dateOf(m)).date).toBe('2027-01-14');
    expect(await playedIn(m)).toEqual([x, late, v].sort());
    await patch(m, { date: '2027-01-12' }).expect(200);
    expect((await dateOf(m)).date).toBe('2027-01-12');
  });

  it('cambio de jornada o de día que crea doble participación → 409; la ya autorizada no bloquea otros ajustes', async () => {
    const { t, teams: [a, b, c, d] } = await tournament(['Águilas', 'Búhos', 'Cóndores', 'Delfines']);
    const x = await player(t, a, 'Xavi', 1);
    const [vc, vd] = [await player(t, c, 'VisitaC', 10), await player(t, d, 'VisitaD', 10)];
    const m1 = await match(t, 1, a, c, '2027-02-07');
    const m2 = await match(t, 2, b, d, '2027-02-14');
    await result(m1, [row(x, a), row(vc, c)]).expect(200);
    await as(O).put(`/api/tournaments/${t}/players/${x}`).send({ teamId: b, fromTeamId: a, transferReason: 'Cambio de prueba', startDate: '2027-02-07' }).expect(200);
    await result(m2, [row(x, b), row(vd, d)]).expect(200);

    // Misma jornada (sin cambiar el día) y mismo día (sin cambiar la jornada): las dos lo rechazan.
    expect((await patch(m2, { round: 1 }).expect(409)).body.players).toEqual([{ playerId: x, teamId: b, cause: 'SAME_DATE_OTHER_TEAM', matchId: m1, name: `Xavi E${seq}` }]);
    expect((await patch(m2, { date: '2027-02-07' }).expect(409)).body.players).toMatchObject([{ playerId: x, cause: 'SAME_DATE_OTHER_TEAM', matchId: m1 }]);
    expect(await dateOf(m2)).toMatchObject({ date: '2027-02-14', round: 2 });
    // Sin conflicto, el cambio pasa con las reglas de siempre (motivo en torneo en curso).
    await as(O).patch(`/api/matches/${m2}`).send({ date: '2027-02-21' }).expect(400);
    await patch(m2, { date: '2027-02-21' }).expect(200);

    // Conflicto que ya existía y estaba autorizado (m3, mismo día que m1): cambiar su hora no se bloquea.
    const e = (await as(O).post('/api/teams').send({ name: `Espartanos E${seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${e}`).expect(201);
    const m3 = await match(t, 3, b, e, '2027-02-07');
    await result(m3, [row(x, b)], { sameDateReason: 'Autorizado por la junta' }).expect(200);
    await patch(m3, { time: '20:00' }).expect(200);
  });

  it('sanción: solo bloquea (BLOCK) la incidencia que el cambio crea; la que ya existía no; en WARN se registra', async () => {
    const { t, teams: [home, away] } = await tournament(['Halcones', 'Tigres']);
    const [x, y] = [await player(t, home, 'Xavi', 1), await player(t, home, 'Yago', 2)];
    const v = await player(t, away, 'Visita', 10);
    const [m1, m2, m3] = [await match(t, 1, home, away, '2027-01-07'), await match(t, 2, home, away, '2027-01-14'), await match(t, 3, home, away, '2027-01-21')];
    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ enabled: true, eligibility: 'BLOCK', justification: 'Reglamento' }).expect(200);
    await result(m1, [row(x, home), row(y, home), row(v, away)]).expect(200);
    await result(m2, [row(x, home, { redCards: 1, sendOff: 'DIRECT' }), row(y, home), row(v, away)]).expect(200);
    await result(m3, [row(y, home), row(v, away)]).expect(200);

    // Llevar la expulsión (m2) antes de m1 dejaría a Xavi jugando m1 suspendido → 409, sin cambios.
    expect((await patch(m2, { date: '2027-01-03' }).expect(409)).body).toMatchObject({ error: 'RESCHEDULE_AFFECTS_ELIGIBILITY', players: [{ playerId: x, cause: 'SUSPENDED', matchId: m1 }] });
    expect((await dateOf(m2)).date).toBe('2027-01-14');
    // La sanción ya se cumplió en m3 (sin Xavi): moverlo sin crear incidencias pasa.
    await patch(m3, { date: '2027-01-28' }).expect(200);

    // WARN: el mismo cambio se permite y deja la incidencia registrada, una vez.
    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ eligibility: 'WARN', justification: 'Reglamento' }).expect(200);
    await patch(m2, { date: '2027-01-03' }).expect(200);
    const log = (await as(O).get(`/api/tournaments/${t}/discipline/history`).expect(200)).body as { action: string; matchId: string | null; playerId: string | null }[];
    expect(log.filter((e) => e.action === 'PLAYED_WHILE_SUSPENDED').map((e) => [e.matchId, e.playerId])).toEqual([[m1, x]]);
    // Ya existente (no creada por el cambio): con BLOCK, mover otra vez m2 sin crear otras no se bloquea.
    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ eligibility: 'BLOCK', justification: 'Reglamento' }).expect(200);
    await patch(m2, { time: '20:00' }).expect(200);
  });

  it('concurrencia: capturar un partido y mover otro a su misma fecha a la vez → solo uno pasa', async () => {
    for (let run = 0; run < 3; run++) {
      const { t, teams: [a, b, c, d] } = await tournament(['Águilas', 'Búhos', 'Cóndores', 'Delfines']);
      const x = await player(t, a, 'Xavi', 1);
      const [vc, vd] = [await player(t, c, 'VisitaC', 10), await player(t, d, 'VisitaD', 10)];
      const m1 = await match(t, 1, a, c, '2027-02-07');
      const m2 = await match(t, 2, b, d, '2027-02-14');
      await as(O).put(`/api/tournaments/${t}/players/${x}`).send({ teamId: b, fromTeamId: a, transferReason: 'Cambio de prueba', startDate: '2027-02-07' }).expect(200);
      await result(m2, [row(x, b), row(vd, d)]).expect(200);
      // Por separado, los dos son válidos: m1 no tiene participaciones y m2 está en otra fecha.
      const [capture, move] = await Promise.all([result(m1, [row(x, a), row(vc, c)]), patch(m2, { date: '2027-02-07' })]);
      expect([capture.status, move.status].sort()).toEqual([200, 409]);
    }
  });
});
