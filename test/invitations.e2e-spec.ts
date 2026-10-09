/**
 * Invitaciones a colaborar (RBAC R2, 2026-10-10): enlace de un solo uso con vencimiento, cuenta
 * existente con respuesta uniforme, aceptación atómica, revocación, límites y permisos. API real.
 */
import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, A: U, B: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());

let seq = 0;
async function tournament(owner = O) {
  return (await as(owner).post('/api/tournaments').send({ name: `Invitaciones ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
}
const link = async (t: string, role = 'SCORER', by = O) => (await as(by).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body as { id: string; token: string };

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, A, B] = [await registerOrganizer(http, 'Invita'), await registerOrganizer(http, 'Invitado'), await registerOrganizer(http, 'Otro')];
});
afterAll(async () => ctx?.close());

it('enlace: token una sola vez, guardado como hash, vista previa pública, un solo uso', async () => {
  const t = await tournament();
  const inv = await link(t, 'COORDINATOR');
  expect(inv.token).toMatch(/^[\w-]{32}$/);
  const stored = await db().collection('tournament_invitations').findOne({ _id: new Types.ObjectId(inv.id) });
  expect(stored!.tokenHash).toHaveLength(64);
  expect(JSON.stringify(stored)).not.toContain(inv.token);
  expect(JSON.stringify((await as(O).get(`/api/tournaments/${t}/invitations`).expect(200)).body)).not.toContain(inv.token);

  const preview = (await request(http).get(`/api/invitations/${inv.token}`).expect(200)).body;
  expect(preview).toMatchObject({ role: 'COORDINATOR', status: 'PENDING', tournament: { id: t }, invitedBy: expect.stringContaining('Invita') });
  await request(http).get('/api/invitations/token-inventado-xxxxxxxxxxxxxxxxx').expect(404);
  await request(http).post(`/api/invitations/${inv.token}/accept`).expect(401);

  expect((await as(A).post(`/api/invitations/${inv.token}/accept`).expect(200)).body).toMatchObject({ tournamentId: t, role: 'COORDINATOR' });
  expect((await as(B).post(`/api/invitations/${inv.token}/accept`).expect(409)).body.message).toMatch(/ya se usó/);
  expect((await request(http).get(`/api/invitations/${inv.token}`).expect(200)).body.status).toBe('ACCEPTED');
  expect((await as(A).get('/api/admin/tournaments').expect(200)).body.data.map((x: { id: string }) => x.id)).toContain(t);
});

it('vencimiento y revocación', async () => {
  const t = await tournament();
  const old = await link(t);
  await db().collection('tournament_invitations').updateOne({ _id: new Types.ObjectId(old.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  expect((await request(http).get(`/api/invitations/${old.token}`).expect(200)).body.status).toBe('EXPIRED');
  expect((await as(A).post(`/api/invitations/${old.token}/accept`).expect(409)).body.message).toMatch(/venció/);

  const revoked = await link(t);
  await as(A).delete(`/api/tournaments/${t}/invitations/${revoked.id}`).expect(403);
  await as(O).delete(`/api/tournaments/${t}/invitations/${revoked.id}`).expect(200);
  expect((await as(A).post(`/api/invitations/${revoked.token}/accept`).expect(409)).body.message).toMatch(/revocó/);
  await as(O).delete(`/api/tournaments/${t}/invitations/${revoked.id}`).expect(404);
});

it('por cuenta: respuesta uniforme, solo el destinatario la ve y la acepta; sirve si se registra después', async () => {
  const t = await tournament();
  const send = (email: string) => as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'ACCOUNT', role: 'ADMIN', email });
  const existing = (await send(A.email).expect(201)).body;
  const unknownEmail = `futuro${++seq}@example.com`;
  const unknown = (await send(unknownEmail).expect(201)).body;
  // Misma forma y mismos campos: no revela si el correo tiene cuenta.
  expect(Object.keys(existing).sort()).toEqual(Object.keys(unknown).sort());
  expect(existing.token).toBeUndefined();
  expect((await send(A.email).expect(201)).body.id).toBe(existing.id); // idempotente

  expect((await as(B).get('/api/me/invitations').expect(200)).body).toEqual([]);
  await as(B).post(`/api/me/invitations/${existing.id}/accept`).expect(404);
  const mine = (await as(A).get('/api/me/invitations').expect(200)).body;
  expect(mine).toEqual([expect.objectContaining({ id: existing.id, role: 'ADMIN', tournament: expect.objectContaining({ id: t }) })]);
  await as(A).post(`/api/me/invitations/${existing.id}/accept`).expect(200);
  expect((await as(A).get('/api/me/invitations').expect(200)).body).toEqual([]);

  // Registrarse después con ese correo: la invitación aparece y se puede rechazar.
  const later = (await request(http).post('/api/auth/register').send({ firstName: 'Futuro', lastName: 'X', email: unknownEmail, password: 'password123' }).expect(201)).body;
  const laterAs = authed(http, later.accessToken);
  expect((await laterAs.get('/api/me/invitations').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([unknown.id]);
  await laterAs.post(`/api/me/invitations/${unknown.id}/decline`).expect(200);
  await laterAs.post(`/api/me/invitations/${unknown.id}/accept`).expect(409);
});

it('sin autoasignación ni escalada: solo el propietario invita; propietario y colaboradores no aceptan enlaces del torneo', async () => {
  const t = await tournament();
  const first = await link(t, 'SCORER');
  await as(A).post(`/api/invitations/${first.token}/accept`).expect(200);
  // Un colaborador no invita (ni a sí mismo con más rol) y no puede subir de rol con otro enlace.
  await as(A).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role: 'ADMIN' }).expect(403);
  const admin = await link(t, 'ADMIN');
  expect((await as(A).post(`/api/invitations/${admin.token}/accept`).expect(409)).body.message).toMatch(/Ya colaboras/);
  expect((await as(O).post(`/api/invitations/${admin.token}/accept`).expect(409)).body.message).toMatch(/propietario/);
  // El enlace sigue disponible para otra persona.
  await as(B).post(`/api/invitations/${admin.token}/accept`).expect(200);
  // El alta directa de R1 ya no existe.
  await as(O).post(`/api/tournaments/${t}/members`).send({ email: B.email, role: 'ADMIN' }).expect(404);
});

it('límite de invitaciones pendientes por torneo', async () => {
  const t = await tournament();
  for (let i = 0; i < 50; i++) await link(t);
  expect((await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role: 'SCORER' }).expect(409)).body.message).toMatch(/50 invitaciones/);
});

it('carrera: dos aceptaciones simultáneas con 19 colaboradores; solo una entra (máximo 20)', async () => {
  const t = await tournament();
  for (let i = 0; i < 19; i++) {
    const u = await registerOrganizer(http, `Cupo${i}`);
    await as(u).post(`/api/invitations/${(await link(t)).token}/accept`).expect(200);
  }
  const [l1, l2] = [await link(t), await link(t)];
  const results = await Promise.all([as(A).post(`/api/invitations/${l1.token}/accept`), as(B).post(`/api/invitations/${l2.token}/accept`)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await db().collection('tournament_members').countDocuments({ tournamentId: new Types.ObjectId(t), status: 'ACTIVE' })).toBe(20);
});

it('carrera: el mismo enlace aceptado por dos personas a la vez; un solo colaborador', async () => {
  const t = await tournament();
  const inv = await link(t);
  const results = await Promise.all([as(A).post(`/api/invitations/${inv.token}/accept`), as(B).post(`/api/invitations/${inv.token}/accept`)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await db().collection('tournament_members').countDocuments({ tournamentId: new Types.ObjectId(t), status: 'ACTIVE' })).toBe(1);
});
