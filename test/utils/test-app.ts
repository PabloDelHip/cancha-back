import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { configureApp } from '../../src/setup.js';

const TEST_DB = 'football_app_test';

/**
 * App real (mismos módulos, guards, pipes y filtros que producción) contra un replica set
 * MongoDB en memoria: las transacciones funcionan igual que con docker-compose.
 */
export async function createTestApp(env: Record<string, string> = {}) {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  Object.assign(process.env, {
    MONGODB_URI: replSet.getUri(TEST_DB),
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef',
    JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef',
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    AUTH_THROTTLE_LIMIT: '1000',
    AUTH_REFRESH_THROTTLE_LIMIT: '1000',
    AUTH_THROTTLE_TTL: '60',
    ...env,
  });

  // ConfigModule.forRoot() lee el entorno al importarse: AppModule debe importarse
  // DESPUÉS de fijar las variables, o los tests usarían la base de desarrollo del .env.
  const { AppModule } = await import('../../src/app.module.js');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication({
    bodyParser: false,
    logger: ['error'],
  });

  const connection = app.get<Connection>(getConnectionToken());
  if (
    connection.name !== TEST_DB ||
    !replSet.getUri().includes(`${connection.host}:${connection.port}`)
  ) {
    await app.close();
    await replSet.stop();
    throw new Error(
      `Los tests no apuntan a la base en memoria (${connection.host}:${connection.port}/${connection.name}). Abortado.`,
    );
  }

  configureApp(app, { frontendUrl: 'http://localhost:5173' });
  await app.init();

  return {
    app,
    async close() {
      await app.close();
      await replSet.stop();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
export type Server = ReturnType<INestApplication['getHttpServer']>;

/** Cliente supertest que envía `Authorization: Bearer <token>` en cada petición. */
export function authed(server: Server, token: string) {
  const agent = request(server);
  const auth = `Bearer ${token}`;
  return {
    get: (url: string) => agent.get(url).set('Authorization', auth),
    post: (url: string) => agent.post(url).set('Authorization', auth),
    put: (url: string) => agent.put(url).set('Authorization', auth),
    patch: (url: string) => agent.patch(url).set('Authorization', auth),
    delete: (url: string) => agent.delete(url).set('Authorization', auth),
  };
}

/** Extrae la cookie del refresh token (`__session=...`) de una respuesta. */
export function refreshCookie(res: request.Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((c) => c.startsWith('__session='))?.split(';')[0];
}

let seq = 0;

/** Registra un organizador y devuelve su access token, cookie de refresh e id. */
export async function registerOrganizer(server: Server, name = 'Organizador') {
  seq++;
  const email = `${name.toLowerCase().replace(/\W/g, '')}${seq}@example.com`;
  const res = await request(server)
    .post('/api/auth/register')
    .send({ firstName: name, lastName: 'Test', email, password: 'password123' })
    .expect(201);
  // Estas cuentas organizan torneos: activan "Quiero organizar un torneo" (crear torneos lo exige).
  await request(server).post('/api/me/organizer').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
  return {
    id: res.body.user.id as string,
    email,
    token: res.body.accessToken as string,
    cookie: refreshCookie(res)!,
  };
}
