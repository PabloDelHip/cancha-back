/**
 * Torneo Real V1: ciclo de vida, inmutabilidad del torneo finalizado, jornadas, calendario,
 * partidos pospuestos, puntuación configurable y aislamiento entre organizadores.
 * Todas las reglas se comprueban directamente contra la API (sin frontend).
 */
import request from 'supertest';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);

type Org = Awaited<ReturnType<typeof registerOrganizer>>;
let A: Org;
let B: Org;
const as = (org: Org) => authed(http, org.token);

// ─── Helpers ────────────────────────────────────────────────────────────────

let seq = 0;
async function tournament(org: Org, extra: Record<string, unknown> = {}) {
  seq++;
  const res = await as(org)
    .post('/api/tournaments')
    .send({ name: `Liga ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', ...extra })
    .expect(201);
  return res.body.id as string;
}
async function team(org: Org, tournamentId?: string) {
  seq++;
  const id = (await as(org).post('/api/teams').send({ name: `Equipo ${seq}` }).expect(201)).body.id as string;
  if (tournamentId) await as(org).post(`/api/tournaments/${tournamentId}/teams/${id}`).expect(201);
  return id;
}
async function teams(org: Org, tournamentId: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await team(org, tournamentId));
  return ids;
}
async function player(org: Org, tournamentId: string, teamId: string, jerseyNumber: number) {
  seq++;
  const id = (
    await as(org).post('/api/players').send({ confirmNew: true, firstName: 'Jugador', lastName: `N${seq}`, position: 'FORWARD' }).expect(201)
  ).body.id as string;
  await as(org)
    .put(`/api/tournaments/${tournamentId}/players/${id}`)
    .send({ teamId, jerseyNumber, startDate: '2027-01-01' })
    .expect(200);
  return id;
}
const newMatch = (org: Org, tournamentId: string, round: number, home: string, away: string, extra = {}) =>
  as(org)
    .post('/api/matches')
    .send({ tournamentId, round, homeTeamId: home, awayTeamId: away, date: '2027-02-06', time: '18:00', ...extra });
async function match(org: Org, tournamentId: string, round: number, home: string, away: string) {
  return (await newMatch(org, tournamentId, round, home, away).expect(201)).body.id as string;
}
const result = (org: Org, matchId: string, homeScore: number, awayScore: number, playerStats: unknown[] = []) =>
  as(org).put(`/api/matches/${matchId}/result`).send({ homeScore, awayScore, playerStats });
const schedule = (org: Org, tournamentId: string, body: Record<string, unknown>) =>
  as(org).post(`/api/tournaments/${tournamentId}/schedule`).send({ startDate: '2027-03-06', ...body });
const standings = async (tournamentId: string) =>
  (await api().get(`/api/tournaments/${tournamentId}/standings`).expect(200)).body as {
    teamId: string;
    played: number;
    points: number;
    goalDifference: number;
    goalsFor: number;
  }[];

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Ana');
  B = await registerOrganizer(http, 'Beto');
});
afterAll(async () => ctx?.close());

// ─── Ciclo de vida ──────────────────────────────────────────────────────────

describe('Ciclo de vida DRAFT → ACTIVE → FINISHED', () => {
  it('un torneo nace en DRAFT con configuración de liga 3/1/0', async () => {
    const id = await tournament(A);
    const res = await api().get(`/api/tournaments/${id}`).expect(200);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.settings).toEqual({
      system: 'LEAGUE',
      pointsForWin: 3,
      pointsForDraw: 1,
      pointsForLoss: 0,
      pointsForShootoutWin: null, // sin penales en empates
      knockoutTiebreak: 'PENALTIES',
      finalTiebreak: null,
      reseed: false, // cuadro fijo salvo que el organizador elija reacomodo
      roundRobinLegs: 1,
      knockoutLegs: 1,
      groupCount: null,
      qualifiersPerGroup: null,
      playoffTeams: null,
    });
  });

  it('no se crea un torneo ya FINISHED ni se cambia el estado por PATCH', async () => {
    await as(A)
      .post('/api/tournaments')
      .send({ name: 'X', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'FINISHED' })
      .expect(400);
    const id = await tournament(A);
    await as(A).patch(`/api/tournaments/${id}`).send({ status: 'ACTIVE' }).expect(400);
    await as(A).patch(`/api/tournaments/${id}`).send({ status: 'FINISHED' }).expect(400);
    expect((await api().get(`/api/tournaments/${id}`)).body.status).toBe('DRAFT');
  });

  it('DRAFT → ACTIVE funciona; iniciar dos veces o finalizar un borrador se rechaza', async () => {
    const id = await tournament(A);
    await as(A).post(`/api/tournaments/${id}/finish`).send({ allowPendingMatches: true }).expect(409);
    const res = await as(A).post(`/api/tournaments/${id}/start`).expect(200);
    expect(res.body.status).toBe('ACTIVE');
    await as(A).post(`/api/tournaments/${id}/start`).expect(409);
  });

  it('ACTIVE → FINISHED exige confirmar partidos pendientes; FINISHED es terminal', async () => {
    const id = await tournament(A, { status: 'ACTIVE' });
    const [t1, t2, t3] = await teams(A, id, 3);
    const played = await match(A, id, 1, t1, t2);
    await result(A, played, 2, 1).expect(200);
    await match(A, id, 2, t2, t3);
    const postponed = await match(A, id, 3, t3, t1);
    await as(A).patch(`/api/matches/${postponed}`).send({ status: 'POSTPONED' }).expect(200);

    const refused = await as(A).post(`/api/tournaments/${id}/finish`).send({}).expect(409);
    expect(refused.body.summary).toMatchObject({ total: 3, finished: 1, scheduled: 1, postponed: 1, pending: 2 });
    expect((await api().get(`/api/tournaments/${id}`)).body.status).toBe('ACTIVE');

    const done = await as(A).post(`/api/tournaments/${id}/finish`).send({ allowPendingMatches: true }).expect(200);
    expect(done.body.tournament.status).toBe('FINISHED');
    expect(done.body.summary).toMatchObject({ total: 3, finished: 1, pending: 2 });

    // terminal: no se reabre ni se vuelve a finalizar
    await as(A).post(`/api/tournaments/${id}/start`).expect(409);
    await as(A).post(`/api/tournaments/${id}/finish`).send({ allowPendingMatches: true }).expect(409);
  });

  it('sin partidos pendientes se finaliza sin confirmación', async () => {
    const id = await tournament(A, { status: 'ACTIVE' });
    const [t1, t2] = await teams(A, id, 2);
    await result(A, await match(A, id, 1, t1, t2), 0, 0).expect(200);
    await as(A).post(`/api/tournaments/${id}/finish`).send({}).expect(200);
  });

  it('otro organizador no inicia ni finaliza torneos ajenos', async () => {
    const id = await tournament(A);
    await as(B).post(`/api/tournaments/${id}/start`).expect(403);
    await as(A).post(`/api/tournaments/${id}/start`).expect(200);
    await as(B).post(`/api/tournaments/${id}/finish`).send({ allowPendingMatches: true }).expect(403);
  });
});

// ─── Configuración y tabla ──────────────────────────────────────────────────

describe('Tournament.settings y tabla de posiciones', () => {
  it('valida la configuración', async () => {
    const id = await tournament(A);
    await as(A).patch(`/api/tournaments/${id}`).send({ settings: { pointsForWin: 1, pointsForDraw: 1 } }).expect(400);
    await as(A).patch(`/api/tournaments/${id}`).send({ settings: { pointsForDraw: 0, pointsForLoss: 1 } }).expect(400);
    await as(A).patch(`/api/tournaments/${id}`).send({ settings: { pointsForWin: 11 } }).expect(400);
    await as(A).patch(`/api/tournaments/${id}`).send({ settings: { system: 'SWISS' } }).expect(400);
    // formatos válidos con configuración imposible (ver competition-formats.e2e-spec.ts)
    await as(A).patch(`/api/tournaments/${id}`).send({ settings: { system: 'GROUPS_KNOCKOUT', groupCount: 3, qualifiersPerGroup: 1 } }).expect(400);
    await as(A).patch(`/api/tournaments/${id}`).send({ settings: { system: 'LEAGUE_PLAYOFFS', playoffTeams: 1 } }).expect(400);
    await as(B).patch(`/api/tournaments/${id}`).send({ settings: { pointsForWin: 2 } }).expect(403);
  });

  it('la tabla usa la puntuación del torneo: 3/1/0 y después 2/1/0', async () => {
    const id = await tournament(A, { status: 'ACTIVE' });
    const [x, y] = await teams(A, id, 2);
    await result(A, await match(A, id, 1, x, y), 1, 0).expect(200);
    await result(A, await match(A, id, 2, x, y), 1, 1).expect(200);
    expect((await standings(id)).map((r) => [r.teamId, r.points])).toEqual([[x, 4], [y, 1]]);

    const res = await as(A).patch(`/api/tournaments/${id}`).send({ settings: { pointsForWin: 2 } }).expect(200);
    expect(res.body.settings).toMatchObject({ pointsForWin: 2, pointsForDraw: 1, pointsForLoss: 0 });
    expect((await standings(id)).map((r) => [r.teamId, r.points])).toEqual([[x, 3], [y, 1]]);
  });

  it('desempate PTS → DG → GF', async () => {
    const id = await tournament(A, { status: 'ACTIVE' });
    const [t1, t2, t3, t4] = await teams(A, id, 4);
    await result(A, await match(A, id, 1, t1, t4), 3, 0).expect(200);
    await result(A, await match(A, id, 2, t2, t4), 4, 1).expect(200);
    await result(A, await match(A, id, 3, t3, t4), 1, 0).expect(200);
    const rows = await standings(id);
    expect(rows.map((r) => r.teamId)).toEqual([t2, t1, t3, t4]);
    expect(rows.slice(0, 3).map((r) => r.points)).toEqual([3, 3, 3]);
  });
});

// ─── Jornadas ───────────────────────────────────────────────────────────────

describe('Jornadas', () => {
  let id: string;
  let t: string[];
  beforeAll(async () => {
    id = await tournament(A, { status: 'ACTIVE' });
    t = await teams(A, id, 4);
  });

  it('crear, renombrar y listar en orden', async () => {
    await as(A).put(`/api/tournaments/${id}/rounds/2`).send({ name: 'Clásico', date: '2027-02-13' }).expect(200);
    const created = await as(A).put(`/api/tournaments/${id}/rounds/1`).send({}).expect(200);
    expect(created.body).toMatchObject({ number: 1, name: null, date: null, tournamentId: id });
    const renamed = await as(A).put(`/api/tournaments/${id}/rounds/2`).send({ name: 'Jornada 2 · Clásico' }).expect(200);
    expect(renamed.body).toMatchObject({ number: 2, name: 'Jornada 2 · Clásico', date: '2027-02-13' });
    const list = await api().get(`/api/tournaments/${id}/rounds`).expect(200);
    expect(list.body.map((r: { number: number }) => r.number)).toEqual([1, 2]);
    const paged = await api().get(`/api/rounds?tournamentId=${id}`).expect(200);
    expect(paged.body.meta.total).toBe(2);
  });

  it('número válido (1–99)', async () => {
    await as(A).put(`/api/tournaments/${id}/rounds/0`).send({}).expect(400);
    await as(A).put(`/api/tournaments/${id}/rounds/100`).send({}).expect(400);
    await as(A).put(`/api/tournaments/${id}/rounds/abc`).send({}).expect(400);
  });

  it('programar un partido crea (o reutiliza) el registro de su jornada', async () => {
    await match(A, id, 5, t[0], t[1]);
    const list = await api().get(`/api/tournaments/${id}/rounds`).expect(200);
    expect(list.body.map((r: { number: number }) => r.number)).toEqual([1, 2, 5]);
  });

  it('un equipo no juega dos partidos en la misma jornada', async () => {
    await newMatch(A, id, 5, t[0], t[2]).expect(409); // t0 ya juega en J5
    await newMatch(A, id, 5, t[3], t[1]).expect(409); // t1 ya juega en J5
    const ok = await match(A, id, 5, t[2], t[3]);
    // mover a una jornada donde uno de sus equipos ya juega → 409
    const other = await match(A, id, 6, t[3], t[2]);
    await as(A).patch(`/api/matches/${other}`).send({ round: 5 }).expect(409);
    // un partido cancelado no ocupa la jornada
    await as(A).patch(`/api/matches/${ok}`).send({ status: 'CANCELLED' }).expect(200);
    await as(A).patch(`/api/matches/${other}`).send({ round: 5 }).expect(200);
    // …y no puede "descancelarse" si ahora choca
    await as(A).patch(`/api/matches/${ok}`).send({ status: 'SCHEDULED' }).expect(409);
  });

  it('equipos inscritos y distintos', async () => {
    const outsider = await team(A);
    await newMatch(A, id, 7, t[0], outsider).expect(400);
    await newMatch(A, id, 7, t[0], t[0]).expect(400);
  });

  it('eliminar: solo jornadas vacías; nunca borra partidos', async () => {
    await as(A).delete(`/api/tournaments/${id}/rounds/5`).expect(409);
    await as(A).delete(`/api/tournaments/${id}/rounds/1`).expect(204);
    await as(A).delete(`/api/tournaments/${id}/rounds/1`).expect(404);
    const matches = await api().get(`/api/tournaments/${id}/matches`).expect(200);
    expect(matches.body.filter((m: { round: number }) => m.round === 5)).toHaveLength(3);
  });

  it('otro organizador recibe 403 aunque conozca los ObjectId', async () => {
    await as(B).put(`/api/tournaments/${id}/rounds/9`).send({ name: 'Mía' }).expect(403);
    await as(B).delete(`/api/tournaments/${id}/rounds/2`).expect(403);
    await newMatch(B, id, 8, t[0], t[1]).expect(403);
    const m = (await api().get(`/api/tournaments/${id}/matches`)).body[0];
    await as(B).patch(`/api/matches/${m.id}`).send({ round: 9 }).expect(403);
    expect((await api().get(`/api/tournaments/${id}/rounds`)).body.map((r: { number: number }) => r.number)).not.toContain(9);
  });
});

// ─── Calendario ─────────────────────────────────────────────────────────────

type ApiMatch = { id: string; round: number; homeTeamId: string; awayTeamId: string; status: string; date: string; time: string };
function assertLeague(matches: ApiMatch[], teamIds: string[], legs: 1 | 2) {
  const n = teamIds.length;
  const perLeg = n % 2 ? n : n - 1;
  const rounds = [...new Set(matches.map((m) => m.round))];
  expect(rounds.sort((a, b) => a - b)).toEqual(Array.from({ length: perLeg * legs }, (_, i) => i + 1));
  expect(matches).toHaveLength(((n * (n - 1)) / 2) * legs);
  for (const r of rounds) {
    const playing = matches.filter((m) => m.round === r).flatMap((m) => [m.homeTeamId, m.awayTeamId]);
    expect(new Set(playing).size).toBe(playing.length); // nadie juega dos veces
    expect(playing.length).toBe(n % 2 ? n - 1 : n); // con impar descansa uno
  }
  const pairs = new Map<string, string[]>();
  for (const m of matches) {
    const key = [m.homeTeamId, m.awayTeamId].sort().join('-');
    pairs.set(key, [...(pairs.get(key) ?? []), m.homeTeamId]);
  }
  expect(pairs.size).toBe((n * (n - 1)) / 2);
  for (const homes of pairs.values()) {
    expect(homes).toHaveLength(legs);
    if (legs === 2) expect(homes[0]).not.toBe(homes[1]);
  }
}

describe('Generación de calendario (POST /tournaments/:id/schedule)', () => {
  it('4 equipos, una vuelta: 3 jornadas persistentes, 6 partidos, todos contra todos', async () => {
    const id = await tournament(A);
    const t = await teams(A, id, 4);
    const res = await schedule(A, id, { legs: 1, firstKickoff: '19:00', minutesBetweenMatches: 60, daysBetweenRounds: 7 }).expect(201);
    expect(res.body.rounds.map((r: { number: number; date: string }) => [r.number, r.date])).toEqual([
      [1, '2027-03-06'],
      [2, '2027-03-13'],
      [3, '2027-03-20'],
    ]);
    assertLeague(res.body.matches, t, 1);
    expect(res.body.matches.filter((m: ApiMatch) => m.round === 1).map((m: ApiMatch) => m.time)).toEqual(['19:00', '20:00']);
    expect((await api().get(`/api/tournaments/${id}/rounds`)).body).toHaveLength(3);
  });

  it('5 equipos, ida y vuelta: 10 jornadas con un descanso cada una, cruces invertidos', async () => {
    const id = await tournament(A);
    const t = await teams(A, id, 5);
    const res = await schedule(A, id, { legs: 2 }).expect(201);
    assertLeague(res.body.matches, t, 2);
  });

  it('regenerar: exige replaceExisting y reemplaza sin duplicar', async () => {
    const id = await tournament(A);
    const t = await teams(A, id, 4);
    const first = (await schedule(A, id, { legs: 1 }).expect(201)).body.matches as ApiMatch[];
    const refused = await schedule(A, id, { legs: 2 }).expect(409);
    expect(refused.body.message).toMatch(/replaceExisting/);
    const second = await schedule(A, id, { legs: 2, replaceExisting: true }).expect(201);
    expect(second.body.replaced).toBe(6);
    const now = (await api().get(`/api/tournaments/${id}/matches`)).body as ApiMatch[];
    assertLeague(now, t, 2);
    expect(now.some((m) => first.some((f) => f.id === m.id))).toBe(false);
    expect((await api().get(`/api/tournaments/${id}/rounds`)).body).toHaveLength(6);
  });

  it('nunca regenera un calendario con partidos jugados o en juego', async () => {
    const id = await tournament(A, { status: 'ACTIVE' });
    await teams(A, id, 4);
    const matches = (await schedule(A, id, { legs: 1 }).expect(201)).body.matches as ApiMatch[];
    await as(A).patch(`/api/matches/${matches[0].id}`).send({ status: 'LIVE' }).expect(200);
    await schedule(A, id, { legs: 1, replaceExisting: true }).expect(409);
    await result(A, matches[0].id, 1, 0).expect(200);
    await schedule(A, id, { legs: 1, replaceExisting: true }).expect(409);
    expect((await api().get(`/api/tournaments/${id}/matches`)).body).toHaveLength(6);
  });

  it('es atómica: si falla a mitad, el calendario anterior queda intacto', async () => {
    const id = await tournament(A);
    await teams(A, id, 4);
    const before = ((await schedule(A, id, { legs: 1 }).expect(201)).body.matches as ApiMatch[]).map((m) => m.id).sort();
    const roundsBefore = (await api().get(`/api/tournaments/${id}/rounds`)).body;

    // Falla la inserción de partidos DESPUÉS de borrar el calendario viejo y crear las jornadas nuevas.
    const Match = ctx.app.get<Model<unknown>>(getModelToken('Match'));
    const spy = vi.spyOn(Match, 'insertMany').mockRejectedValueOnce(new Error('fallo simulado'));
    await schedule(A, id, { legs: 2, replaceExisting: true }).expect(500);
    spy.mockRestore();

    const after = ((await api().get(`/api/tournaments/${id}/matches`)).body as ApiMatch[]).map((m) => m.id).sort();
    expect(after).toEqual(before);
    expect((await api().get(`/api/tournaments/${id}/rounds`)).body).toEqual(roundsBefore);
  });

  it('valida equipos suficientes y ownership', async () => {
    const id = await tournament(A);
    await team(A, id);
    await schedule(A, id, { legs: 1 }).expect(400);
    await team(A, id);
    await schedule(B, id, { legs: 1 }).expect(403);
    await schedule(A, id, { legs: 3 }).expect(400);
  });
});

// ─── Pospuestos y cancelados ────────────────────────────────────────────────

describe('POSTPONED y CANCELLED', () => {
  let id: string;
  let t: string[];
  beforeAll(async () => {
    id = await tournament(A, { status: 'ACTIVE' });
    t = await teams(A, id, 2);
  });

  it('SCHEDULED → POSTPONED → SCHEDULED reprogramado conserva el partido y no suma en la tabla', async () => {
    const m = await match(A, id, 1, t[0], t[1]);
    const postponed = await as(A).patch(`/api/matches/${m}`).send({ status: 'POSTPONED' }).expect(200);
    expect(postponed.body).toMatchObject({ id: m, status: 'POSTPONED', round: 1 });
    expect((await standings(id)).every((r) => r.played === 0)).toBe(true);

    const back = await as(A).patch(`/api/matches/${m}`).send({ status: 'SCHEDULED', date: '2027-04-01', time: '20:30' }).expect(200);
    expect(back.body).toMatchObject({ id: m, status: 'SCHEDULED', date: '2027-04-01', time: '20:30', round: 1 });
  });

  it('un pospuesto que se jugó puede capturarse (→ FINISHED) y entonces sí cuenta', async () => {
    const m = await match(A, id, 2, t[0], t[1]);
    await as(A).patch(`/api/matches/${m}`).send({ status: 'POSTPONED' }).expect(200);
    await result(A, m, 2, 0).expect(200);
    expect((await standings(id)).find((r) => r.teamId === t[0])).toMatchObject({ played: 1, points: 3 });
  });

  it('un partido con resultado no se pospone, cancela ni vuelve a programado por PATCH', async () => {
    const m = await match(A, id, 3, t[0], t[1]);
    await result(A, m, 1, 1).expect(200);
    for (const status of ['POSTPONED', 'CANCELLED', 'SCHEDULED']) {
      await as(A).patch(`/api/matches/${m}`).send({ status }).expect(409);
    }
    expect((await api().get(`/api/matches/${m}`)).body).toMatchObject({ status: 'FINISHED', homeScore: 1 });
  });

  it('CANCELLED no se captura y no cuenta en la tabla', async () => {
    const m = await match(A, id, 4, t[0], t[1]);
    await as(A).patch(`/api/matches/${m}`).send({ status: 'CANCELLED' }).expect(200);
    await result(A, m, 3, 0).expect(409);
    const played = (await standings(id)).find((r) => r.teamId === t[0])!.played;
    expect(played).toBe(2);
  });
});

// ─── Torneo finalizado: historial inmutable (requests directos, sin UI) ──────

describe('Torneo FINISHED = historial inmutable', () => {
  const x: Record<string, string> = {};
  let before: unknown;
  const snapshot = async () => ({
    tournament: (await api().get(`/api/tournaments/${x.id}`)).body,
    teams: (await api().get(`/api/tournaments/${x.id}/teams`)).body,
    rounds: (await api().get(`/api/tournaments/${x.id}/rounds`)).body,
    matches: (await api().get(`/api/tournaments/${x.id}/matches`)).body,
    stats: (await api().get(`/api/player-match-stats?tournamentId=${x.id}`)).body,
    roster: (await api().get(`/api/tournaments/${x.id}/players`)).body,
    standings: (await api().get(`/api/tournaments/${x.id}/standings`)).body,
    scorers: (await api().get(`/api/tournaments/${x.id}/top-scorers`)).body,
  });

  beforeAll(async () => {
    x.id = await tournament(A, { status: 'ACTIVE' });
    [x.home, x.away, x.spare] = await teams(A, x.id, 3);
    x.scorer = await player(A, x.id, x.home, 9);
    x.bench = await player(A, x.id, x.away, 4); // sin partidos
    x.free = (await as(A).post('/api/players').send({ confirmNew: true, firstName: 'Libre', lastName: 'X', position: 'MIDFIELDER' }).expect(201)).body.id;
    x.played = await match(A, x.id, 1, x.home, x.away);
    await result(A, x.played, 2, 0, [
      { playerId: x.scorer, teamId: x.home, goals: 2, assists: 0, yellowCards: 0, redCards: 0 },
    ]).expect(200);
    x.pending = await match(A, x.id, 2, x.away, x.home);
    x.outsider = await team(A);
    await as(A).put(`/api/tournaments/${x.id}/rounds/3`).send({ name: 'Vacía' }).expect(200);
    await as(A).post(`/api/tournaments/${x.id}/finish`).send({ allowPendingMatches: true }).expect(200);
    before = await snapshot();
  });

  const finished = /finalizado/;

  it('partidos: no se crean, editan, posponen ni eliminan', async () => {
    expect((await newMatch(A, x.id, 4, x.home, x.spare).expect(409)).body.message).toMatch(finished);
    await as(A).patch(`/api/matches/${x.pending}`).send({ time: '23:00' }).expect(409);
    await as(A).patch(`/api/matches/${x.pending}`).send({ status: 'POSTPONED' }).expect(409);
    await as(A).patch(`/api/matches/${x.played}`).send({ round: 3 }).expect(409);
    await as(A).delete(`/api/matches/${x.pending}`).expect(409);
  });

  it('resultados y PlayerMatchStats: no se modifican', async () => {
    await result(A, x.played, 5, 0, [
      { playerId: x.scorer, teamId: x.home, goals: 5, assists: 0, yellowCards: 0, redCards: 0 },
    ]).expect(409);
    await result(A, x.played, 2, 0, []).expect(409); // borrar estadísticas tampoco
    await result(A, x.pending, 1, 0).expect(409);
  });

  it('equipos: no se inscriben ni se retiran', async () => {
    await as(A).post(`/api/tournaments/${x.id}/teams/${x.outsider}`).expect(409);
    await as(A).delete(`/api/tournaments/${x.id}/teams/${x.spare}`).expect(409);
  });

  it('plantillas: no se agregan jugadores, ni se cambian dorsales, ni se mueven, ni se dan de baja', async () => {
    await as(A).put(`/api/tournaments/${x.id}/players/${x.free}`).send({ teamId: x.home, jerseyNumber: 20 }).expect(409);
    await as(A).put(`/api/tournaments/${x.id}/players/${x.scorer}`).send({ teamId: x.home, jerseyNumber: 99 }).expect(409);
    await as(A).put(`/api/tournaments/${x.id}/players/${x.scorer}`).send({ teamId: x.away, jerseyNumber: 9 }).expect(409);
    await as(A).delete(`/api/tournaments/${x.id}/players/${x.bench}`).expect(409);
  });

  it('jornadas y calendario: no se crean, editan, eliminan ni regeneran', async () => {
    await as(A).put(`/api/tournaments/${x.id}/rounds/4`).send({}).expect(409);
    await as(A).put(`/api/tournaments/${x.id}/rounds/1`).send({ name: 'Cambio' }).expect(409);
    await as(A).delete(`/api/tournaments/${x.id}/rounds/3`).expect(409);
    await schedule(A, x.id, { legs: 1, replaceExisting: true }).expect(409);
  });

  it('el torneo: ni datos, ni configuración, ni borrado', async () => {
    await as(A).patch(`/api/tournaments/${x.id}`).send({ name: 'Otro nombre' }).expect(409);
    await as(A).patch(`/api/tournaments/${x.id}`).send({ settings: { pointsForWin: 2 } }).expect(409);
    await as(A).delete(`/api/tournaments/${x.id}`).expect(409);
  });

  it('borrar fichas maestras no altera su historia', async () => {
    await as(A).delete(`/api/players/${x.bench}`).expect(409); // sin partidos, pero en la plantilla final
    await as(A).delete(`/api/teams/${x.spare}`).expect(409); // sin partidos, pero inscrito
  });

  it('otro organizador sigue recibiendo 403 (la propiedad se comprueba primero)', async () => {
    await as(B).patch(`/api/matches/${x.pending}`).send({ time: '23:00' }).expect(403);
    await as(B).post(`/api/tournaments/${x.id}/teams/${x.outsider}`).expect(403);
  });

  it('las lecturas públicas siguen funcionando y nada cambió', async () => {
    const after = await snapshot();
    expect(after).toEqual(before);
    const s = after as Awaited<ReturnType<typeof snapshot>>;
    expect(s.tournament.status).toBe('FINISHED');
    expect(s.teams).toHaveLength(3);
    expect(s.rounds.map((r: { number: number }) => r.number)).toEqual([1, 2, 3]);
    expect(s.matches).toHaveLength(2);
    expect(s.stats.meta.total).toBe(1);
    expect(s.roster).toHaveLength(2);
    expect(s.scorers[0]).toMatchObject({ playerId: x.scorer, goals: 2 });
  });
});

// ─── Regresión cross-organizer ──────────────────────────────────────────────

describe('Identidades globales entre organizadores (regresión)', () => {
  it('B usa Team y Player de A en su torneo, sin poder editarlos ni tocar lo de A', async () => {
    const ligaA = await tournament(A, { status: 'ACTIVE' });
    const [tigres, atlas] = await teams(A, ligaA, 2);
    const juan = await player(A, ligaA, tigres, 10);
    await result(A, await match(A, ligaA, 1, tigres, atlas), 1, 0, [
      { playerId: juan, teamId: tigres, goals: 1, assists: 0, yellowCards: 0, redCards: 0 },
    ]).expect(200);

    const copaB = await tournament(B, { status: 'ACTIVE' });
    await as(B).post(`/api/tournaments/${copaB}/teams/${tigres}`).expect(201);
    const rival = await team(B, copaB);
    await as(B).put(`/api/tournaments/${copaB}/players/${juan}`).send({ teamId: tigres, jerseyNumber: 7 }).expect(200);
    const gen = await schedule(B, copaB, { legs: 1 }).expect(201);
    const only = gen.body.matches[0] as ApiMatch;
    const tigresHome = only.homeTeamId === tigres;
    expect([only.homeTeamId, only.awayTeamId].sort()).toEqual([tigres, rival].sort());
    const juanStats = [{ playerId: juan, teamId: tigres, goals: 2, assists: 0, yellowCards: 0, redCards: 0 }];
    await result(B, only.id, tigresHome ? 2 : 0, tigresHome ? 0 : 2, juanStats).expect(200);
    const stats = (await api().get(`/api/players/${juan}/stats`).expect(200)).body;
    expect(stats.totals).toMatchObject({ matchesPlayed: 2, goals: 3 });

    await as(B).patch(`/api/teams/${tigres}`).send({ name: 'Tigres B' }).expect(403);
    await as(B).patch(`/api/players/${juan}`).send({ firstName: 'Otro' }).expect(403);
    await as(B).patch(`/api/tournaments/${ligaA}`).send({ name: 'x' }).expect(403);
    await as(B).put(`/api/tournaments/${ligaA}/rounds/1`).send({ name: 'x' }).expect(403);
    await schedule(B, ligaA, { legs: 1, replaceExisting: true }).expect(403);

    const history = (await api().get(`/api/players/${juan}`).expect(200)).body.memberships;
    expect(history.filter((m: { active: boolean }) => m.active)).toHaveLength(2);
    // A puede finalizar su liga sin afectar el torneo de B
    await as(A).post(`/api/tournaments/${ligaA}/finish`).send({}).expect(200);
    await as(B).put(`/api/tournaments/${copaB}/players/${juan}`).send({ teamId: tigres, jerseyNumber: 8 }).expect(200);
  });
});
