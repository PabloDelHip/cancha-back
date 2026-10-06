/**
 * Perfil de PORTERO (2026-10-05): goles recibidos, porterías en cero, promedio, racha sin recibir,
 * desglose por torneo/año/equipo, hitos y mejores partidos. Un delantero no lo recibe. API real.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let token: string;
const as = () => authed(http, token);
const profile = async (id: string) => (await request(http).get(`/api/players/${id}/profile`).expect(200)).body;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  token = (await registerOrganizer(http, 'Porteros')).token;
});
afterAll(async () => ctx?.close());

it('portero: recibidos, en cero, promedio, racha, hitos y mejores partidos; un delantero no tiene bloque de portero', async () => {
  const t = (await as().post('/api/tournaments').send({ name: 'Liga GK', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id;
  const [mine, rival] = [(await as().post('/api/teams').send({ name: 'Mi Equipo GK' }).expect(201)).body.id, (await as().post('/api/teams').send({ name: 'Rival GK' }).expect(201)).body.id];
  for (const id of [mine, rival]) await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  const gk = (await as().post('/api/players').send({ firstName: 'Muro', lastName: 'Portero', position: 'GOALKEEPER', confirmNew: true }).expect(201)).body.id;
  const fw = (await as().post('/api/players').send({ firstName: 'Nueve', lastName: 'Delantero', position: 'FORWARD', confirmNew: true }).expect(201)).body.id;
  for (const p of [gk, fw]) await as().put(`/api/tournaments/${t}/players/${p}`).send({ teamId: mine }).expect(200);

  // Mi equipo: 2-0 (local), 0-0 (visita), 1-3 (local), 1-0 (visita). El portero juega todos.
  const plays: [boolean, number, number][] = [[true, 2, 0], [false, 0, 0], [true, 1, 3], [false, 0, 1]];
  const ids: string[] = [];
  for (const [i, [isHome, hs, as_]] of plays.entries()) {
    const m = (await as().post('/api/matches').send({ tournamentId: t, round: i + 1, homeTeamId: isHome ? mine : rival, awayTeamId: isHome ? rival : mine, date: `2027-01-1${i}`, time: '18:00' }).expect(201)).body.id;
    ids.push(m);
    const stat = (playerId: string, goals = 0) => ({ playerId, teamId: mine, goals, assists: 0, yellowCards: 0, redCards: 0 });
    await as().put(`/api/matches/${m}/result`).send({ homeScore: hs, awayScore: as_, playerStats: [stat(gk), stat(fw, isHome ? hs : as_)] }).expect(200);
  }

  const g = (await profile(gk)).goalkeeping;
  // Recibidos: 0 + 0 + 3 + 0 = 3 en 4 PJ; en cero: 3 (75 %); racha: los dos primeros.
  expect(g.career).toEqual({ appearances: 4, conceded: 3, cleanSheets: 3, concededPerMatch: 0.75, cleanSheetRate: 75 });
  expect(g.longestCleanSheetStreak).toMatchObject({ value: 2, from: '2027-01-10', to: '2027-01-11' });
  expect(g.byTournament).toEqual([{ tournamentId: t, appearances: 4, conceded: 3, cleanSheets: 3, concededPerMatch: 0.75, cleanSheetRate: 75 }]);
  expect(g.milestones.map((m: { type: string }) => m.type)).toEqual(['FIRST_CLEAN_SHEET']);
  // Mejores: porterías en cero, victorias primero (2-0 y 1-0), luego el 0-0.
  expect(g.bestMatches.map((m: { id: string }) => m.id)).toEqual([ids[3], ids[0], ids[1]]);
  expect((await profile(fw)).goalkeeping).toBeNull();
});
