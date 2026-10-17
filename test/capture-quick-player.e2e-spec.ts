/**
 * Alta rápida de un jugador desde la captura del partido (2026-10-12): alguien jugó y no estaba
 * registrado. El front reutiliza los endpoints de siempre (crear jugador con revisión de duplicados,
 * inscribirlo en el equipo del torneo, capturar); esta prueba fija ese flujo y sus permisos.
 */
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, SCO: U;
const as = (u: U) => authed(http, u.token);

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, SCO] = [await registerOrganizer(http, 'DueñoAlta'), await registerOrganizer(http, 'AnotaAlta')];
});
afterAll(async () => ctx?.close());

it('solo nombre y apellidos: se crea, se inscribe en el equipo y cuenta en la captura de un partido ya jugado', async () => {
  const t = (await as(O).post('/api/tournaments').send({ name: 'Alta rápida', format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE' }).expect(201)).body.id;
  const [home, away] = [(await as(O).post('/api/teams').send({ name: 'Rápidos' }).expect(201)).body.id, (await as(O).post('/api/teams').send({ name: 'Lentos' }).expect(201)).body.id];
  for (const id of [home, away]) await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  // Partido de hace semanas: el jugador se registra hoy.
  const m = (await as(O).post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: home, awayTeamId: away, date: '2026-09-05', time: '10:00' }).expect(201)).body.id;

  const player = (await as(O).post('/api/players').send({ firstName: 'Nuevo', lastName: 'Del Día', position: 'MIDFIELDER', birthDate: null }).expect(201)).body;
  // 3A: inscrito hoy no es elegible para un partido anterior; el alta rápida lo inscribe con
  // elegibilidad retroactiva a la fecha del partido y el motivo que escribe el organizador.
  await as(O).put(`/api/tournaments/${t}/players/${player.id}`).send({ teamId: home, jerseyNumber: 23 }).expect(200);
  const capture = { homeScore: 1, awayScore: 0, status: 'FINISHED', playerStats: [{ playerId: player.id, teamId: home, goals: 1, assists: 0, yellowCards: 0, redCards: 0, sendOff: null }] };
  await as(O).put(`/api/matches/${m}/result`).send(capture).expect(400);
  await as(O).put(`/api/tournaments/${t}/players/${player.id}`).send({ teamId: home, jerseyNumber: 23, startDate: '2026-09-05', retroactiveReason: 'Jugó este partido sin estar inscrito' }).expect(200);
  await as(O)
    .put(`/api/matches/${m}/result`)
    .send({ homeScore: 1, awayScore: 0, status: 'FINISHED', playerStats: [{ playerId: player.id, teamId: home, goals: 1, assists: 0, yellowCards: 0, redCards: 0, sendOff: null }] })
    .expect(200);
  const profile = (await as(O).get(`/api/players/${player.id}/profile`).expect(200)).body;
  expect(JSON.stringify(profile)).toContain('Alta rápida');

  // Mismo nombre otra vez: el servidor avisa de un posible duplicado antes de crear otro.
  const dup = await as(O).post('/api/players').send({ firstName: 'Nuevo', lastName: 'Del Día', position: 'MIDFIELDER', birthDate: null }).expect(409);
  expect(JSON.stringify(dup.body)).toContain(player.id);

  // El anotador captura, pero inscribir jugadores exige el permiso de equipos (TEAMS): no se amplía.
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role: 'SCORER' }).expect(201)).body;
  await as(SCO).post(`/api/invitations/${inv.token}/accept`).expect(200);
  const other = (await as(SCO).post('/api/players').send({ firstName: 'Otro', lastName: 'Anotado', position: 'MIDFIELDER', birthDate: null }).expect(201)).body;
  await as(SCO).put(`/api/tournaments/${t}/players/${other.id}`).send({ teamId: home }).expect(403);
});
