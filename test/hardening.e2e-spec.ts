/**
 * Endurecimiento de Torneo Real V1 (pre-Alpha):
 * - DRAFT se configura y se programa, pero no se juega: nada de LIVE, resultados ni estadísticas.
 * - Carreras reales: "equipo repetido en jornada" y "pendientes al finalizar" bajo concurrencia.
 * - Contrato de GET /standings, que el frontend consume como fuente de verdad.
 *
 * Todo contra la API directamente (la UI no interviene). Los tests de concurrencia lanzan las
 * peticiones a la vez; los de "intercalado forzado" retrasan una petición justo después de su
 * validación para que la otra llegue en la ventana entre leer y escribir: sin el cerrojo por
 * torneo, esos tests fallan (ambas peticiones pasan la validación).
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { MatchesService } from '../src/modules/matches/matches.service.js';
import { TournamentsService } from '../src/modules/tournaments/tournaments.service.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);

type Org = Awaited<ReturnType<typeof registerOrganizer>>;
let A: Org;
const as = (org: Org) => authed(http, org.token);

// ─── Helpers ────────────────────────────────────────────────────────────────

let seq = 0;
async function tournament(status: 'DRAFT' | 'ACTIVE' = 'DRAFT', extra: Record<string, unknown> = {}) {
  seq++;
  const res = await as(A)
    .post('/api/tournaments')
    .send({ name: `Liga H${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status, ...extra })
    .expect(201);
  return res.body.id as string;
}
async function teams(tournamentId: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    seq++;
    const id = (await as(A).post('/api/teams').send({ name: `Equipo H${seq}` }).expect(201)).body.id as string;
    await as(A).post(`/api/tournaments/${tournamentId}/teams/${id}`).expect(201);
    ids.push(id);
  }
  return ids;
}
async function player(tournamentId: string, teamId: string, jerseyNumber: number) {
  seq++;
  const id = (
    await as(A).post('/api/players').send({ confirmNew: true, firstName: 'Jugador', lastName: `H${seq}`, position: 'FORWARD' }).expect(201)
  ).body.id as string;
  await as(A)
    .put(`/api/tournaments/${tournamentId}/players/${id}`)
    .send({ teamId, jerseyNumber, startDate: '2027-01-01' })
    .expect(200);
  return id;
}
const newMatch = (tournamentId: string, round: number, home: string, away: string, extra = {}) =>
  as(A)
    .post('/api/matches')
    .send({ tournamentId, round, homeTeamId: home, awayTeamId: away, date: '2027-02-06', time: '18:00', ...extra });
async function match(tournamentId: string, round: number, home: string, away: string) {
  return (await newMatch(tournamentId, round, home, away).expect(201)).body.id as string;
}
const goal = (playerId: string, teamId: string, goals = 1) => ({
  playerId,
  teamId,
  goals,
  assists: 0,
  yellowCards: 0,
  redCards: 0,
});
const result = (matchId: string, homeScore: number, awayScore: number, playerStats: unknown[] = [], extra = {}) =>
  as(A).put(`/api/matches/${matchId}/result`).send({ homeScore, awayScore, playerStats, ...extra });
const matchesOf = async (tournamentId: string) =>
  (await api().get(`/api/tournaments/${tournamentId}/matches`).expect(200)).body as {
    id: string;
    round: number;
    homeTeamId: string;
    awayTeamId: string;
    status: string;
    homeScore: number | null;
  }[];
const statsOf = async (tournamentId: string) =>
  (await api().get(`/api/player-match-stats?tournamentId=${tournamentId}`).expect(200)).body.meta.total as number;
const statusOf = async (tournamentId: string) =>
  (await api().get(`/api/tournaments/${tournamentId}`).expect(200)).body.status as string;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retrasa un método de un service DESPUÉS de ejecutarse: abre la ventana entre la validación
 * y la escritura en la que otra petición concurrente podría colarse.
 */
function slowDown(service: object, method: string, ms: number) {
  const target = service as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target[method].bind(service);
  return vi.spyOn(target, method).mockImplementation(async (...args: unknown[]) => {
    const value = await original(...args);
    await sleep(ms);
    return value;
  });
}

/** Lanza `first`, espera a que esté dentro de su ventana y lanza `second`. */
async function interleave(first: request.Test, second: () => request.Test, gap = 80) {
  const a = first.then((r) => r);
  await sleep(gap);
  const b = await second();
  return [await a, b] as const;
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Hana');
});
afterAll(async () => ctx?.close());
afterEach(() => vi.restoreAllMocks());

// ─── DRAFT: se configura y se programa, pero no se juega ────────────────────

describe('DRAFT: sin actividad deportiva (requests directos a la API)', () => {
  const x: Record<string, string> = {};
  const notStarted = /no ha iniciado/;

  beforeAll(async () => {
    x.id = await tournament('DRAFT');
    // Todo lo de preparación sí funciona en DRAFT.
    await as(A).patch(`/api/tournaments/${x.id}`).send({ venue: 'Deportivo Norte', settings: { pointsForWin: 2 } }).expect(200);
    [x.home, x.away, x.third] = await teams(x.id, 3);
    x.scorer = await player(x.id, x.home, 9);
    x.keeper = await player(x.id, x.away, 1);
    await as(A).put(`/api/tournaments/${x.id}/rounds/1`).send({ name: 'Inaugural' }).expect(200);
    const gen = await as(A)
      .post(`/api/tournaments/${x.id}/schedule`)
      .send({ legs: 1, startDate: '2027-03-06' })
      .expect(201);
    const first = gen.body.matches.find(
      (m: { homeTeamId: string; awayTeamId: string }) =>
        [m.homeTeamId, m.awayTeamId].sort().join() === [x.home, x.away].sort().join(),
    );
    x.match = first.id;
    x.matchHome = first.homeTeamId;
    x.matchAway = first.awayTeamId;
    // Reprogramar un partido (fecha/hora/sede) también es preparación.
    await as(A).patch(`/api/matches/${x.match}`).send({ reason: 'Motivo de prueba', date: '2027-03-07', time: '10:00', venue: 'Cancha 2' }).expect(200);
  });

  it('no se captura resultado (ni marcador solo, ni con estadísticas, ni como LIVE)', async () => {
    const res = await result(x.match, 1, 0).expect(409);
    expect(res.body.message).toMatch(notStarted);
    await result(x.match, 1, 0, [goal(x.scorer, x.home)]).expect(409);
    await result(x.match, 1, 0, [], { status: 'LIVE' }).expect(409);
    await result(x.match, 0, 0, [{ ...goal(x.keeper, x.away, 0), played: true }]).expect(409);
  });

  it('no se crean ni modifican PlayerMatchStats', async () => {
    expect(await statsOf(x.id)).toBe(0);
    expect((await api().get(`/api/matches/${x.match}/stats`).expect(200)).body).toEqual([]);
    expect((await api().get(`/api/players/${x.scorer}/stats`).expect(200)).body.totals).toMatchObject({
      matchesPlayed: 0,
      goals: 0,
    });
  });

  it('un partido no pasa a LIVE, ni al crearlo ni por PATCH', async () => {
    const res = await newMatch(x.id, 5, x.home, x.away, { status: 'LIVE' }).expect(409);
    expect(res.body.message).toMatch(notStarted);
    expect((await as(A).patch(`/api/matches/${x.match}`).send({ reason: 'Motivo de prueba', status: 'LIVE' }).expect(409)).body.message).toMatch(
      notStarted,
    );
  });

  it('no se finaliza un partido por una ruta alternativa (PATCH status FINISHED)', async () => {
    const res = await as(A).patch(`/api/matches/${x.match}`).send({ reason: 'Motivo de prueba', status: 'FINISHED' }).expect(409);
    expect(res.body.message).toMatch(notStarted);
    // PATCH no admite marcador: los campos de resultado solo existen en PUT /result.
    await as(A).patch(`/api/matches/${x.match}`).send({ reason: 'Motivo de prueba', homeScore: 3, awayScore: 0 }).expect(400);
  });

  it('no se cuela un partido jugado moviéndolo desde un torneo ACTIVE', async () => {
    const active = await tournament('ACTIVE');
    await as(A).post(`/api/tournaments/${active}/teams/${x.home}`).expect(201);
    await as(A).post(`/api/tournaments/${active}/teams/${x.away}`).expect(201);
    const played = await match(active, 1, x.home, x.away);
    await result(played, 2, 1).expect(200);
    const live = await match(active, 2, x.away, x.home);
    await as(A).patch(`/api/matches/${live}`).send({ reason: 'Motivo de prueba', status: 'LIVE' }).expect(200);

    await as(A).patch(`/api/matches/${played}`).send({ reason: 'Motivo de prueba', tournamentId: x.id, round: 9 }).expect(409);
    const res = await as(A).patch(`/api/matches/${live}`).send({ reason: 'Motivo de prueba', tournamentId: x.id, round: 9 }).expect(409);
    expect(res.body.message).toMatch(notStarted);
    expect((await matchesOf(x.id)).some((m) => m.id === played || m.id === live)).toBe(false);
  });

  it('nada quedó jugado: partidos sin marcador, tabla y goleadores vacíos', async () => {
    const matches = await matchesOf(x.id);
    expect(matches).toHaveLength(3);
    expect(matches.every((m) => m.status === 'SCHEDULED' && m.homeScore === null)).toBe(true);
    const table = (await api().get(`/api/tournaments/${x.id}/standings`).expect(200)).body;
    expect(table.every((r: { played: number }) => r.played === 0)).toBe(true);
    expect((await api().get(`/api/tournaments/${x.id}/top-scorers`).expect(200)).body).toEqual([]);
    const summary = (await api().get(`/api/tournaments/${x.id}/summary`).expect(200)).body;
    expect(summary).toMatchObject({ total: 3, scheduled: 3, live: 0, finished: 0 });
  });

  it('pospuesto/cancelado siguen siendo decisiones de programación válidas en DRAFT', async () => {
    const other = (await matchesOf(x.id)).find((m) => m.id !== x.match)!;
    await as(A).patch(`/api/matches/${other.id}`).send({ reason: 'Motivo de prueba', status: 'POSTPONED' }).expect(200);
    await as(A).patch(`/api/matches/${other.id}`).send({ reason: 'Motivo de prueba', status: 'SCHEDULED' }).expect(200);
  });

  it('ACTIVE: los mismos flujos sí funcionan', async () => {
    await as(A).post(`/api/tournaments/${x.id}/start`).expect(200);
    await as(A).patch(`/api/matches/${x.match}`).send({ reason: 'Motivo de prueba', status: 'LIVE' }).expect(200);
    const scorerTeam = x.home;
    const homeGoals = x.matchHome === scorerTeam ? 2 : 0;
    const awayGoals = x.matchAway === scorerTeam ? 2 : 0;
    const saved = await result(x.match, homeGoals, awayGoals, [goal(x.scorer, scorerTeam, 2)], { status: 'LIVE' }).expect(200);
    expect(saved.body.match).toMatchObject({ status: 'LIVE' });
    await result(x.match, homeGoals, awayGoals, [goal(x.scorer, scorerTeam, 2), { ...goal(x.keeper, x.away, 0) }]).expect(200);
    expect(await statsOf(x.id)).toBe(2);
    const live = await newMatch(x.id, 7, x.home, x.third, { status: 'LIVE' }).expect(201);
    expect(live.body.status).toBe('LIVE');

    const table = (await api().get(`/api/tournaments/${x.id}/standings`).expect(200)).body;
    // puntuación configurada en DRAFT (2/1/0)
    expect(table[0]).toMatchObject({ teamId: x.home, played: 1, wins: 1, points: 2 });
    const scorers = (await api().get(`/api/tournaments/${x.id}/top-scorers`).expect(200)).body;
    expect(scorers[0]).toMatchObject({ playerId: x.scorer, goals: 2 });
  });
});

// ─── Carrera: equipo repetido en la misma jornada ───────────────────────────

describe('Concurrencia: un equipo no juega dos veces en la misma jornada', () => {
  // La jornada ya existe, como tras generar el calendario. Nota: create/mover de jornada
  // también tocan el registro Round (updatedAt), que por casualidad ya serializaba esos dos
  // caminos; los tests "sin registro de jornada" usan rutas que no lo tocan (reactivar un
  // cancelado, cambiar un equipo) y fallan sin el cerrojo por torneo.
  const round = (id: string, n: number) => as(A).put(`/api/tournaments/${id}/rounds/${n}`).send({}).expect(200);

  it('intercalado forzado: A y B validan "Tigres libre en J5" a la vez → solo uno se guarda', async () => {
    const id = await tournament('ACTIVE');
    const [tigres, america, atlas] = await teams(id, 3);
    await round(id, 5);
    slowDown(ctx.app.get(MatchesService), 'assertRoundAvailable', 300);

    const [a, b] = await interleave(newMatch(id, 5, tigres, america), () => newMatch(id, 5, tigres, atlas));
    expect([a.status, b.status]).toEqual([201, 409]);
    expect(b.body.message).toMatch(/ya juega otro partido en la jornada 5/);
    const j5 = (await matchesOf(id)).filter((m) => m.round === 5);
    expect(j5).toHaveLength(1);
    expect(j5[0]).toMatchObject({ homeTeamId: tigres, awayTeamId: america });
  });

  it('intercalado forzado con PATCH: mover dos partidos del mismo equipo a la misma jornada', async () => {
    const id = await tournament('ACTIVE');
    const [tigres, america, atlas] = await teams(id, 3);
    const m1 = await match(id, 1, tigres, america);
    const m2 = await match(id, 2, atlas, tigres);
    await round(id, 8);
    slowDown(ctx.app.get(MatchesService), 'assertRoundAvailable', 300);

    const [a, b] = await interleave(as(A).patch(`/api/matches/${m1}`).send({ reason: 'Motivo de prueba', round: 8 }), () =>
      as(A).patch(`/api/matches/${m2}`).send({ reason: 'Motivo de prueba', round: 8 }),
    );
    expect([a.status, b.status]).toEqual([200, 409]);
    expect((await matchesOf(id)).filter((m) => m.round === 8).map((m) => m.id)).toEqual([m1]);
  });

  it('sin registro de jornada: reactivar un cancelado mientras se programa otro partido del mismo equipo', async () => {
    const id = await tournament('ACTIVE');
    const [tigres, america, atlas] = await teams(id, 3);
    const cancelled = await match(id, 5, tigres, atlas);
    await as(A).patch(`/api/matches/${cancelled}`).send({ reason: 'Motivo de prueba', status: 'CANCELLED' }).expect(200);
    slowDown(ctx.app.get(MatchesService), 'assertRoundAvailable', 300);

    const [a, b] = await interleave(newMatch(id, 5, tigres, america), () =>
      as(A).patch(`/api/matches/${cancelled}`).send({ reason: 'Motivo de prueba', status: 'SCHEDULED' }),
    );
    expect([a.status, b.status]).toEqual([201, 409]);
    const vigentes = (await matchesOf(id)).filter((m) => m.round === 5 && m.status !== 'CANCELLED');
    expect(vigentes).toHaveLength(1);
  });

  it('sin registro de jornada: dos partidos de la misma jornada cambian de equipo al mismo rival', async () => {
    const id = await tournament('ACTIVE');
    const [tigres, america, atlas, pumas, chivas] = await teams(id, 5);
    const m1 = await match(id, 4, america, atlas);
    const m2 = await match(id, 4, pumas, chivas);
    slowDown(ctx.app.get(MatchesService), 'assertRoundAvailable', 300);

    const [a, b] = await interleave(as(A).patch(`/api/matches/${m1}`).send({ reason: 'Motivo de prueba', homeTeamId: tigres }), () =>
      as(A).patch(`/api/matches/${m2}`).send({ reason: 'Motivo de prueba', awayTeamId: tigres }),
    );
    expect([a.status, b.status]).toEqual([200, 409]);
    const withTigres = (await matchesOf(id)).filter(
      (m) => m.round === 4 && (m.homeTeamId === tigres || m.awayTeamId === tigres),
    );
    expect(withTigres.map((m) => m.id)).toEqual([m1]);
  });

  it('ráfaga real sin retrasos: 8 peticiones simultáneas con el mismo equipo en la misma jornada', async () => {
    const id = await tournament('ACTIVE');
    const [tigres, ...rivals] = await teams(id, 9);
    await round(id, 3);
    const responses = await Promise.all(rivals.map((rival) => newMatch(id, 3, tigres, rival)));
    const codes = responses.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const j3 = (await matchesOf(id)).filter((m) => m.round === 3);
    expect(j3).toHaveLength(1);
  });
});

// ─── Carrera: finalizar el torneo mientras entra una escritura deportiva ─────

describe('Concurrencia: finalizar vs. escrituras deportivas', () => {
  it('finish llega mientras se programa un partido → espera, lo cuenta y exige confirmación', async () => {
    const id = await tournament('ACTIVE');
    const [t1, t2] = await teams(id, 2);
    await result(await match(id, 1, t1, t2), 1, 0).expect(200);
    slowDown(ctx.app.get(MatchesService), 'assertRoundAvailable', 300);

    const [created, finish] = await interleave(newMatch(id, 2, t2, t1), () =>
      as(A).post(`/api/tournaments/${id}/finish`).send({}),
    );
    expect(created.status).toBe(201);
    // Sin cerrojo, finish habría contado 0 pendientes, cerrado el torneo y el partido nuevo
    // habría entrado en un torneo FINISHED.
    expect(finish.status).toBe(409);
    expect(finish.body.summary).toMatchObject({ total: 2, pending: 1 });
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('una escritura llega mientras finish cuenta pendientes → 409 y el resumen coincide con lo guardado', async () => {
    const id = await tournament('ACTIVE');
    const [t1, t2, t3] = await teams(id, 3);
    await result(await match(id, 1, t1, t2), 2, 2).expect(200);
    const pending = await match(id, 2, t2, t3);
    slowDown(ctx.app.get(TournamentsService), 'summary', 300);

    const [finish, write] = await interleave(
      as(A).post(`/api/tournaments/${id}/finish`).send({ allowPendingMatches: true }),
      () => newMatch(id, 3, t3, t1),
    );
    expect(finish.status).toBe(200);
    expect(write.status).toBe(409);
    expect(write.body.message).toMatch(/finalizado/);
    const matches = await matchesOf(id);
    expect(matches).toHaveLength(finish.body.summary.total);
    expect(finish.body.summary).toMatchObject({ total: 2, finished: 1, pending: 1 });
    expect(matches.find((m) => m.id === pending)!.status).toBe('SCHEDULED');
    expect(await statusOf(id)).toBe('FINISHED');
  });

  it('un resultado en curso termina antes de que finish cuente (no queda "jugado después de cerrar")', async () => {
    const id = await tournament('ACTIVE');
    const [t1, t2] = await teams(id, 2);
    const scorer = await player(id, t1, 10);
    const m = await match(id, 1, t1, t2);
    slowDown(ctx.app.get(MatchesService), 'validateStats', 300);

    const [saved, finish] = await interleave(result(m, 1, 0, [goal(scorer, t1)]), () =>
      as(A).post(`/api/tournaments/${id}/finish`).send({ allowPendingMatches: true }),
    );
    expect(saved.status).toBe(200);
    expect(finish.status).toBe(200);
    expect(finish.body.summary).toMatchObject({ total: 1, finished: 1, pending: 0 });
    expect(await statsOf(id)).toBe(1);
  });

  it('otras escrituras (resultado, jornada, plantilla, inscripción) tampoco entran tras finish', async () => {
    const id = await tournament('ACTIVE');
    const [t1, t2, t3] = await teams(id, 3);
    const m = await match(id, 1, t1, t2);
    const free = (await as(A).post('/api/players').send({ confirmNew: true, firstName: 'L', lastName: 'Z', position: 'DEFENDER' }).expect(201))
      .body.id;
    slowDown(ctx.app.get(TournamentsService), 'summary', 300);

    const finish = as(A).post(`/api/tournaments/${id}/finish`).send({ allowPendingMatches: true }).then((r) => r);
    await sleep(80);
    const writes = await Promise.all([
      result(m, 1, 0),
      as(A).put(`/api/tournaments/${id}/rounds/4`).send({ name: 'Tarde' }),
      as(A).put(`/api/tournaments/${id}/players/${free}`).send({ teamId: t3, jerseyNumber: 5 }),
      as(A).delete(`/api/tournaments/${id}/teams/${t3}`),
      as(A).patch(`/api/tournaments/${id}`).send({ name: 'Renombrado' }),
    ]);
    expect((await finish).status).toBe(200);
    expect(writes.map((w) => w.status)).toEqual([409, 409, 409, 409, 409]);
    const after = await matchesOf(id);
    expect(after[0]).toMatchObject({ status: 'SCHEDULED', homeScore: null });
    expect((await api().get(`/api/tournaments/${id}`)).body.name).not.toBe('Renombrado');
    expect((await api().get(`/api/tournaments/${id}/teams`)).body).toHaveLength(3);
  });

  it('ráfaga real: finish + 6 partidos simultáneos → todo lo guardado está contado en el resumen', async () => {
    const id = await tournament('ACTIVE');
    const t = await teams(id, 12);
    const creates = [0, 2, 4, 6, 8, 10].map((i) => newMatch(id, 1, t[i], t[i + 1]).then((r) => r));
    const finish = as(A).post(`/api/tournaments/${id}/finish`).send({ allowPendingMatches: true }).then((r) => r);
    const [finished, ...created] = await Promise.all([finish, ...creates]);

    expect(finished.status).toBe(200);
    const stored = await matchesOf(id);
    expect(created.filter((r) => r.status === 201)).toHaveLength(stored.length);
    expect(created.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(finished.body.summary.total).toBe(stored.length);
    expect(await statusOf(id)).toBe('FINISHED');
  });
});

// ─── Carrera: regenerar calendario mientras se captura un resultado ──────────

describe('Concurrencia: calendario vs. resultado', () => {
  it('regenerar no borra un resultado que se está capturando (ni deja estadísticas huérfanas)', async () => {
    const id = await tournament('ACTIVE');
    const [t1] = await teams(id, 4);
    const scorer = await player(id, t1, 7);
    const generated = (await as(A).post(`/api/tournaments/${id}/schedule`).send({ legs: 1, startDate: '2027-03-06' }).expect(201))
      .body.matches as { id: string; homeTeamId: string; awayTeamId: string }[];
    const target = generated.find((m) => m.homeTeamId === t1 || m.awayTeamId === t1)!;
    const home = target.homeTeamId === t1;
    slowDown(ctx.app.get(MatchesService), 'validateStats', 300);

    const [saved, regen] = await interleave(result(target.id, home ? 1 : 0, home ? 0 : 1, [goal(scorer, t1)]), () =>
      as(A).post(`/api/tournaments/${id}/schedule`).send({ legs: 2, startDate: '2027-03-06', replaceExisting: true }),
    );
    expect(saved.status).toBe(200);
    expect(regen.status).toBe(409);
    const matches = await matchesOf(id);
    expect(matches).toHaveLength(6);
    expect(matches.find((m) => m.id === target.id)).toMatchObject({ status: 'FINISHED' });
    expect(await statsOf(id)).toBe(1);
  });
});

// ─── GET /standings: contrato que consume el frontend ───────────────────────

describe('GET /tournaments/:id/standings (fuente de verdad del frontend)', () => {
  type Row = {
    position: number;
    teamId: string;
    played: number;
    wins: number;
    draws: number;
    losses: number;
    goalsFor: number;
    goalsAgainst: number;
    goalDifference: number;
    points: number;
    form: string[];
    team: { id: string; name: string } | null;
  };
  const table = async (id: string) => (await api().get(`/api/tournaments/${id}/standings`).expect(200)).body as Row[];

  it('3/1/0 y 2/1/0 con desempate PTS → DG → GF; POSTPONED/CANCELLED/LIVE no cuentan', async () => {
    const id = await tournament('ACTIVE');
    const [a, b, c, d] = await teams(id, 4);
    // a: G 3-0 vs d, E 1-1 vs b            → 4 pts (3/1/0), DG +3, GF 4
    // b: E 1-1 vs a, G 2-1 vs c            → 4 pts,         DG +1, GF 3
    // c: P 1-2 vs b, G 3-0 vs d            → 3 pts,         DG +2, GF 4
    // d: P 0-3, P 0-3                      → 0 pts
    await result(await match(id, 1, a, d), 3, 0).expect(200);
    await result(await match(id, 1, b, c), 2, 1).expect(200);
    await result(await match(id, 2, a, b), 1, 1).expect(200);
    await result(await match(id, 2, c, d), 3, 0).expect(200);
    // No cuentan:
    const postponed = await match(id, 3, a, c);
    await as(A).patch(`/api/matches/${postponed}`).send({ reason: 'Motivo de prueba', status: 'POSTPONED' }).expect(200);
    const cancelled = await match(id, 3, b, d);
    await as(A).patch(`/api/matches/${cancelled}`).send({ reason: 'Motivo de prueba', status: 'CANCELLED' }).expect(200);
    await result(await match(id, 4, d, a), 5, 0, [], { status: 'LIVE' }).expect(200);

    const t310 = await table(id);
    expect(t310.map((r) => [r.position, r.teamId, r.points])).toEqual([
      [1, a, 4],
      [2, b, 4],
      [3, c, 3],
      [4, d, 0],
    ]);
    expect(t310[0]).toMatchObject({
      played: 2,
      wins: 1,
      draws: 1,
      losses: 0,
      goalsFor: 4,
      goalsAgainst: 1,
      goalDifference: 3,
      form: ['W', 'D'],
      team: { id: a },
    });
    expect(t310[3]).toMatchObject({ played: 2, wins: 0, losses: 2, goalDifference: -6 });

    // 2/1/0: a y b empatan a 3 → DG decide; c (2 pts) sigue tercero.
    await as(A).patch(`/api/tournaments/${id}`).send({ settings: { pointsForWin: 2 } }).expect(200);
    const t210 = await table(id);
    expect(t210.map((r) => [r.teamId, r.points])).toEqual([
      [a, 3],
      [b, 3],
      [c, 2],
      [d, 0],
    ]);
  });

  it('empate a puntos y DG: decide GF', async () => {
    const id = await tournament('ACTIVE');
    const [a, b, c] = await teams(id, 3);
    await result(await match(id, 1, a, c), 3, 2).expect(200); // a: +1, GF 3
    await result(await match(id, 2, b, c), 1, 0).expect(200); // b: +1, GF 1
    expect((await table(id)).map((r) => r.teamId)).toEqual([a, b, c]);
  });
});
