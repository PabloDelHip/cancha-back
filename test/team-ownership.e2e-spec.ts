/**
 * Etapa 6A — Team Ownership + Roles. OWNER / MANAGER globales del Team, separados de quién lo
 * creó (`createdBy`, auditoría + custodia provisional sin OWNER) y de quién organiza los torneos
 * donde juega. Todo contra la API real (el primer OWNER, por el mecanismo interno).
 */
import request from 'supertest';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { TeamAdminsService } from '../src/modules/teams/team-admins.service.js';
import { TeamAdmin } from '../src/modules/teams/schemas/team-admin.schema.js';
import { TeamAccessService } from '../src/common/authorization/team-access.service.js';
import { TeamAdminRole, TeamAdminSource, TeamAdminStatus } from '../src/common/enums/index.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type Org = Awaited<ReturnType<typeof registerOrganizer>>;
const as = (u: Org) => authed(http, u.token);
/** Los campos ObjectId no convierten strings en consultas directas: siempre ObjectId real. */
const oid = (id: string) => new Types.ObjectId(id);
let admins: TeamAdminsService;
let rows: Model<TeamAdmin>;

/** A organiza la liga y registró los equipos; Pablo, Carlos y Roberto son de un equipo; Zoe, nadie. */
let A: Org, pablo: Org, carlos: Org, roberto: Org, zoe: Org;
let seq = 0;
const newTeam = async (by: Org, name = `Deportivo ${++seq}`) =>
  (await as(by).post('/api/teams').send({ name }).expect(201)).body.id as string;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  admins = ctx.app.get(TeamAdminsService);
  rows = ctx.app.get<Model<TeamAdmin>>(getModelToken(TeamAdmin.name));
  A = await registerOrganizer(http, 'Ana');
  pablo = await registerOrganizer(http, 'Pablo');
  carlos = await registerOrganizer(http, 'Carlos');
  roberto = await registerOrganizer(http, 'Roberto');
  zoe = await registerOrganizer(http, 'Zoe');
});
afterAll(async () => ctx?.close());

describe('Team sin OWNER (estado por defecto) y custodia provisional', () => {
  it('un equipo recién creado no tiene OWNER; su creador no es OWNER ni ve administradores', async () => {
    const t = await newTeam(A);
    expect(await ctx.app.get(TeamAccessService).hasOwner(t)).toBe(false);
    await as(A).get(`/api/teams/${t}/admins`).expect(403);
    // El creador conserva la custodia de la ficha mientras no hay OWNER (flujo existente).
    await as(A).patch(`/api/teams/${t}`).send({ name: 'Deportivo Corregido' }).expect(200);
    // …pero nunca administra roles.
    await as(A).post(`/api/teams/${t}/managers`).send({ userId: carlos.id }).expect(403);
  });
});

describe('Primer OWNER por mecanismo interno', () => {
  let t: string;
  beforeAll(async () => {
    t = await newTeam(A);
  });

  it('no existe endpoint HTTP para apropiarse de un equipo sin OWNER', async () => {
    await as(zoe).post(`/api/teams/${t}/owner`).send({}).expect(404);
    await as(zoe).put(`/api/teams/${t}/owner`).send({}).expect(404);
  });

  it('asignación interna: crea el OWNER; repetir con el mismo usuario es idempotente', async () => {
    const view = await admins.assignOwner(t, pablo.id);
    expect(view.owner).toMatchObject({ userId: pablo.id, firstName: 'Pablo', role: 'OWNER' });
    await admins.assignOwner(t, pablo.id);
    expect(await rows.countDocuments({ teamId: oid(t), role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE })).toBe(1);
  });

  it('no puede haber dos OWNER activos: asignar otro → 409', async () => {
    await expect(admins.assignOwner(t, zoe.id)).rejects.toMatchObject({ status: 409 });
  });

  it('equipo o usuario inexistente → 404', async () => {
    await expect(admins.assignOwner('000000000000000000000000', pablo.id)).rejects.toMatchObject({ status: 404 });
    await expect(admins.assignOwner(t, '000000000000000000000000')).rejects.toMatchObject({ status: 404 });
  });

  it('concurrencia: 8 asignaciones simultáneas de OWNERS distintos → exactamente 1', async () => {
    const t2 = await newTeam(A);
    const users = [pablo, carlos, roberto, zoe, A];
    const results = await Promise.allSettled([...users, ...users.slice(0, 3)].map((u) => admins.assignOwner(t2, u.id)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const f of failed) expect(f.reason).toMatchObject({ status: 409 });
    expect(await rows.countDocuments({ teamId: oid(t2), role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE })).toBe(1);
  });

  it('la base rechaza un segundo OWNER activo aunque se salte el service (índice único parcial)', async () => {
    await expect(
      rows.create({ teamId: oid(t), userId: oid(zoe.id), role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE, source: TeamAdminSource.INTERNAL }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe('OWNER y MANAGERS', () => {
  let t: string;
  beforeAll(async () => {
    t = await newTeam(A, 'Deportivo Mazatlán');
    await admins.assignOwner(t, pablo.id);
  });

  it('OWNER consulta administradores (sin emails ni datos de cuenta)', async () => {
    const res = await as(pablo).get(`/api/teams/${t}/admins`).expect(200);
    expect(res.body).toMatchObject({ teamId: t, owner: { userId: pablo.id, role: 'OWNER' }, managers: [] });
    expect(JSON.stringify(res.body)).not.toMatch(/email|password|@example\.com/);
  });

  it('OWNER agrega MANAGER por id y por email (201); repetirlo es idempotente (200, sin duplicar)', async () => {
    const r1 = await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: carlos.id }).expect(201);
    expect(r1.body.managers.map((m: { userId: string }) => m.userId)).toEqual([carlos.id]);
    await as(pablo).post(`/api/teams/${t}/managers`).send({ email: roberto.email.toUpperCase() }).expect(201);
    await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: carlos.id }).expect(200);
    expect(await rows.countDocuments({ teamId: oid(t), userId: oid(carlos.id), status: TeamAdminStatus.ACTIVE })).toBe(1);
  });

  it('MANAGER duplicado en paralelo: un solo registro activo', async () => {
    const t2 = await newTeam(A);
    await admins.assignOwner(t2, pablo.id);
    const res = await Promise.all([1, 2, 3, 4].map(() => as(pablo).post(`/api/teams/${t2}/managers`).send({ userId: zoe.id })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(await rows.countDocuments({ teamId: oid(t2), userId: oid(zoe.id), status: TeamAdminStatus.ACTIVE })).toBe(1);
  });

  it('validaciones: OWNER como manager → 409; usuario inexistente → 404; sin/ambos identificadores → 400', async () => {
    await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: pablo.id }).expect(409);
    await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: '000000000000000000000000' }).expect(404);
    await as(pablo).post(`/api/teams/${t}/managers`).send({ email: 'nadie@example.com' }).expect(404);
    await as(pablo).post(`/api/teams/${t}/managers`).send({}).expect(400);
    await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: carlos.id, email: carlos.email }).expect(400);
    await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: carlos.id, role: 'OWNER' }).expect(400); // campo no permitido
  });

  it('MANAGER: consulta admins y edita presentación, pero no el nombre ni roles ni el OWNER', async () => {
    await as(carlos).get(`/api/teams/${t}/admins`).expect(200);
    await as(carlos).patch(`/api/teams/${t}`).send({ city: 'Mazatlán, Sin.', colors: { primary: '#1d4ed8', secondary: '#ffffff' } }).expect(200);
    const denied = await as(carlos).patch(`/api/teams/${t}`).send({ name: 'Otro Nombre' }).expect(403);
    expect(denied.body.message).toMatch(/name/);
    await as(carlos).post(`/api/teams/${t}/managers`).send({ userId: zoe.id }).expect(403);
    await as(carlos).delete(`/api/teams/${t}/managers/${roberto.id}`).expect(403);
    await as(carlos).delete(`/api/teams/${t}/managers/${pablo.id}`).expect(403);
    await as(carlos).delete(`/api/teams/${t}`).expect(403);
  });

  it('OWNER edita toda la ficha', async () => {
    const res = await as(pablo).patch(`/api/teams/${t}`).send({ name: 'Deportivo Mazatlán FC', shortName: 'DEP' }).expect(200);
    expect(res.body).toMatchObject({ name: 'Deportivo Mazatlán FC', city: 'Mazatlán, Sin.' });
  });

  it('OWNER quita MANAGER: baja lógica con auditoría; pierde acceso; volver a agregarlo crea registro nuevo', async () => {
    await as(pablo).delete(`/api/teams/${t}/managers/${roberto.id}`).expect(204);
    await as(pablo).delete(`/api/teams/${t}/managers/${roberto.id}`).expect(404);
    await as(pablo).delete(`/api/teams/${t}/managers/${pablo.id}`).expect(404); // el OWNER no es un MANAGER
    const audit = await rows.findOne({ teamId: oid(t), userId: oid(roberto.id) }).lean();
    expect(audit).toMatchObject({ status: 'INACTIVE', role: 'MANAGER', source: 'OWNER' });
    expect(audit!.revokedAt).toBeInstanceOf(Date);
    expect(audit!.revokedBy!.toHexString()).toBe(pablo.id);
    await as(roberto).get(`/api/teams/${t}/admins`).expect(403);
    await as(roberto).patch(`/api/teams/${t}`).send({ city: 'X' }).expect(403);
    await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: roberto.id }).expect(201);
    expect(await rows.countDocuments({ teamId: oid(t), userId: oid(roberto.id) })).toBe(2);
  });

  it('un MANAGER promovido a OWNER por el mecanismo interno deja de ser MANAGER (sin doble rol)', async () => {
    const t2 = await newTeam(A);
    await admins.assignOwner(t2, pablo.id);
    await as(pablo).post(`/api/teams/${t2}/managers`).send({ userId: carlos.id }).expect(201);
    await expect(admins.assignOwner(t2, carlos.id)).rejects.toMatchObject({ status: 409 }); // ya hay OWNER
    expect(await rows.countDocuments({ teamId: oid(t2), userId: oid(carlos.id), status: TeamAdminStatus.ACTIVE, role: TeamAdminRole.MANAGER })).toBe(1);
    const t3 = await newTeam(A);
    await rows.create({ teamId: oid(t3), userId: oid(carlos.id), role: TeamAdminRole.MANAGER, status: TeamAdminStatus.ACTIVE, source: TeamAdminSource.OWNER });
    const view = await admins.assignOwner(t3, carlos.id);
    expect(view).toMatchObject({ owner: { userId: carlos.id }, managers: [] });
  });
});

describe('Organizador ≠ administrador del Team', () => {
  let t: string, tournament: string;
  beforeAll(async () => {
    t = await newTeam(A, 'Real Pacífico');
    await admins.assignOwner(t, pablo.id);
    tournament = (await as(A).post('/api/tournaments').send({ name: 'Liga Municipal', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id;
  });

  it('el organizador que CREÓ el equipo pierde la custodia en cuanto hay OWNER', async () => {
    await as(A).patch(`/api/teams/${t}`).send({ city: 'Culiacán' }).expect(403);
    await as(A).delete(`/api/teams/${t}`).expect(403);
    await as(A).get(`/api/teams/${t}/admins`).expect(403);
    await as(A).post(`/api/teams/${t}/managers`).send({ userId: A.id }).expect(403);
  });

  it('pero sigue controlando SU torneo: inscripción, plantilla del torneo, calendario y resultados', async () => {
    const rival = await newTeam(A, 'Rival FC');
    await as(A).post(`/api/tournaments/${tournament}/teams/${t}`).expect(201);
    await as(A).post(`/api/tournaments/${tournament}/teams/${rival}`).expect(201);
    const player = (await as(A).post('/api/players').send({ confirmNew: true, firstName: 'Juan', lastName: 'Pérez', position: 'FORWARD' }).expect(201)).body.id;
    await as(A).put(`/api/tournaments/${tournament}/players/${player}`).send({ teamId: t, jerseyNumber: 10 }).expect(200);
    const m = (await as(A).post('/api/matches').send({ tournamentId: tournament, round: 1, homeTeamId: t, awayTeamId: rival, date: '2027-01-10', time: '18:00' }).expect(201)).body.id;
    await as(A).put(`/api/matches/${m}/result`).send({ homeScore: 2, awayScore: 0, playerStats: [{ playerId: player, teamId: t, played: true, goals: 2, assists: 0, yellowCards: 0, redCards: 0 }] }).expect(200);
  });

  it('y el OWNER del equipo NO controla el torneo ajeno', async () => {
    await as(pablo).delete(`/api/tournaments/${tournament}/teams/${t}`).expect(403);
    await as(pablo).patch(`/api/tournaments/${tournament}`).send({ name: 'Mía' }).expect(403);
  });

  it('GET /admin/teams: myRole y canEdit salen del rol, no de organizar ni de haber creado', async () => {
    const mine = async (u: Org) => (await as(u).get('/api/admin/teams?limit=100').expect(200)).body.data as { id: string; myRole: string | null; canEdit: boolean }[];
    expect((await mine(A)).find((x) => x.id === t)).toMatchObject({ myRole: null, canEdit: false }); // inscrito en su torneo y creado por él
    expect((await mine(pablo)).find((x) => x.id === t)).toMatchObject({ myRole: 'OWNER', canEdit: true }); // no organiza nada
    const custody = await newTeam(A, 'Sin Dueño FC');
    expect((await mine(A)).find((x) => x.id === custody)).toMatchObject({ myRole: null, canEdit: true });
  });
});

describe('Seguridad y validación', () => {
  let t: string;
  beforeAll(async () => {
    t = await newTeam(A);
    await admins.assignOwner(t, pablo.id);
  });

  it('usuario cualquiera: no edita, no borra, no ve ni administra roles', async () => {
    await as(zoe).patch(`/api/teams/${t}`).send({ city: 'X' }).expect(403);
    await as(zoe).delete(`/api/teams/${t}`).expect(403);
    await as(zoe).get(`/api/teams/${t}/admins`).expect(403);
    await as(zoe).post(`/api/teams/${t}/managers`).send({ userId: zoe.id }).expect(403);
    await as(zoe).delete(`/api/teams/${t}/managers/${pablo.id}`).expect(403);
  });

  it('sin sesión: 401 en todo lo privado', async () => {
    await api().get(`/api/teams/${t}/admins`).expect(401);
    await api().post(`/api/teams/${t}/managers`).send({ userId: zoe.id }).expect(401);
    await api().delete(`/api/teams/${t}/managers/${zoe.id}`).expect(401);
    await api().patch(`/api/teams/${t}`).send({ city: 'X' }).expect(401);
  });

  it('equipo inexistente → 404; ObjectId inválido → 400', async () => {
    const ghost = '000000000000000000000000';
    await as(pablo).get(`/api/teams/${ghost}/admins`).expect(404);
    await as(pablo).post(`/api/teams/${ghost}/managers`).send({ userId: zoe.id }).expect(404);
    await as(pablo).patch(`/api/teams/${ghost}`).send({ city: 'X' }).expect(404);
    await as(pablo).get('/api/teams/no-es-id/admins').expect(400);
    await as(pablo).delete(`/api/teams/${t}/managers/no-es-id`).expect(400);
  });

  it('los endpoints públicos del equipo no exponen administradores ni datos privados', async () => {
    await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: carlos.id }).expect(201);
    const bodies = [
      (await api().get(`/api/teams/${t}`).expect(200)).body,
      (await api().get(`/api/teams/${t}/profile`).expect(200)).body,
      (await api().get('/api/teams?limit=100').expect(200)).body,
    ];
    for (const body of bodies) {
      const json = JSON.stringify(body);
      for (const k of ['createdBy', 'owner', 'managers', 'admins', 'email', 'userId', 'grantedBy']) expect(json).not.toContain(`"${k}"`);
      expect(json).not.toContain(pablo.id);
      expect(json).not.toContain(carlos.id);
    }
  });

  it('el OWNER borra un equipo sin historia; sus registros de administración se van con él', async () => {
    const t2 = await newTeam(A);
    await admins.assignOwner(t2, pablo.id);
    await as(pablo).delete(`/api/teams/${t2}`).expect(204);
    expect(await rows.countDocuments({ teamId: oid(t2) })).toBe(0);
  });
});
