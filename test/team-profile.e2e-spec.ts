/**
 * Team Profile V1: GET /teams/:id/profile (agregado público, fuente de verdad), GET /teams/:id/matches
 * (paginado en la base), lecturas heredadas de plantilla con contexto de torneo y privacidad.
 * Todo contra la API real (sin frontend).
 */
import request from 'supertest';
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
async function tournament(org: Org, startDate: string, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE') {
  seq++;
  return (
    await as(org)
      .post('/api/tournaments')
      .send({ name: `Torneo T${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate, status })
      .expect(201)
  ).body.id as string;
}
async function newTeam(org: Org, name: string, city?: string) {
  return (await as(org).post('/api/teams').send({ name, ...(city ? { city } : {}) }).expect(201)).body.id as string;
}
const enroll = (org: Org, t: string, team: string) => as(org).post(`/api/tournaments/${t}/teams/${team}`).expect(201);
async function newPlayer(org: Org, firstName: string, birthDate = '2001-04-18') {
  seq++;
  return (
    await as(org).post('/api/players').send({ confirmNew: true, firstName, lastName: `T${seq}`, position: 'FORWARD', birthDate }).expect(201)
  ).body.id as string;
}
const register = (org: Org, t: string, player: string, team: string, jerseyNumber: number) =>
  as(org).put(`/api/tournaments/${t}/players/${player}`).send({ teamId: team, jerseyNumber, startDate: '2026-10-01' }).expect(200);
async function match(org: Org, t: string, round: number, home: string, away: string, date: string) {
  return (
    await as(org).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date, time: '18:00' }).expect(201)
  ).body.id as string;
}
const goal = (playerId: string, teamId: string, goals = 1) => ({ playerId, teamId, goals, assists: 0, yellowCards: 0, redCards: 0 });
const result = (org: Org, m: string, hs: number, as_: number, playerStats: unknown[] = [], status?: 'LIVE') =>
  as(org)
    .put(`/api/matches/${m}/result`)
    .send({ homeScore: hs, awayScore: as_, playerStats, ...(status ? { status } : {}) })
    .expect(200);
const profile = async (id: string) => (await api().get(`/api/teams/${id}/profile`).expect(200)).body;

const FORBIDDEN = ['birthDate', 'email', 'phone', 'password', 'passwordHash', 'refreshToken', 'tokenHash', 'createdBy', 'organizerId', 'searchName', 'writeSeq'];
function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN.includes(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)]);
}

// ─── Escenario ──────────────────────────────────────────────────────────────

const x: Record<string, string> = {};

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Ana');
  B = await registerOrganizer(http, 'Beto');

  x.dm = await newTeam(A, 'Deportivo Mazatlán', 'Mazatlán, Sin.');
  x.tg = await newTeam(A, 'Tigres');
  x.r1 = await newTeam(A, 'Rival Uno');
  x.r2 = await newTeam(A, 'Rival Dos');
  x.r3 = await newTeam(B, 'Rival Tres');
  x.empty = await newTeam(B, 'Equipo Sin Jugadores');
  x.fresh = await newTeam(A, 'Equipo Nuevo');
  x.juan = await newPlayer(A, 'Juan');
  x.pedro = await newPlayer(B, 'Pedro');
  x.luis = await newPlayer(B, 'Luis');

  // Copa de A (2026): DM gana de local, empata de visitante; se FINALIZA completa y sin empate arriba.
  x.copa = await tournament(A, '2026-11-01');
  for (const t of [x.dm, x.r1, x.r2]) await enroll(A, x.copa, t);
  await register(A, x.copa, x.juan, x.dm, 9);
  x.c1 = await match(A, x.copa, 1, x.dm, x.r1, '2026-11-07');
  await result(A, x.c1, 3, 1, [goal(x.juan, x.dm, 2)]);
  x.c2 = await match(A, x.copa, 2, x.r2, x.dm, '2026-11-14');
  await result(A, x.c2, 1, 1);
  x.c3 = await match(A, x.copa, 3, x.r1, x.r2, '2026-11-21');
  await result(A, x.c3, 0, 2);
  await as(A).post(`/api/tournaments/${x.copa}/finish`).send({}).expect(200);

  // Liga de B (2027): el MISMO Team de A, reutilizado por otro organizador.
  x.liga = await tournament(B, '2027-01-10');
  for (const t of [x.dm, x.tg, x.r3, x.empty]) await enroll(B, x.liga, t);
  await register(B, x.liga, x.juan, x.tg, 10); // Juan ahora juega con Tigres en esta liga
  await register(B, x.liga, x.pedro, x.dm, 7);
  await register(B, x.liga, x.luis, x.dm, 5);
  x.l1 = await match(B, x.liga, 1, x.tg, x.dm, '2027-01-16'); // DM gana de visitante
  await result(B, x.l1, 0, 1, [goal(x.pedro, x.dm)]);
  x.l2 = await match(B, x.liga, 2, x.dm, x.r3, '2027-01-23'); // DM pierde de local
  await result(B, x.l2, 0, 2);
  x.l3 = await match(B, x.liga, 3, x.tg, x.r3, '2027-01-30'); // Juan marca con Tigres
  await result(B, x.l3, 1, 0, [goal(x.juan, x.tg)]);
  // No cuentan: LIVE con marcador, programado, pospuesto y cancelado.
  x.live = await match(B, x.liga, 4, x.dm, x.tg, '2027-02-06');
  await result(B, x.live, 5, 0, [goal(x.luis, x.dm, 5)], 'LIVE');
  x.sched = await match(B, x.liga, 5, x.r3, x.dm, '2027-02-13');
  x.post = await match(B, x.liga, 6, x.dm, x.empty, '2027-02-20');
  await as(B).patch(`/api/matches/${x.post}`).send({ status: 'POSTPONED' }).expect(200);
  x.canc = await match(B, x.liga, 7, x.empty, x.dm, '2027-02-27');
  await as(B).patch(`/api/matches/${x.canc}`).send({ status: 'CANCELLED' }).expect(200);
  // Pedro se da de baja: su participación queda en la historia (active=false).
  await as(B).delete(`/api/tournaments/${x.liga}/players/${x.pedro}`).expect(204);

  // Torneo DRAFT de A donde DM ya está inscrito (por empezar).
  x.estatal = await tournament(A, '2028-03-01', 'DRAFT');
  await enroll(A, x.estatal, x.dm);
});
afterAll(async () => ctx?.close());

describe('GET /teams/:id/profile', () => {
  it('404 si no existe; 400 si el id no es válido', async () => {
    await api().get('/api/teams/64b000000000000000000000/profile').expect(404);
    await api().get('/api/teams/no-es-id/profile').expect(400);
  });

  it('equipo sin partidos ni jugadores: 200 y todo vacío', async () => {
    const p = await profile(x.fresh);
    expect(p.team).toMatchObject({ id: x.fresh, name: 'Equipo Nuevo', city: null });
    expect(p.career).toEqual({ matchesPlayed: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, competitions: 0 });
    expect(p).toMatchObject({ currentParticipations: [], competitions: [], rosters: [], topScorers: [], recentMatches: [], upcomingMatches: [], history: [], honors: [], form: [] });
  });

  it('equipo inscrito pero sin jugadores (datos parciales): competición actual, sin plantilla', async () => {
    const p = await profile(x.empty);
    expect(p.competitions.map((c: { tournament: { id: string } }) => c.tournament.id)).toEqual([x.liga]);
    expect(p.currentParticipations[0]).toMatchObject({ tournament: { id: x.liga }, standing: { teams: 4 } });
    expect(p.rosters).toEqual([]);
    expect(p.career.matchesPlayed).toBe(0);
  });

  it('balance histórico: local y visitante; victoria, empate y derrota; solo FINISHED', async () => {
    const p = await profile(x.dm);
    // Copa: 3-1 (L, G) y 1-1 (V, E) · Liga: 0-1 (V, G) y 0-2 (L, P). LIVE/programado/pospuesto/cancelado no cuentan.
    expect(p.career).toEqual({ matchesPlayed: 4, wins: 2, draws: 1, losses: 1, goalsFor: 5, goalsAgainst: 4, goalDifference: 1, competitions: 3 });
    expect(p.team).toMatchObject({ id: x.dm, name: 'Deportivo Mazatlán', shortName: expect.any(String), city: 'Mazatlán, Sin.' });
  });

  it('múltiples torneos y organizadores: competiciones sin duplicar, actuales primero', async () => {
    const p = await profile(x.dm);
    expect(
      p.competitions.map((c: { tournament: { id: string; status: string }; current: boolean; record: { matchesPlayed: number } }) => [
        c.tournament.id,
        c.tournament.status,
        c.current,
        c.record.matchesPlayed,
      ]),
    ).toEqual([
      [x.estatal, 'DRAFT', true, 0],
      [x.liga, 'ACTIVE', true, 2],
      [x.copa, 'FINISHED', false, 2],
    ]);
    expect(p.currentParticipations.map((c: { tournament: { id: string } }) => c.tournament.id)).toEqual([x.estatal, x.liga]);
  });

  it('posiciones: la actual coincide con GET /standings; la final solo si es verificable', async () => {
    const p = await profile(x.dm);
    const liga = p.competitions.find((c: { tournament: { id: string } }) => c.tournament.id === x.liga);
    const table = (await api().get(`/api/tournaments/${x.liga}/standings`).expect(200)).body;
    const row = table.find((r: { teamId: string }) => r.teamId === x.dm);
    expect(liga.standing).toEqual({ position: row.position, teams: table.length, points: row.points });
    expect(liga.finalStanding).toBeNull(); // torneo en curso
    const copa = p.competitions.find((c: { tournament: { id: string } }) => c.tournament.id === x.copa);
    expect(copa).toMatchObject({ standing: null, finalStanding: { position: 1, teams: 3, points: 4 } });
    const estatal = p.competitions.find((c: { tournament: { id: string } }) => c.tournament.id === x.estatal);
    expect(estatal).toMatchObject({ standing: null, finalStanding: null });
  });

  it('honors: campeón de la liga finalizada, completa y sin empate; nada de torneos activos', async () => {
    expect((await profile(x.dm)).honors).toEqual([{ type: 'CHAMPION', tournament: { id: x.copa, name: expect.any(String) }, year: 2026, decidedBy: 'LEAGUE_TABLE' }]);
    expect((await profile(x.r2)).honors).toEqual([]); // 2º en la copa
    expect((await profile(x.tg)).honors).toEqual([]); // su único torneo sigue en curso
  });

  it('plantillas por torneo: contexto explícito y membership histórico conservado', async () => {
    const p = await profile(x.dm);
    const byT = Object.fromEntries(
      p.rosters.map((r: { tournament: { id: string }; players: { player: { id: string } }[] }) => [r.tournament.id, r]),
    );
    expect(Object.keys(byT).sort()).toEqual([x.copa, x.liga].sort());
    expect(byT[x.copa].players.map((e: { player: { id: string }; active: boolean; goals: number }) => [e.player.id, e.active, e.goals])).toEqual([
      [x.juan, true, 2],
    ]);
    // Liga: Luis sigue; Pedro se dio de baja pero no desaparece de la historia (jugó y marcó).
    expect(
      byT[x.liga].players.map((e: { player: { id: string }; active: boolean; jerseyNumber: number; appearances: number; goals: number }) => [
        e.player.id,
        e.active,
        e.jerseyNumber,
        e.appearances,
        e.goals,
      ]),
    ).toEqual([
      [x.luis, true, 5, 0, 0], // su gol fue en el partido LIVE: no cuenta
      [x.pedro, false, 7, 1, 1],
    ]);
  });

  it('goleadores: solo los goles con ESTE equipo (Juan: 2 con DM, 1 con Tigres, 3 en su carrera)', async () => {
    const dm = await profile(x.dm);
    expect(dm.topScorers.map((s: { player: { id: string }; goals: number }) => [s.player.id, s.goals])).toEqual([
      [x.juan, 2],
      [x.pedro, 1],
    ]);
    const tg = await profile(x.tg);
    expect(tg.topScorers.map((s: { player: { id: string }; goals: number }) => [s.player.id, s.goals])).toEqual([[x.juan, 1]]);
    const juan = (await api().get(`/api/players/${x.juan}/profile`).expect(200)).body;
    expect(juan.career.goals).toBe(3);
  });

  it('partidos recientes (FINISHED, más reciente primero) y próximos', async () => {
    const p = await profile(x.dm);
    expect(p.recentMatches.map((m: { id: string }) => m.id)).toEqual([x.l2, x.l1, x.c2, x.c1]);
    expect(p.recentMatches[0]).toMatchObject({
      date: '2027-01-23',
      status: 'FINISHED',
      tournament: { id: x.liga },
      homeTeam: { id: x.dm },
      awayTeam: { id: x.r3 },
      homeScore: 0,
      awayScore: 2,
      result: 'L',
    });
    expect(p.recentMatches[1]).toMatchObject({ homeTeam: { id: x.tg }, awayTeam: { id: x.dm }, result: 'W' });
    expect(p.upcomingMatches.map((m: { id: string; status: string }) => [m.id, m.status])).toEqual([
      [x.live, 'LIVE'],
      [x.sched, 'SCHEDULED'],
    ]);
    expect(p.form).toEqual(['W', 'D', 'W', 'L']);
  });

  it('historial por año de inicio del torneo', async () => {
    const p = await profile(x.dm);
    expect(
      p.history.map((h: { year: string; competitions: { tournament: { id: string } }[] }) => [h.year, h.competitions.map((c) => c.tournament.id)]),
    ).toEqual([
      ['2028', [x.estatal]],
      ['2027', [x.liga]],
      ['2026', [x.copa]],
    ]);
  });
});

describe('GET /teams/:id/matches (paginado en la base)', () => {
  it('solo FINISHED, más reciente primero, con total y contexto embebido', async () => {
    const page1 = (await api().get(`/api/teams/${x.dm}/matches?page=1&limit=3`).expect(200)).body;
    expect(page1.meta).toMatchObject({ total: 4, page: 1, limit: 3 });
    expect(page1.data.map((m: { id: string }) => m.id)).toEqual([x.l2, x.l1, x.c2]);
    expect(page1.data[0]).toMatchObject({ tournament: { id: x.liga }, homeTeam: { id: x.dm }, result: 'L' });
    const page2 = (await api().get(`/api/teams/${x.dm}/matches?page=2&limit=3`).expect(200)).body;
    expect(page2.data.map((m: { id: string }) => m.id)).toEqual([x.c1]);
    await api().get('/api/teams/64b000000000000000000000/matches').expect(404);
  });
});

describe('Lecturas heredadas: la plantilla siempre con contexto de torneo', () => {
  it('GET /teams/:id agrupa las plantillas actuales por torneo (sin torneos finalizados)', async () => {
    const t = (await api().get(`/api/teams/${x.dm}`).expect(200)).body;
    expect(t).not.toHaveProperty('roster');
    expect(t.currentRosters.map((r: { tournament: { id: string } }) => r.tournament.id)).toEqual([x.liga]);
    expect(t.currentRosters[0].players.map((r: { player: { id: string } }) => r.player.id)).toEqual([x.luis]);
  });

  it('GET /teams/:id/roster sin torneo excluye torneos finalizados; con torneo, la de ese torneo', async () => {
    const current = (await api().get(`/api/teams/${x.dm}/roster`).expect(200)).body;
    expect(current.map((r: { player: { id: string } }) => r.player.id)).toEqual([x.luis]); // Juan (Copa finalizada) ya no
    const copa = (await api().get(`/api/teams/${x.dm}/roster?tournamentId=${x.copa}`).expect(200)).body;
    expect(copa.map((r: { player: { id: string } }) => r.player.id)).toEqual([x.juan]);
  });
});

describe('Privacidad del perfil del equipo', () => {
  it('ningún endpoint público de equipo expone datos personales ni administrativos', async () => {
    for (const url of [
      `/api/teams/${x.dm}/profile`,
      `/api/teams/${x.dm}`,
      `/api/teams/${x.dm}/matches`,
      `/api/teams/${x.dm}/roster`,
      `/api/teams/${x.dm}/roster?tournamentId=${x.copa}`,
      `/api/teams/${x.dm}/memberships`,
      '/api/teams?limit=100',
    ]) {
      const body = (await api().get(url).expect(200)).body;
      expect({ url, leaks: forbiddenKeys(body) }).toEqual({ url, leaks: [] });
    }
    // Los jugadores del perfil llevan edad, no fecha de nacimiento.
    const p = await profile(x.dm);
    expect(p.rosters[0].players[0].player).toEqual({
      id: expect.any(String),
      firstName: expect.any(String),
      lastName: expect.any(String),
      nickname: null, // apodo: público y opcional
      position: 'FORWARD',
      photoUrl: null,
      age: expect.any(Number),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(p.competitions[0].tournament).not.toHaveProperty('settings');
  });
});

describe('Estadísticas de jugadores del equipo (tops, ver más y tarjetas)', () => {
  it('playerStats: todos los que jugaron, con tarjetas y el partido en que las vio', async () => {
    const t = await tournament(A, '2027-01-10');
    const team = await newTeam(A, 'Disciplina FC');
    const rival = await newTeam(A, 'Rival Disciplina');
    for (const id of [team, rival]) await enroll(A, t, id);
    const p1 = await newPlayer(A, 'Duro');
    const p2 = await newPlayer(A, 'Limpio');
    await register(A, t, p1, team, 4);
    await register(A, t, p2, team, 10);
    const m1 = await match(A, t, 1, team, rival, '2027-01-16');
    await result(A, m1, 2, 0, [
      { playerId: p1, teamId: team, goals: 0, assists: 1, yellowCards: 1, redCards: 0 },
      { playerId: p2, teamId: team, goals: 2, assists: 0, yellowCards: 0, redCards: 0 },
    ]);
    const m2 = await match(A, t, 2, rival, team, '2027-01-23');
    await result(A, m2, 1, 0, [{ playerId: p1, teamId: team, goals: 0, assists: 0, yellowCards: 1, redCards: 1 }]);

    const body = await profile(team);
    const rows = body.playerStats as { player: { id: string }; appearances: number; goals: number; yellowCards: number; redCards: number; cards: { match: { id: string; opponent: { id: string } }; yellow: number; red: number }[] }[];
    expect(rows.map((r) => r.player.id)).toEqual([p2, p1]); // por goles
    const duro = rows.find((r) => r.player.id === p1)!;
    expect(duro).toMatchObject({ appearances: 2, goals: 0, yellowCards: 2, redCards: 1, conceded: 1, cleanSheets: 1 }); // 2-0 y 1-0 en contra
    expect(duro.cards.map((c) => [c.match.id, c.yellow, c.red, c.match.opponent.id])).toEqual([
      [m2, 1, 1, rival], // más reciente primero
      [m1, 1, 0, rival],
    ]);
    expect(rows.find((r) => r.player.id === p2)!.cards).toEqual([]);
    expect(forbiddenKeys(body.playerStats)).toEqual([]);
  });
});

describe('Récords del equipo', () => {
  it('mayor victoria y derrota, porterías en cero, mejor y peor torneo', async () => {
    const team = await newTeam(A, 'Récords FC');
    const rival = await newTeam(A, 'Rival Récords');
    const t1 = await tournament(A, '2027-02-01');
    const t2 = await tournament(A, '2027-06-01');
    for (const t of [t1, t2]) for (const id of [team, rival]) await enroll(A, t, id);
    const play = async (t: string, round: number, home: boolean, own: number, other: number, date: string) => {
      const m = await match(A, t, round, home ? team : rival, home ? rival : team, date);
      await result(A, m, home ? own : other, home ? other : own);
      return m;
    };
    await play(t1, 1, true, 2, 0, '2027-02-06');
    const big = await play(t1, 2, false, 5, 1, '2027-02-13'); // visitante: 1-5
    await play(t1, 3, true, 4, 0, '2027-02-20'); // misma diferencia (+4), menos goles que el 5-1
    const worst = await play(t2, 1, true, 0, 3, '2027-06-06');
    await play(t2, 2, false, 1, 1, '2027-06-13');

    const r = (await profile(team)).records;
    expect(r.biggestWin).toMatchObject({ goalsFor: 5, goalsAgainst: 1, match: { id: big } });
    expect(r.biggestLoss).toMatchObject({ goalsFor: 0, goalsAgainst: 3, match: { id: worst } });
    expect(r.cleanSheets).toEqual({ count: 2, played: 5, rate: 40 });
    expect(r.bestTournament).toMatchObject({ tournament: { id: t1 }, pointsPerMatch: 3 });
    expect(r.worstTournament).toMatchObject({ tournament: { id: t2 }, pointsPerMatch: 0.5 });
  });
});
