/**
 * Autogoles (2026-10-04): quedan registrados al jugador que los hizo, suman al marcador del RIVAL y
 * nunca cuentan como goles suyos (goleadores, perfiles). API real.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let token: string;
const as = () => authed(http, token);

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  token = (await registerOrganizer(http, 'Autogoles')).token;
});
afterAll(async () => ctx?.close());

it('el autogol suma al rival, se guarda y no cuenta como gol del jugador', async () => {
  const t = (await as().post('/api/tournaments').send({ name: 'Liga AG', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id;
  const [home, away] = [
    (await as().post('/api/teams').send({ name: 'Local AG' }).expect(201)).body.id,
    (await as().post('/api/teams').send({ name: 'Visita AG' }).expect(201)).body.id,
  ];
  for (const id of [home, away]) await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  const defender = (await as().post('/api/players').send({ firstName: 'Defensa', lastName: 'Despistado', position: 'DEFENDER', confirmNew: true }).expect(201)).body.id;
  const striker = (await as().post('/api/players').send({ firstName: 'Delantero', lastName: 'Visitante', position: 'FORWARD', confirmNew: true }).expect(201)).body.id;
  await as().put(`/api/tournaments/${t}/players/${defender}`).send({ teamId: home }).expect(200);
  await as().put(`/api/tournaments/${t}/players/${striker}`).send({ teamId: away }).expect(200);
  const m = (await as().post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: home, awayTeamId: away, date: '2027-01-10', time: '18:00' }).expect(201)).body.id;
  const stat = (playerId: string, teamId: string, goals: number, ownGoals: number) => ({ playerId, teamId, goals, assists: 0, ownGoals, yellowCards: 0, redCards: 0 });

  // El defensa local mete un autogol: el visitante gana 0-2 (1 del delantero + 1 autogol).
  const bad = await as().put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 1, playerStats: [stat(defender, home, 0, 1), stat(striker, away, 1, 0)] }).expect(400);
  expect(JSON.stringify(bad.body.message)).toMatch(/autogoles del rival incluidos/);
  await as().put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 2, playerStats: [stat(defender, home, 0, 1), stat(striker, away, 1, 0)] }).expect(200);

  const stats = (await request(http).get(`/api/matches/${m}/stats`).expect(200)).body as { playerId: string; goals: number; ownGoals: number }[];
  expect(stats.find((s) => s.playerId === defender)).toMatchObject({ goals: 0, ownGoals: 1 });
  const scorers = (await request(http).get(`/api/tournaments/${t}/top-scorers`).expect(200)).body as { playerId?: string; player?: { id: string }; goals: number }[];
  const ids = scorers.map((s) => s.playerId ?? s.player?.id);
  expect(ids).toEqual([striker]); // el autogol no lo hace goleador
});
