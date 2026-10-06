/**
 * Etapa 6D — POST /teams/:id/managers por email responde 404 si no hay cuenta (la misma información
 * que ya revela el registro público). Para impedir sondeos masivos se limita como login/registro
 * (throttler "credentials", por IP). Límite bajo en este archivo para comprobarlo.
 */
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { TeamAdminsService } from '../src/modules/teams/team-admins.service.js';

let ctx: TestApp;
let http: Server;

beforeAll(async () => {
  ctx = await createTestApp({ AUTH_THROTTLE_LIMIT: '3' });
  http = ctx.app.getHttpServer();
});
afterAll(async () => ctx?.close());

it('más de 3 altas de delegado por minuto desde la misma IP → 429 (sondeo de correos limitado)', async () => {
  const owner = await registerOrganizer(http, 'Dueño');
  const team = (await authed(http, owner.token).post('/api/teams').send({ name: 'Equipo Limitado' }).expect(201)).body.id;
  await ctx.app.get(TeamAdminsService).assignOwner(team, owner.id);
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    statuses.push((await authed(http, owner.token).post(`/api/teams/${team}/managers`).send({ email: `nadie${i}@example.com` })).status);
  }
  expect(statuses).toEqual([404, 404, 404, 429, 429]);
  // El resto de la administración no está limitado por este throttler.
  await authed(http, owner.token).get(`/api/teams/${team}/admins`).expect(200);
});
