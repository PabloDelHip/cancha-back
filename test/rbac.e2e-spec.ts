/**
 * RBAC R1 (2026-10-10): colaboradores por torneo (ADMIN, COORDINATOR, SCORER) con la matriz de
 * permisos validada en el backend, aislamiento entre propietarios, protección del propietario,
 * límite de colaboradores, actorRole en los historiales y revocación atómica. API real.
 */
import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, A: U, C: U, S: U, X: U, O2: U;
const as = (u: U) => authed(http, u.token);

let seq = 0;
async function tournament(owner: U, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE', settings?: Record<string, unknown>) {
  seq++;
  const t = (await as(owner).post('/api/tournaments').send({ name: `RBAC ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status, ...(settings ? { settings } : {}) }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = (await as(owner).post('/api/teams').send({ name: `RB${seq}-${i}` }).expect(201)).body.id as string;
    await as(owner).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
/** Alta de colaborador por el flujo real (R2): invitación por enlace del propietario + aceptación. */
async function addMember(t: string, u: U, role: string, by = O) {
  const inv = await as(by).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role });
  if (inv.status !== 201) return inv;
  return as(u).post(`/api/invitations/${inv.body.token}/accept`);
}
const expectStatus = async (p: Promise<request.Response>, status: number) => expect((await p).status).toBe(status);
let round = 0;
const newMatch = (who: U, x: { t: string; teams: string[] }, extra: Record<string, unknown> = {}) =>
  as(who).post('/api/matches').send({ tournamentId: x.t, round: ++round, homeTeamId: x.teams[0], awayTeamId: x.teams[1], date: '2027-02-06', time: '10:00', ...extra });

let T: { t: string; teams: string[] };
let m: string;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, A, C, S, X, O2] = [await registerOrganizer(http, 'Owner'), await registerOrganizer(http, 'Admin'), await registerOrganizer(http, 'Coord'), await registerOrganizer(http, 'Scorer'), await registerOrganizer(http, 'Ajeno'), await registerOrganizer(http, 'OtroOwner')];
  T = await tournament(O);
  await expectStatus(addMember(T.t, A, 'ADMIN'), 200);
  await expectStatus(addMember(T.t, C, 'COORDINATOR'), 200);
  await expectStatus(addMember(T.t, S, 'SCORER'), 200);
  m = (await newMatch(O, T).expect(201)).body.id;
});
afterAll(async () => ctx?.close());

/** Estado esperado por rol (O, A, C, S, X) para una petición. */
async function expectMatrix(call: (u: U) => PromiseLike<request.Response>, expected: Record<'O' | 'A' | 'C' | 'S' | 'X', number>) {
  const who = { O, A, C, S, X };
  for (const [k, status] of Object.entries(expected)) {
    const res = await call(who[k as keyof typeof who]);
    expect({ role: k, status: res.status }).toEqual({ role: k, status });
  }
}

describe('matriz de permisos (validada en el backend)', () => {
  it('VIEW: panel del torneo y listado con rol', async () => {
    await expectMatrix((u) => as(u).get(`/api/admin/tournaments/${T.t}`), { O: 200, A: 200, C: 200, S: 200, X: 403 });
    const mine = (await as(C).get('/api/admin/tournaments').expect(200)).body.data as { id: string; myRole: string; permissions: string[] }[];
    expect(mine).toEqual([expect.objectContaining({ id: T.t, myRole: 'COORDINATOR' })]);
    expect(mine[0].permissions).toContain('SCHEDULE');
    expect(mine[0].permissions).not.toContain('RESULTS');
  });

  it('SETTINGS, MEMBERS y cambio de liga', async () => {
    await expectMatrix((u) => as(u).patch(`/api/tournaments/${T.t}`).send({ venue: `Sede ${u.email}` }), { O: 200, A: 200, C: 403, S: 403, X: 403 });
    await expectMatrix((u) => as(u).post(`/api/tournaments/${T.t}/invitations`).send({ kind: 'LINK', role: 'SCORER' }), { O: 201, A: 403, C: 403, S: 403, X: 403 });
    // Un ADMIN no puede llevarse el torneo a una liga suya.
    const leagueOfA = (await as(A).post('/api/leagues').send({ name: `Liga de A ${++seq}` }).expect(201)).body.id;
    await as(A).patch(`/api/tournaments/${T.t}`).send({ leagueId: leagueOfA }).expect(403);
  });

  it('LIFECYCLE y DELETE', async () => {
    const draft = await tournament(O, 'DRAFT');
    for (const [u, role] of [[A, 'ADMIN'], [C, 'COORDINATOR'], [S, 'SCORER']] as const) await expectStatus(addMember(draft.t, u, role), 200);
    // Eliminar: solo el propietario.
    for (const u of [A, C, S, X]) await as(u).delete(`/api/tournaments/${draft.t}`).expect(403);
    await as(C).post(`/api/tournaments/${draft.t}/start`).expect(403);
    await as(S).post(`/api/tournaments/${draft.t}/start`).expect(403);
    await as(A).post(`/api/tournaments/${draft.t}/start`).expect(200);
    const disposable = await tournament(O, 'DRAFT');
    await expectStatus(addMember(disposable.t, A, 'ADMIN'), 200);
    await as(A).delete(`/api/tournaments/${disposable.t}`).expect(403);
    await as(O).delete(`/api/tournaments/${disposable.t}`).expect(204);
  });

  it('TEAMS, SCHEDULE, ASSIGNMENTS y RESULTS', async () => {
    const extraTeam = async (u: U) => (await as(u).post('/api/teams').send({ name: `Extra ${++seq}` }).expect(201)).body.id as string;
    await expectMatrix(async (u) => as(u).post(`/api/tournaments/${T.t}/teams/${await extraTeam(u)}`), { O: 201, A: 201, C: 403, S: 403, X: 403 });
    await expectMatrix((u) => newMatch(u, T), { O: 201, A: 201, C: 201, S: 403, X: 403 });
    await expectMatrix((u) => as(u).patch(`/api/matches/${m}`).send({ time: `1${(++seq % 9) + 1}:00`, reason: 'Ajuste' }), { O: 200, A: 200, C: 200, S: 403, X: 403 });

    // Cancha y árbitros del PROPIETARIO, usados por el coordinador dentro del torneo.
    const v = (await as(O).post('/api/venues').send({ name: `Sede RB ${++seq}`, fields: [{ name: 'C1' }] }).expect(201)).body;
    const r = (await as(O).post('/api/referees').send({ firstName: 'Árbitro', lastName: `RB${seq}`, phone: '998 111 2222' }).expect(201)).body;
    await as(S).patch(`/api/matches/${m}`).send({ fieldId: v.fields[0].id }).expect(403);
    await as(C).patch(`/api/matches/${m}`).send({ fieldId: v.fields[0].id }).expect(200);
    await as(C).get(`/api/venues/check?fieldId=${v.fields[0].id}&tournamentId=${T.t}&date=2027-02-06&time=12:00`).expect(200);
    await as(S).get(`/api/venues/check?fieldId=${v.fields[0].id}&tournamentId=${T.t}&date=2027-02-06&time=12:00`).expect(403);
    await as(S).post(`/api/matches/${m}/referees`).send({ refereeId: r.id, role: 'CENTRAL' }).expect(403);
    await as(C).post(`/api/matches/${m}/referees`).send({ refereeId: r.id, role: 'CENTRAL' }).expect(201);
    // El catálogo sigue siendo solo del propietario.
    await as(C).patch(`/api/venues/${v.id}`).send({ name: 'Mía' }).expect(403);
    await as(C).patch(`/api/referees/${r.id}`).send({ firstName: 'Mío' }).expect(403);

    // Resultados: SCORER y ADMIN sí; COORDINATOR no. "En juego" también es de resultados.
    const fresh = (await newMatch(O, T, { date: '2027-03-06' }).expect(201)).body.id;
    await as(C).patch(`/api/matches/${fresh}`).send({ status: 'LIVE' }).expect(403);
    await as(S).patch(`/api/matches/${fresh}`).send({ status: 'LIVE' }).expect(200);
    await expectMatrix((u) => as(u).put(`/api/matches/${m}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [] }), { O: 200, A: 200, C: 403, S: 200, X: 403 });
    // El anotador no reprograma.
    await as(S).patch(`/api/matches/${fresh}`).send({ date: '2027-03-07', reason: 'x' }).expect(403);
  });

  it('DISCIPLINE: gestionar solo OWNER/ADMIN; consultar y elegibilidad todos; historial todos', async () => {
    await expectMatrix((u) => as(u).put(`/api/tournaments/${T.t}/discipline/rules`).send({ enabled: true }), { O: 200, A: 200, C: 403, S: 403, X: 403 });
    await expectMatrix((u) => as(u).get(`/api/tournaments/${T.t}/discipline`), { O: 200, A: 200, C: 200, S: 200, X: 403 });
    await expectMatrix((u) => as(u).get(`/api/matches/${m}/eligibility`), { O: 200, A: 200, C: 200, S: 200, X: 403 });
    await expectMatrix((u) => as(u).get(`/api/matches/${m}/log`), { O: 200, A: 200, C: 200, S: 200, X: 403 });
  });

  it('COORDINATOR arma cruces y avanza fases; queda en auditoría con su rol', async () => {
    const k = await tournament(O, 'ACTIVE', { system: 'KNOCKOUT' });
    await expectStatus(addMember(k.t, C, 'COORDINATOR'), 200);
    await as(C).post(`/api/tournaments/${k.t}/schedule`).send({ manual: true, bracketSize: 2 }).expect(201);
    await as(C).post(`/api/tournaments/${k.t}/phases/0/ties`).send({ round: 0, homeTeamId: k.teams[0], awayTeamId: k.teams[1], legs: [{ date: '2027-04-03', time: '10:00' }] }).expect(201);
    const [tie] = (await request(http).get(`/api/tournaments/${k.t}/matches`).expect(200)).body as { id: string }[];
    const entry = (await as(O).get(`/api/matches/${tie.id}/log`).expect(200)).body.entries[0];
    expect(entry).toMatchObject({ action: 'CREATED', actorId: C.id, actorRole: 'COORDINATOR' });
  });
});

describe('auditoría con el usuario real y su rol', () => {
  it('match_logs y discipline_log registran actorRole', async () => {
    const x = await tournament(O);
    await expectStatus(addMember(x.t, A, 'ADMIN'), 200);
    const mm = (await newMatch(O, x).expect(201)).body.id;
    await as(A).patch(`/api/matches/${mm}`).send({ time: '11:00', reason: 'Lo movió el admin' }).expect(200);
    const entries = (await as(O).get(`/api/matches/${mm}/log`).expect(200)).body.entries as { action: string; actorId: string; actorRole: string }[];
    expect(entries.at(-1)).toMatchObject({ action: 'RESCHEDULED', actorId: A.id, actorRole: 'ADMIN' });
    expect(entries[0]).toMatchObject({ action: 'CREATED', actorRole: 'OWNER' });
    await as(A).put(`/api/tournaments/${x.t}/discipline/rules`).send({ enabled: true, justification: 'Reglamento' }).expect(200);
    const history = (await as(O).get(`/api/tournaments/${x.t}/discipline/history`).expect(200)).body;
    expect(history[0].by).toMatchObject({ id: A.id, role: 'ADMIN' });
  });
});

describe('aislamiento, propietario y límites', () => {
  it('un colaborador no ve ni toca torneos de otro propietario', async () => {
    const t2 = await tournament(O2);
    const m2 = (await newMatch(O2, t2).expect(201)).body.id;
    await as(A).get(`/api/admin/tournaments/${t2.t}`).expect(403);
    await as(A).patch(`/api/matches/${m2}`).send({ time: '12:00', reason: 'x' }).expect(403);
    await as(A).put(`/api/matches/${m2}/result`).send({ homeScore: 0, awayScore: 0, playerStats: [] }).expect(403);
    await as(A).get(`/api/tournaments/${t2.t}/members`).expect(403);
    await as(A).get(`/api/matches/${m2}/log`).expect(403);
    const mine = (await as(A).get('/api/admin/tournaments').expect(200)).body.data as { id: string }[];
    expect(mine.map((t) => t.id)).not.toContain(t2.t);
    // Ser colaborador de un torneo de O no da acceso a nada de O2 ni al catálogo de O.
    expect((await as(A).get('/api/venues').expect(200)).body).toEqual([]);
  });

  it('el propietario no se agrega, no se cambia ni se revoca; su email solo lo ve él', async () => {
    await expectStatus(addMember(T.t, O, 'ADMIN'), 409);
    await as(O).delete(`/api/tournaments/${T.t}/members/${O.id}`).expect(404);
    await as(O).patch(`/api/tournaments/${T.t}/members/${O.id}`).send({ role: 'SCORER' }).expect(404);
    const asOwner = (await as(O).get(`/api/tournaments/${T.t}/members`).expect(200)).body;
    expect(asOwner.owner).toMatchObject({ userId: O.id, email: O.email });
    const asScorer = (await as(S).get(`/api/tournaments/${T.t}/members`).expect(200)).body;
    expect(asScorer.owner.email).toBeUndefined();
    expect(asScorer.members.every((x: { email?: string }) => x.email === undefined)).toBe(true);
    await expectStatus(addMember(T.t, A, 'SCORER'), 409); // ya colabora: se cambia de rol, no se duplica
  });

  it('cambio de rol: efecto inmediato y la fila anterior queda como auditoría', async () => {
    const x = await tournament(O);
    await expectStatus(addMember(x.t, C, 'SCORER'), 200);
    const mm = (await newMatch(O, x).expect(201)).body.id;
    await as(C).patch(`/api/matches/${mm}`).send({ time: '11:00', reason: 'x' }).expect(403);
    await as(O).patch(`/api/tournaments/${x.t}/members/${C.id}`).send({ role: 'COORDINATOR' }).expect(200);
    await as(C).patch(`/api/matches/${mm}`).send({ time: '11:00', reason: 'x' }).expect(200);
    const db = ctx.app.get<Connection>(getConnectionToken());
    const rows = await db.collection('tournament_members').find({ tournamentId: new Types.ObjectId(x.t), userId: new Types.ObjectId(C.id) }).toArray();
    expect(rows.map((r) => `${r.role}:${r.status}`).sort()).toEqual(['COORDINATOR:ACTIVE', 'SCORER:REVOKED']);
  });

  it('máximo 20 colaboradores activos', async () => {
    const x = await tournament(O);
    for (let i = 0; i < 20; i++) await expectStatus(addMember(x.t, await registerOrganizer(http, `Lote${i}`), 'SCORER'), 200);
    const res = await addMember(x.t, X, 'SCORER');
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/20 colaboradores/);
  });

  it('revocar: inmediato, también en torneos finalizados; el colaborador conserva la lectura mientras tenga acceso', async () => {
    const x = await tournament(O);
    await expectStatus(addMember(x.t, C, 'COORDINATOR'), 200);
    const mm = (await newMatch(O, x).expect(201)).body.id;
    await as(O).post(`/api/tournaments/${x.t}/finish`).send({ allowPendingMatches: true }).expect(200);
    await as(C).get(`/api/admin/tournaments/${x.t}`).expect(200); // finalizado: lectura
    await as(C).patch(`/api/matches/${mm}`).send({ time: '11:00', reason: 'x' }).expect(409); // pero inmutable
    await as(O).delete(`/api/tournaments/${x.t}/members/${C.id}`).expect(200);
    await as(C).get(`/api/admin/tournaments/${x.t}`).expect(403);
  });
});

it('rutas públicas siguen funcionando sin sesión', async () => {
  await request(http).get(`/api/tournaments/${T.t}`).expect(200);
  await request(http).get(`/api/tournaments/${T.t}/matches`).expect(200);
  await request(http).get(`/api/tournaments/${T.t}/standings`).expect(200);
  await request(http).get(`/api/tournaments/${T.t}/structure`).expect(200);
  await request(http).get(`/api/matches/${m}`).expect(200);
  await request(http).get(`/api/admin/tournaments/${T.t}`).expect(401);
});

it('carrera: revocar mientras el colaborador escribe; nunca se confirma una escritura posterior a la revocación', async () => {
  const x = await tournament(O);
  const mm = (await newMatch(O, x).expect(201)).body.id;
  const db = ctx.app.get<Connection>(getConnectionToken());
  for (let i = 0; i < 15; i++) {
    await expectStatus(addMember(x.t, C, 'COORDINATOR'), 200);
    const [, write] = await Promise.all([
      as(O).delete(`/api/tournaments/${x.t}/members/${C.id}`),
      as(C).patch(`/api/matches/${mm}`).send({ time: `1${i % 10}:${i < 10 ? '15' : '45'}`, reason: `Carrera ${i}` }),
    ]);
    expect([200, 403]).toContain(write.status);
    if (write.status === 200) {
      // Si la escritura se confirmó, fue ANTES de la revocación.
      const [revoked] = await db.collection('tournament_members').find({ tournamentId: new Types.ObjectId(x.t), userId: new Types.ObjectId(C.id), status: 'REVOKED' }).sort({ revokedAt: -1 }).limit(1).toArray();
      const [entry] = await db.collection('match_logs').find({ matchId: new Types.ObjectId(mm), reason: `Carrera ${i}` }).toArray();
      expect(entry.createdAt.getTime()).toBeLessThanOrEqual(revoked.revokedAt.getTime());
    }
  }
});
