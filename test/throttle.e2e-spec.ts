/**
 * Rate limit en memoria de autenticación: login/registro y refresh tienen límites separados
 * (cada carga de página hace un refresh, así que su límite es más holgado).
 */
import request from 'supertest';
import { createTestApp, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;

beforeAll(async () => {
  ctx = await createTestApp({
    AUTH_THROTTLE_LIMIT: '3',
    AUTH_REFRESH_THROTTLE_LIMIT: '5',
    AUTH_THROTTLE_TTL: '60',
  });
  http = ctx.app.getHttpServer();
});
afterAll(async () => ctx?.close());

it('bloquea intentos excesivos de login con 429 sin afectar refresh ni la lectura pública', async () => {
  const attempt = () =>
    request(http)
      .post('/api/auth/login')
      .send({ email: 'x@example.com', password: 'incorrecta' });
  for (let i = 0; i < 3; i++) await attempt().expect(401);
  await attempt().expect(429);

  await request(http).post('/api/auth/refresh').expect(401); // límite propio, no agotado
  await request(http).get('/api/tournaments').expect(200);
});

it('el refresh tiene su propio límite', async () => {
  for (let i = 0; i < 4; i++)
    await request(http).post('/api/auth/refresh').expect(401);
  await request(http).post('/api/auth/refresh').expect(429);
});
