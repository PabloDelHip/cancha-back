/**
 * Autenticación: registro, login, JWT, refresh con rotación, logout y exposición de datos.
 */
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import request from 'supertest';
import { AuthSession } from '../src/modules/auth/schemas/auth-session.schema.js';
import { User } from '../src/modules/users/schemas/user.schema.js';
import {
  authed,
  createTestApp,
  refreshCookie,
  type Server,
  type TestApp,
} from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
});
afterAll(async () => ctx?.close());

const pablo = {
  firstName: 'Pablo',
  lastName: 'Hipólito',
  email: 'pablo@example.com',
  password: 'password123',
};
const credentials = { email: pablo.email, password: pablo.password };

const refresh = (cookie?: string) => {
  const req = api().post('/api/auth/refresh');
  return cookie ? req.set('Cookie', cookie) : req;
};

/** Ninguna respuesta debe filtrar el hash ni la contraseña. */
function expectNoSecrets(body: unknown) {
  const json = JSON.stringify(body);
  expect(json).not.toMatch(/passwordHash|\$argon2|password123|refreshToken/);
}

describe('Registro', () => {
  it('crea la cuenta, devuelve usuario seguro + access token y fija la cookie HttpOnly', async () => {
    const res = await api()
      .post('/api/auth/register')
      .send({ ...pablo, email: '  Pablo@Example.COM ' })
      .expect(201);
    expect(res.body.user).toMatchObject({
      email: 'pablo@example.com',
      firstName: 'Pablo',
      role: 'ORGANIZER',
    });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(900);
    expectNoSecrets(res.body);

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find(
      (c) => c.startsWith('__session='),
    )!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).not.toMatch(/Secure/); // solo en producción

    // En la base solo hay un hash Argon2id, nunca la contraseña.
    const users = ctx.app.get<Model<User>>(getModelToken(User.name));
    const stored = await users
      .findOne({ email: 'pablo@example.com' })
      .select('+passwordHash')
      .lean();
    expect(stored!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(stored)).not.toContain('password123');
  });

  it('email duplicado (sin importar mayúsculas) → 409', async () => {
    await api()
      .post('/api/auth/register')
      .send({ ...pablo, email: 'PABLO@example.com' })
      .expect(409);
  });

  it('valida datos: email, contraseña de 8+ y sin campos extra (role)', async () => {
    await api()
      .post('/api/auth/register')
      .send({ ...pablo, email: 'no-es-email' })
      .expect(400);
    await api()
      .post('/api/auth/register')
      .send({ ...pablo, email: 'corta@example.com', password: '1234567' })
      .expect(400);
    await api()
      .post('/api/auth/register')
      .send({ ...pablo, email: 'rol@example.com', role: 'ADMIN' })
      .expect(400);
  });
});

describe('Login', () => {
  it('login correcto con email normalizado', async () => {
    const res = await api()
      .post('/api/auth/login')
      .send({ email: ' PABLO@example.com', password: pablo.password })
      .expect(200);
    expect(res.body.user.email).toBe('pablo@example.com');
    expect(refreshCookie(res)).toBeDefined();
    expectNoSecrets(res.body);
  });

  it('contraseña incorrecta o email inexistente → 401 con el mismo mensaje genérico', async () => {
    const wrongPass = await api()
      .post('/api/auth/login')
      .send({ email: pablo.email, password: 'incorrecta' })
      .expect(401);
    const unknown = await api()
      .post('/api/auth/login')
      .send({ email: 'nadie@example.com', password: 'incorrecta' })
      .expect(401);
    expect(wrongPass.body.message).toBe('Invalid credentials');
    expect(unknown.body.message).toBe('Invalid credentials');
    expect(refreshCookie(wrongPass)).toBeUndefined();
  });
});

describe('Access token', () => {
  it('endpoint protegido sin JWT, con JWT mal formado o firmado con otro secreto → 401', async () => {
    await api().get('/api/auth/me').expect(401);
    await api().get('/api/admin/tournaments').expect(401);
    await api().post('/api/tournaments').send({}).expect(401);
    await api()
      .get('/api/auth/me')
      .set('Authorization', 'Bearer basura')
      .expect(401);
    const forged = new JwtService().sign(
      { sub: '64b000000000000000000000', role: 'ORGANIZER' },
      { secret: 'otro-secreto' },
    );
    await api()
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });

  it('JWT válido → acceso; /auth/me devuelve solo datos seguros', async () => {
    const { body } = await api()
      .post('/api/auth/login')
      .send(credentials)
      .expect(200);
    const me = await authed(http, body.accessToken)
      .get('/api/auth/me')
      .expect(200);
    expect(Object.keys(me.body).sort()).toEqual([
      'createdAt',
      'email',
      'firstName',
      'id',
      'lastName',
      'role',
    ]);
    expectNoSecrets(me.body);

    // Claims mínimos
    const claims = JSON.parse(
      Buffer.from(body.accessToken.split('.')[1], 'base64url').toString(),
    );
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'role', 'sub']);
  });

  it('un access token expirado se rechaza y puede renovarse con el refresh token', async () => {
    const login = await api()
      .post('/api/auth/login')
      .send(credentials)
      .expect(200);
    const expired = ctx.app
      .get(JwtService)
      .sign(
        {
          sub: login.body.user.id,
          role: 'ORGANIZER',
          exp: Math.floor(Date.now() / 1000) - 10,
        },
        { secret: process.env.JWT_ACCESS_SECRET },
      );
    await authed(http, expired).get('/api/auth/me').expect(401);

    const renewed = await refresh(refreshCookie(login)).expect(200);
    await authed(http, renewed.body.accessToken)
      .get('/api/auth/me')
      .expect(200);
    expectNoSecrets(renewed.body);
  });
});

describe('Refresh token', () => {
  it('sin cookie o con cookie inválida → 401', async () => {
    await refresh().expect(401);
    await refresh('__session=basura').expect(401);
  });

  it('rotación: el refresh anterior deja de ser válido', async () => {
    const login = await api()
      .post('/api/auth/login')
      .send(credentials)
      .expect(200);
    const first = refreshCookie(login)!;
    const second = refreshCookie(await refresh(first).expect(200))!;
    expect(second).not.toBe(first);

    await refresh(first).expect(401); // rotado: ya no sirve
    const third = refreshCookie(await refresh(second).expect(200))!; // la sesión sigue viva
    expect(third).toBeDefined();
  });

  it('reutilizar un token rotado fuera del margen revoca la sesión (posible robo)', async () => {
    const login = await api()
      .post('/api/auth/login')
      .send(credentials)
      .expect(200);
    const stolen = refreshCookie(login)!;
    const legit = refreshCookie(await refresh(stolen).expect(200))!;

    // Simula que la rotación ocurrió hace un minuto (fuera de la tolerancia entre pestañas).
    const sessions = ctx.app.get<Model<AuthSession>>(
      getModelToken(AuthSession.name),
    );
    await sessions.updateMany({}, { rotatedAt: new Date(Date.now() - 60_000) });

    await refresh(stolen).expect(401);
    await refresh(legit).expect(401); // la sesión quedó revocada para todos
  });
});

describe('Logout', () => {
  it('logout revoca la sesión, borra la cookie y el refresh anterior ya no funciona', async () => {
    const login = await api()
      .post('/api/auth/login')
      .send(credentials)
      .expect(200);
    const cookie = refreshCookie(login)!;

    const out = await api()
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .expect(204);
    expect((out.headers['set-cookie'] as unknown as string[]).join()).toMatch(
      /__session=;.*Expires=Thu, 01 Jan 1970/,
    );

    await refresh(cookie).expect(401);
    await api().post('/api/auth/logout').expect(204); // idempotente, sin cookie
  });

  it('logout-all revoca las sesiones de todos los dispositivos', async () => {
    const phone = await api()
      .post('/api/auth/login')
      .send(credentials)
      .expect(200);
    const laptop = await api()
      .post('/api/auth/login')
      .send(credentials)
      .expect(200);

    await api().post('/api/auth/logout-all').expect(401);
    await authed(http, laptop.body.accessToken)
      .post('/api/auth/logout-all')
      .expect(204);

    await refresh(refreshCookie(phone)).expect(401);
    await refresh(refreshCookie(laptop)).expect(401);
  });
});

describe('Sesión persistente (Firebase Hosting → Cloud Run)', () => {
  const persona = { firstName: 'Sesión', lastName: 'Eterna', email: 'eterna@example.com', password: 'password123' };
  const sessions = () => ctx.app.get<Model<AuthSession>>(getModelToken(AuthSession.name));

  // En los tests JWT_REFRESH_EXPIRES_IN=7d (ver test-app); el valor por defecto (365d) se prueba en env.validation.spec.
  const TTL_MS = 7 * 86_400_000;

  it('la cookie se llama __session (la única que Firebase reenvía), HttpOnly, path /api/auth, persistente (dura lo configurado)', async () => {
    const res = await api().post('/api/auth/register').send(persona).expect(201);
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__session='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/auth/);
    expect(raw).toMatch(/SameSite=Lax/i);
    const expires = new Date(/Expires=([^;]+)/i.exec(raw)![1]).getTime();
    expect(expires - Date.now()).toBeGreaterThan(TTL_MS - 60_000);
    expect(res.headers['cache-control']).toBe('no-store'); // la CDN nunca guarda respuestas con token
  });

  it('ventana deslizante: cada refresh reinicia la caducidad completa (solo caduca tras ese tiempo sin usar la app)', async () => {
    const login = await api().post('/api/auth/login').send({ email: persona.email, password: persona.password }).expect(200);
    const cookie = refreshCookie(login)!;
    const { sub, sid } = JSON.parse(Buffer.from(login.body.accessToken.split('.')[1], 'base64url').toString()) as { sub: string; sid?: string };
    void sub;
    // Simula una sesión a punto de caducar: le quedan 2 horas.
    const latest = await sessions().findOne({}).sort({ createdAt: -1 });
    await sessions().updateOne({ _id: sid ?? latest!._id }, { $set: { expiresAt: new Date(Date.now() + 2 * 3_600_000) } });
    const res = await refresh(cookie).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const renewed = await sessions().findById(sid ?? latest!._id).lean();
    expect(renewed!.expiresAt.getTime() - Date.now()).toBeGreaterThan(TTL_MS - 60_000);
    const cookie2 = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('__session='))!;
    expect(new Date(/Expires=([^;]+)/i.exec(cookie2)![1]).getTime() - Date.now()).toBeGreaterThan(TTL_MS - 60_000);
  });

  it('migración: una cookie antigua (cancha_rt) sigue valiendo, se canjea por __session y se borra', async () => {
    const login = await api().post('/api/auth/login').send({ email: persona.email, password: persona.password }).expect(200);
    const legacy = refreshCookie(login)!.replace('__session=', 'cancha_rt=');
    const res = await refresh(legacy).expect(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    expect(cookies.some((c) => c.startsWith('__session=') && !c.startsWith('__session=;'))).toBe(true);
    expect(cookies.some((c) => /^cancha_rt=;.*Expires=Thu, 01 Jan 1970/.test(c))).toBe(true);
  });
});
