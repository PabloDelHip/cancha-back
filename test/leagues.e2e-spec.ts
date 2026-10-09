/**
 * Ligas (2026-10-06): todo torneo vive en una liga de su organizador; la liga junta el histórico de
 * sus torneos (campeones, tabla histórica, jugadores, porteros, récords). API real.
 */
import request from 'supertest';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type Org = Awaited<ReturnType<typeof registerOrganizer>>;
let A: Org;
let B: Org;
const as = (o: Org) => authed(http, o.token);
const api = () => request(http);
let seq = 0;

async function tournament(o: Org, body: Record<string, unknown>) {
  return (await as(o).post('/api/tournaments').send({ name: `T${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', ...body }).expect(201)).body;
}
async function team(o: Org, t: string, name: string) {
  const id = (await as(o).post('/api/teams').send({ name: `${name} ${++seq}` }).expect(201)).body.id as string;
  await as(o).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  return id;
}
async function player(o: Org, t: string, teamId: string, position: string) {
  const id = (await as(o).post('/api/players').send({ firstName: 'J', lastName: `L${++seq}`, position, confirmNew: true }).expect(201)).body.id as string;
  await as(o).put(`/api/tournaments/${t}/players/${id}`).send({ teamId }).expect(200);
  return id;
}
async function play(o: Org, t: string, home: string, away: string, hs: number, as_: number, stats: unknown[] = [], round = 1) {
  const m = (await as(o).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date: `2027-01-1${round}`, time: '18:00' }).expect(201)).body.id;
  await as(o).put(`/api/matches/${m}/result`).send({ homeScore: hs, awayScore: as_, playerStats: stats }).expect(200);
  return m as string;
}
const st = (playerId: string, teamId: string, goals = 0) => ({ playerId, teamId, goals, assists: 0, yellowCards: 0, redCards: 0 });

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Liguero');
  B = await registerOrganizer(http, 'Otro');
});
afterAll(async () => ctx?.close());

describe('Ligas: dueño y torneos', () => {
  it('crear liga, crear torneos dentro; sin liga → liga por defecto; ajeno → 403; borrar solo vacía', async () => {
    const league = (await as(A).post('/api/leagues').send({ name: 'Liga MX Amateur', city: 'Mazatlán, Sin.' }).expect(201)).body;
    expect(league).toMatchObject({ name: 'Liga MX Amateur', isDefault: false });
    expect(league).not.toHaveProperty('organizerId');

    const t = await tournament(A, { leagueId: league.id, name: 'Apertura 2027' });
    expect(t.leagueId).toBe(league.id);
    const loose = await tournament(A, { name: 'Sin liga' });
    const mine = (await as(A).get('/api/admin/leagues').expect(200)).body as { id: string; isDefault: boolean; tournaments: number }[];
    const def = mine.find((l) => l.isDefault)!;
    expect(loose.leagueId).toBe(def.id);
    expect(mine.find((l) => l.id === league.id)!.tournaments).toBe(1);

    // Otro organizador: no crea torneos en mi liga, ni la edita ni la borra; tampoco mueve sus torneos a ella.
    await as(B).post('/api/tournaments').send({ leagueId: league.id, name: 'X', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01' }).expect(403);
    await as(B).patch(`/api/leagues/${league.id}`).send({ name: 'Mía' }).expect(403);
    const bt = await tournament(B, {});
    await as(B).patch(`/api/tournaments/${bt.id}`).send({ leagueId: league.id }).expect(403);

    // Mover un torneo a otra liga propia; borrar solo una liga vacía.
    await as(A).patch(`/api/tournaments/${loose.id}`).send({ leagueId: league.id }).expect(200);
    const raw = await ctx.app.get(getModelToken('Tournament')).collection.findOne({ name: 'Sin liga' });
    expect(raw?.leagueId?.constructor?.name).toBe('ObjectId'); // se guarda como id, no como texto
    await as(A).delete(`/api/leagues/${league.id}`).expect(409);
    await as(A).delete(`/api/leagues/${def.id}`).expect(204);

    const pub = (await api().get(`/api/leagues/${league.id}`).expect(200)).body;
    expect(pub.tournaments.map((x: { id: string }) => x.id).sort()).toEqual([t.id, loose.id].sort());
    expect((await api().get('/api/leagues').expect(200)).body.some((l: { id: string }) => l.id === league.id)).toBe(true);
  });

  it('liga por defecto: "Liga de <nombre>", o el nombre tal cual si la cuenta ya se llama "Liga …"', async () => {
    const reg = async (firstName: string, lastName: string) => {
      const r = await api().post('/api/auth/register').send({ firstName, lastName, email: `n${++seq}@x.test`, password: 'password123' }).expect(201);
      const o = { id: r.body.user.id, token: r.body.accessToken } as Org;
      await as(o).post('/api/me/organizer').expect(200);
      await tournament(o, {});
      return ((await as(o).get('/api/admin/leagues').expect(200)).body as { name: string }[])[0]!.name;
    };
    expect(await reg('Ana', 'Pérez')).toBe('Liga de Ana Pérez');
    expect(await reg('Liga', 'Norte Fut 7')).toBe('Liga Norte Fut 7');
  });

  it('crear una liga exige poder organizar', async () => {
    const res = await api().post('/api/auth/register').send({ firstName: 'Sin', lastName: 'Organizar', email: `sin${++seq}@x.test`, password: 'password123' }).expect(201);
    const r = await authed(http, res.body.accessToken).post('/api/leagues').send({ name: 'Nope' }).expect(403);
    expect(r.body.code).toBe('ORGANIZER_NOT_ENABLED');
  });
});

describe('Histórico de la liga', () => {
  it('campeones, más campeón, tabla histórica, goleadores, porteros y récords con dos torneos', async () => {
    const league = (await as(A).post('/api/leagues').send({ name: 'Liga Histórica' }).expect(201)).body.id as string;
    // Torneo 1 (liga): Rojo gana los dos partidos → campeón.
    const t1 = (await tournament(A, { leagueId: league, name: 'Apertura', startDate: '2026-01-01' })).id as string;
    const [rojo, azul, verde] = [await team(A, t1, 'Rojo'), await team(A, t1, 'Azul'), await team(A, t1, 'Verde')];
    const nueve = await player(A, t1, rojo, 'FORWARD');
    const portero = await player(A, t1, rojo, 'GOALKEEPER');
    await play(A, t1, rojo, azul, 5, 0, [st(nueve, rojo, 3), st(portero, rojo)], 1);
    await play(A, t1, verde, rojo, 1, 2, [st(nueve, rojo, 2), st(portero, rojo)], 2);
    await play(A, t1, azul, verde, 1, 1, [], 3);
    await as(A).post(`/api/tournaments/${t1}/finish`).send({}).expect(200);
    // Torneo 2 (liga) con Rojo y Azul: Azul campeón.
    const t2 = (await tournament(A, { leagueId: league, name: 'Clausura', startDate: '2026-07-01' })).id as string;
    for (const x of [rojo, azul]) await as(A).post(`/api/tournaments/${t2}/teams/${x}`).expect(201);
    await as(A).put(`/api/tournaments/${t2}/players/${nueve}`).send({ teamId: rojo }).expect(200);
    await play(A, t2, azul, rojo, 1, 0, [st(nueve, rojo, 0)], 1);
    await as(A).post(`/api/tournaments/${t2}/finish`).send({}).expect(200);

    const h = (await api().get(`/api/leagues/${league}/history`).expect(200)).body;
    expect(h.summary).toMatchObject({ tournaments: 2, finished: 2, matches: 4, goals: 11 });
    // Campeones, el más reciente primero.
    expect(h.champions.map((c: { tournament: { name: string }; champion: { id: string } }) => [c.tournament.name, c.champion.id])).toEqual([
      ['Clausura', azul],
      ['Apertura', rojo],
    ]);
    expect(h.champions[1].topScorer).toMatchObject({ player: { id: nueve }, goals: 5 });
    // Tabla histórica (3/1/0): Rojo 2G 1P = 6 pts; Azul 1G 1E 1P = 4; Verde 1E 1P = 1.
    expect(h.teams.map((r: { team: { id: string }; points: number; titles: number }) => [r.team.id, r.points, r.titles])).toEqual([
      [rojo, 6, 1],
      [azul, 4, 1],
      [verde, 1, 0],
    ]);
    // Jugadores: el 9 con 5 goles en 3 partidos y 2 torneos; el portero recibió 1 en 2 partidos.
    expect(h.players[0]).toMatchObject({ player: { id: nueve }, goals: 5, appearances: 3, tournaments: 2 });
    expect(h.keepers).toEqual([expect.objectContaining({ player: expect.objectContaining({ id: portero }), appearances: 2, conceded: 1, cleanSheets: 1 })]);
    expect(h.records.biggestWin).toMatchObject({ homeScore: 5, awayScore: 0 });
    expect(h.records.highestScoring).toMatchObject({ homeScore: 5, awayScore: 0 });
  });
});
