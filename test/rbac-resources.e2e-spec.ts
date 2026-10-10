/**
 * RBAC R3 (2026-10-10): sedes, canchas y árbitros del PROPIETARIO usados por sus colaboradores,
 * sin poder administrar el catálogo, con aislamiento entre propietarios y revocación inmediata.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O1: U, O2: U, C: U, S: U, X: U;
const as = (u: U) => authed(http, u.token);

let seq = 0;
async function tournament(owner: U) {
  const t = (await as(owner).post('/api/tournaments').send({ name: `R3 ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = (await as(owner).post('/api/teams').send({ name: `R3-${seq}-${i}` }).expect(201)).body.id as string;
    await as(owner).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
async function join(t: string, owner: U, u: U, role: string) {
  const inv = (await as(owner).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}
let round = 0;
const match = async (who: U, x: { t: string; teams: string[] }, date: string, time: string) =>
  (await as(who).post('/api/matches').send({ tournamentId: x.t, round: ++round, homeTeamId: x.teams[0], awayTeamId: x.teams[1], date, time }).expect(201)).body.id as string;

let T1: { t: string; teams: string[] }, T1b: { t: string; teams: string[] }, T2: { t: string; teams: string[] };
let v1: { id: string; fields: { id: string }[] }, v2: { id: string; fields: { id: string }[] };
let r1: { id: string }, r2: { id: string };

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O1, O2, C, S, X] = [await registerOrganizer(http, 'Prop1'), await registerOrganizer(http, 'Prop2'), await registerOrganizer(http, 'Compartido'), await registerOrganizer(http, 'Anota'), await registerOrganizer(http, 'Fuera')];
  [T1, T1b, T2] = [await tournament(O1), await tournament(O1), await tournament(O2)];
  // C colabora con DOS propietarios: coordinador en T1 (de O1) y admin en T2 (de O2).
  await join(T1.t, O1, C, 'COORDINATOR');
  await join(T2.t, O2, C, 'ADMIN');
  await join(T1.t, O1, S, 'SCORER');
  v1 = (await as(O1).post('/api/venues').send({ name: 'Sede de O1', fields: [{ name: 'C1' }, { name: 'C2' }] }).expect(201)).body;
  v2 = (await as(O2).post('/api/venues').send({ name: 'Sede de O2', fields: [{ name: 'C1' }] }).expect(201)).body;
  r1 = (await as(O1).post('/api/referees').send({ firstName: 'Árbitro', lastName: 'Uno', phone: '998 111 0001', email: 'uno@example.com' }).expect(201)).body;
  r2 = (await as(O2).post('/api/referees').send({ firstName: 'Árbitro', lastName: 'Dos', phone: '998 222 0002' }).expect(201)).body;
});
afterAll(async () => ctx?.close());

describe('sedes y canchas del propietario', () => {
  it('cada rol ve (o no) las sedes del propietario del torneo, nunca las de otro', async () => {
    const names = async (u: U, t: string) => ((await as(u).get(`/api/tournaments/${t}/venues`).expect(200)).body as { name: string }[]).map((v) => v.name);
    expect(await names(O1, T1.t)).toEqual(['Sede de O1']);
    expect(await names(C, T1.t)).toEqual(['Sede de O1']);
    expect(await names(C, T2.t)).toEqual(['Sede de O2']); // mismo colaborador, otro propietario
    await as(S).get(`/api/tournaments/${T1.t}/venues`).expect(403);
    await as(X).get(`/api/tournaments/${T1.t}/venues`).expect(403);
    await request(http).get(`/api/tournaments/${T1.t}/venues`).expect(401);
    // El propietario sale del torneo: un ownerId del cliente se ignora.
    const forged = (await as(C).get(`/api/tournaments/${T1.t}/venues?ownerId=${O2.id}`).expect(200)).body as { name: string }[];
    expect(forged.map((v) => v.name)).toEqual(['Sede de O1']);
  });

  it('el colaborador asigna y retira canchas del propietario; no las de otro ni las suyas; respeta activo y conflictos', async () => {
    const m = await match(C, T1, '2027-02-06', '10:00');
    await as(C).patch(`/api/matches/${m}`).send({ fieldId: v2.fields[0].id }).expect(400); // sede de O2 en torneo de O1
    const own = (await as(C).post('/api/venues').send({ name: 'Sede propia de C', fields: [{ name: 'X' }] }).expect(201)).body;
    await as(C).patch(`/api/matches/${m}`).send({ fieldId: own.fields[0].id }).expect(400); // su catálogo no sirve aquí
    await as(C).patch(`/api/matches/${m}`).send({ fieldId: v1.fields[0].id }).expect(200);
    // Conflicto con otro torneo del MISMO propietario (T1b), aunque C no colabore allí.
    const other = await match(O1, T1b, '2027-02-06', '11:00');
    expect((await as(O1).patch(`/api/matches/${other}`).send({ fieldId: v1.fields[0].id }).expect(409)).body.error).toBe('FIELD_CONFLICT');
    await as(C).patch(`/api/matches/${m}`).send({ fieldId: null }).expect(200); // retirar
    await as(O1).patch(`/api/matches/${other}`).send({ fieldId: v1.fields[0].id }).expect(200);
    // Cancha desactivada por el propietario: no se asigna.
    await as(O1).patch(`/api/venues/${v1.id}/fields/${v1.fields[1].id}`).send({ active: false }).expect(200);
    await as(C).patch(`/api/matches/${m}`).send({ fieldId: v1.fields[1].id }).expect(409);
    await as(O1).patch(`/api/venues/${v1.id}/fields/${v1.fields[1].id}`).send({ active: true }).expect(200);
    // El anotador no programa canchas.
    await as(S).patch(`/api/matches/${m}`).send({ fieldId: v1.fields[1].id }).expect(403);
  });

  it('el catálogo del propietario no se modifica por colaboradores', async () => {
    await as(C).patch(`/api/venues/${v1.id}`).send({ name: 'Mía' }).expect(403);
    await as(C).post(`/api/venues/${v1.id}/fields`).send({ name: 'Nueva' }).expect(403);
    await as(C).delete(`/api/venues/${v1.id}/fields/${v1.fields[0].id}`).expect(403);
    await as(C).delete(`/api/venues/${v1.id}`).expect(403);
    expect((await as(C).get('/api/venues').expect(200)).body.map((v: { name: string }) => v.name)).toEqual(['Sede propia de C']);
  });
});

describe('árbitros del propietario y su contacto', () => {
  it('contacto solo para ADMIN/COORDINATOR del torneo, y solo del propietario de ese torneo', async () => {
    const list = (await as(C).get(`/api/tournaments/${T1.t}/referees`).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ id: r1.id, phone: '998 111 0001', email: 'uno@example.com' })]);
    expect((await as(C).get(`/api/tournaments/${T2.t}/referees`).expect(200)).body.map((r: { id: string }) => r.id)).toEqual([r2.id]);
    await as(S).get(`/api/tournaments/${T1.t}/referees`).expect(403);
    await as(X).get(`/api/tournaments/${T1.t}/referees`).expect(403);
    await request(http).get(`/api/tournaments/${T1.t}/referees`).expect(401);
    // El catálogo global y el historial siguen siendo del propietario.
    await as(C).patch(`/api/referees/${r1.id}`).send({ phone: '000' }).expect(403);
    await as(C).get(`/api/referees/${r1.id}/matches`).expect(403);
    expect((await as(C).get('/api/referees').expect(200)).body).toEqual([]);
  });

  it('asignaciones y sustituciones con árbitros del propietario; no de otro; conflictos entre sus torneos', async () => {
    const m = await match(C, T1, '2027-03-06', '10:00');
    await as(C).post(`/api/matches/${m}/referees`).send({ refereeId: r2.id, role: 'CENTRAL' }).expect(400); // árbitro de O2
    const a = (await as(C).post(`/api/matches/${m}/referees`).send({ refereeId: r1.id, role: 'CENTRAL' }).expect(201)).body.referees[0];
    const sub = (await as(O1).post('/api/referees').send({ firstName: 'Suplente', lastName: 'O1' }).expect(201)).body;
    await as(C).post(`/api/matches/${m}/referees/${a.id}/absence`).send({ substituteId: sub.id }).expect(200);
    // El suplente ya arbitra en T1 a las 10:00: no puede ir a T1b a las 10:30 (mismo propietario).
    const other = await match(O1, T1b, '2027-03-06', '10:30');
    expect((await as(O1).post(`/api/matches/${other}/referees`).send({ refereeId: sub.id, role: 'CENTRAL' }).expect(409)).body.error).toBe('REFEREE_CONFLICT');
    await as(S).post(`/api/matches/${m}/referees`).send({ refereeId: r1.id, role: 'FOURTH' }).expect(403);
    // Lo público no expone contacto.
    expect(JSON.stringify((await request(http).get(`/api/matches/${m}`).expect(200)).body)).not.toMatch(/998 111|@example\.com/);
  });
});

it('revocación: pierde el acceso a los recursos de ese propietario al instante, conserva el del otro', async () => {
  const fresh = await registerOrganizer(http, 'Revocable');
  await join(T1.t, O1, fresh, 'ADMIN');
  await join(T2.t, O2, fresh, 'COORDINATOR');
  await as(fresh).get(`/api/tournaments/${T1.t}/venues`).expect(200);
  await as(O1).delete(`/api/tournaments/${T1.t}/members/${fresh.id}`).expect(200);
  await as(fresh).get(`/api/tournaments/${T1.t}/venues`).expect(403);
  await as(fresh).get(`/api/tournaments/${T1.t}/referees`).expect(403);
  const m = await match(O1, T1, '2027-04-03', '10:00');
  await as(fresh).patch(`/api/matches/${m}`).send({ fieldId: v1.fields[0].id }).expect(403);
  await as(fresh).post(`/api/matches/${m}/referees`).send({ refereeId: r1.id, role: 'CENTRAL' }).expect(403);
  await as(fresh).get(`/api/tournaments/${T2.t}/venues`).expect(200);
  await as(fresh).get(`/api/tournaments/${T2.t}/referees`).expect(200);
});
