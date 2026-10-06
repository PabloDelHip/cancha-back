/**
 * Etapa 6E — Crear un Player nuevo desde la plantilla global del equipo
 * (POST /teams/:id/global-roster/players). Solo OWNER/MANAGER (TeamAccessService). El Player es
 * global y no necesita User; queda ACTIVE en TeamRoster y nada más: ni torneos ni estadísticas.
 * API real contra replica set en memoria.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { TeamAdminsService } from '../src/modules/teams/team-admins.service.js';
import { TeamRoster } from '../src/modules/teams/schemas/team-roster.schema.js';
import { Player } from '../src/modules/players/schemas/player.schema.js';
import { TeamMembership } from '../src/modules/players/schemas/team-membership.schema.js';
import { TournamentTeam } from '../src/modules/tournaments/schemas/tournament-team.schema.js';
import { PlayerMatchStats } from '../src/modules/matches/schemas/player-match-stats.schema.js';
import { TeamRosterStatus } from '../src/common/enums/index.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type U = Awaited<ReturnType<typeof registerOrganizer>>;
const as = (u: U) => authed(http, u.token);
const oid = (id: string) => new Types.ObjectId(id);
let rosters: Model<TeamRoster>;
let players: Model<Player>;
let memberships: Model<TeamMembership>;
let tournamentTeams: Model<TournamentTeam>;
let stats: Model<PlayerMatchStats>;
let admins: TeamAdminsService;

/** L organiza un torneo donde juega el equipo y registró su ficha; pablo OWNER, carlos MANAGER. */
let L: U, pablo: U, carlos: U, zoe: U;
let seq = 0;
let dep: string;

const team = async (by: U, name: string) => (await as(by).post('/api/teams').send({ name: `${name} ${++seq}` }).expect(201)).body.id as string;
const body = (extra: Record<string, unknown> = {}) => ({
  firstName: 'Juan',
  lastName: `Pérez López ${++seq}`,
  position: 'FORWARD',
  birthDate: '2001-04-18',
  requestId: randomUUID(),
  confirmNew: true, // estos tests prueban el alta; la revisión de duplicados tiene su propio archivo
  ...extra,
});
const create = (by: U, t: string, b: Record<string, unknown> = body()) => as(by).post(`/api/teams/${t}/global-roster/players`).send(b);
const active = (t: string, p: string) => rosters.countDocuments({ teamId: oid(t), playerId: oid(p), status: TeamRosterStatus.ACTIVE });

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  rosters = ctx.app.get(getModelToken(TeamRoster.name));
  players = ctx.app.get(getModelToken(Player.name));
  memberships = ctx.app.get(getModelToken(TeamMembership.name));
  tournamentTeams = ctx.app.get(getModelToken(TournamentTeam.name));
  stats = ctx.app.get(getModelToken(PlayerMatchStats.name));
  admins = ctx.app.get(TeamAdminsService);
  [L, pablo, carlos, zoe] = [
    await registerOrganizer(http, 'Liga'),
    await registerOrganizer(http, 'Pablo'),
    await registerOrganizer(http, 'Carlos'),
    await registerOrganizer(http, 'Zoe'),
  ];
  dep = await team(L, 'Deportivo');
  await admins.assignOwner(dep, pablo.id);
  await as(pablo).post(`/api/teams/${dep}/managers`).send({ userId: carlos.id }).expect(201);
  // L organiza un torneo donde juega Deportivo: eso no le da acceso a su plantilla global.
  const liga = (await as(L).post('/api/tournaments').send({ name: 'Liga Municipal', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id;
  await as(L).post(`/api/tournaments/${liga}/teams/${dep}`).expect(201);
});
afterAll(async () => ctx?.close());

describe('Permisos: solo OWNER/MANAGER (TeamAccessService)', () => {
  it('OWNER crea un Player sin User y queda ACTIVE en la plantilla (201)', async () => {
    const res = await create(pablo, dep, body({ firstName: 'Mateo', lastName: 'Ríos' })).expect(201);
    expect(res.body).toMatchObject({ player: { firstName: 'Mateo', lastName: 'Ríos', position: 'FORWARD', age: expect.any(Number) }, status: 'ACTIVE', leftAt: null });
    expect(res.body.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const id = res.body.player.id as string;
    expect(await active(dep, id)).toBe(1);
    const doc = await players.findById(id).lean();
    expect(doc).toMatchObject({ firstName: 'Mateo', lastName: 'Ríos', birthDate: '2001-04-18' });
    expect(doc!.createdBy!.toHexString()).toBe(pablo.id); // auditoría: quién registró la ficha
    expect(doc).not.toHaveProperty('userId'); // Player ≠ User
    const list = (await as(pablo).get(`/api/teams/${dep}/global-roster`).expect(200)).body.players as { player: { id: string } }[];
    expect(list.map((p) => p.player.id)).toContain(id);
  });

  it('MANAGER crea (201)', async () => {
    const res = await create(carlos, dep).expect(201);
    expect(await active(dep, res.body.player.id)).toBe(1);
  });

  it('usuario sin rol, organizador de un torneo del equipo y User.role legacy → 403 y no se crea ninguna ficha', async () => {
    const before = await players.countDocuments();
    await create(zoe, dep).expect(403);
    await create(L, dep).expect(403); // organiza la Liga y además creó el equipo (createdBy) con OWNER existente
    expect(await players.countDocuments()).toBe(before);
  });

  it('createdBy de un equipo SIN OWNER tampoco crea (la custodia de 6A no se extiende a la plantilla)', async () => {
    const huerfano = await team(L, 'Sin dueño');
    await create(L, huerfano).expect(403);
  });

  it('sin sesión 401; equipo inexistente 404; body inválido 400 (sin crear nada)', async () => {
    const before = await players.countDocuments();
    await api().post(`/api/teams/${dep}/global-roster/players`).send(body()).expect(401);
    await create(pablo, '000000000000000000000000').expect(404);
    await create(pablo, 'no-es-id').expect(400);
    await create(pablo, dep, body({ requestId: 'x' })).expect(400);
    await create(pablo, dep, { ...body(), requestId: undefined }).expect(400);
    await create(pablo, dep, body({ firstName: '  ' })).expect(400);
    await create(pablo, dep, body({ position: 'PORTERO' })).expect(400);
    await create(pablo, dep, body({ birthDate: '2999-01-01' })).expect(400);
    await create(pablo, dep, body({ jerseyNumber: 10 })).expect(400); // sin dorsal global
    await create(pablo, dep, body({ createdBy: zoe.id })).expect(400);
    await create(pablo, dep, body({ userId: zoe.id })).expect(400); // no se vincula User aquí
    expect(await players.countDocuments()).toBe(before);
  });
});

describe('Sin efectos fuera de la plantilla global', () => {
  it('no crea TeamMembership, TournamentTeam ni estadísticas; el perfil queda en cero', async () => {
    const [m, tt, s] = await Promise.all([memberships.countDocuments(), tournamentTeams.countDocuments(), stats.countDocuments()]);
    const id = (await create(pablo, dep).expect(201)).body.player.id as string;
    expect(await memberships.countDocuments()).toBe(m);
    expect(await tournamentTeams.countDocuments()).toBe(tt);
    expect(await stats.countDocuments()).toBe(s);
    expect(await memberships.exists({ playerId: oid(id) })).toBeNull();
    const p = (await api().get(`/api/players/${id}/profile`).expect(200)).body;
    expect(p.career).toMatchObject({ appearances: 0, teams: 0, competitions: 0, titles: 0 });
    expect(p).toMatchObject({ competitions: [], byTeam: [], honors: [], currentParticipations: [], history: [] });
  });

  it('el Player es global: aparece en la búsqueda pública por palabras en cualquier orden', async () => {
    const id = (await create(pablo, dep, body({ firstName: 'Juan Alberto', lastName: 'Pérez Quintero' })).expect(201)).body.player.id;
    for (const q of ['juan perez', 'Pérez Juan', 'quintero', 'JUAN ALBERTO PEREZ']) {
      const found = (await api().get(`/api/players`).query({ search: q, limit: 100 }).expect(200)).body.data as { id: string }[];
      expect(found.map((x) => x.id)).toContain(id);
    }
    const none = (await api().get('/api/players').query({ search: 'juan zzzz' }).expect(200)).body.data;
    expect(none).toEqual([]);
  });

  it('privacidad: ni la respuesta ni la búsqueda exponen fecha, creador, clave de petición ni datos de cuenta', async () => {
    const FORBIDDEN = ['birthDate', 'email', 'createdBy', 'addedBy', 'removedBy', 'searchName', 'creationRequestId', 'passwordHash', 'userId'];
    const walk = (v: unknown): string[] =>
      Array.isArray(v) ? v.flatMap(walk) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) ? [k] : []), ...walk(x)]) : [];
    const b = body({ lastName: 'Privado Único' });
    const created = (await create(pablo, dep, b).expect(201)).body;
    const search = (await api().get('/api/players').query({ search: 'privado unico' }).expect(200)).body;
    const one = (await api().get(`/api/players/${created.player.id}`).expect(200)).body;
    for (const x of [created, search, one]) {
      expect(walk(x)).toEqual([]);
      expect(JSON.stringify(x)).not.toContain(pablo.id);
      expect(JSON.stringify(x)).not.toContain(b.requestId);
    }
  });

  it('la custodia de la ficha (createdBy) no da acceso al equipo: si el OWNER pierde el rol, pierde la plantilla', async () => {
    const otro = await team(L, 'Taller');
    await admins.assignOwner(otro, zoe.id);
    await as(zoe).post(`/api/teams/${otro}/managers`).send({ userId: carlos.id }).expect(201);
    await create(carlos, otro).expect(201);
    const carlosId = carlos.id;
    await as(zoe).delete(`/api/teams/${otro}/managers/${carlosId}`).expect(204);
    await create(carlos, otro).expect(403);
    await as(carlos).get(`/api/teams/${otro}/global-roster`).expect(403);
  });
});

describe('Idempotencia y concurrencia', () => {
  it('reintento con el mismo requestId: 200, mismo jugador, una sola ficha y un solo ACTIVE', async () => {
    const b = body();
    const first = (await create(pablo, dep, b).expect(201)).body;
    const again = (await create(pablo, dep, b).expect(200)).body;
    expect(again).toEqual(first);
    expect(await players.countDocuments({ lastName: b.lastName })).toBe(1);
    expect(await active(dep, first.player.id)).toBe(1);
  });

  it('8 peticiones simultáneas con el mismo requestId (doble clic) → 1 ficha, 1 ACTIVE, un 201 y el resto 200', async () => {
    const b = body();
    const res = await Promise.all(Array.from({ length: 8 }, () => create(pablo, dep, b)));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(res.map((r) => r.body.player.id)).size).toBe(1);
    expect(await players.countDocuments({ lastName: b.lastName })).toBe(1);
    expect(await active(dep, res[0].body.player.id)).toBe(1);
    expect(await rosters.countDocuments({ playerId: oid(res[0].body.player.id) })).toBe(1);
  });

  it('mismo nombre con otro requestId → otra persona (sin fusión automática por nombre)', async () => {
    const same = { firstName: 'Luis', lastName: 'García Homónimo', position: 'DEFENDER' };
    const a = (await create(pablo, dep, { ...same, requestId: randomUUID(), confirmNew: true }).expect(201)).body.player.id;
    const b = (await create(carlos, dep, { ...same, requestId: randomUUID(), confirmNew: true }).expect(201)).body.player.id;
    expect(a).not.toBe(b);
    expect(await players.countDocuments({ lastName: 'García Homónimo' })).toBe(2);
  });

  it('la misma clave de otro usuario no colisiona (la idempotencia es por usuario)', async () => {
    const requestId = randomUUID();
    const a = (await create(pablo, dep, body({ requestId })).expect(201)).body.player.id;
    const b = (await create(carlos, dep, body({ requestId })).expect(201)).body.player.id;
    expect(a).not.toBe(b);
  });

  it('si el alta en la plantilla falla, no queda ficha huérfana (transacción)', async () => {
    const before = await players.countDocuments();
    const spy = vi.spyOn(rosters, 'create').mockImplementationOnce(() => Promise.reject(new Error('fallo simulado')));
    try {
      await create(pablo, dep).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(await players.countDocuments()).toBe(before);
  });
});

describe('Historial y reincorporación (reglas de 6B intactas)', () => {
  it('creado → retirado (INACTIVE, conserva periodo) → reincorporado con POST existente (periodo nuevo)', async () => {
    const id = (await create(pablo, dep).expect(201)).body.player.id as string;
    await as(pablo).delete(`/api/teams/${dep}/global-roster/${id}`).expect(204);
    const closed = (await as(pablo).get(`/api/teams/${dep}/global-roster?status=inactive`).expect(200)).body.players.filter(
      (p: { player: { id: string } }) => p.player.id === id,
    );
    expect(closed).toHaveLength(1);
    await as(carlos).post(`/api/teams/${dep}/global-roster`).send({ playerId: id }).expect(201);
    const all = (await as(pablo).get(`/api/teams/${dep}/global-roster?status=all`).expect(200)).body.players.filter(
      (p: { player: { id: string } }) => p.player.id === id,
    );
    expect(all.map((p: { status: string }) => p.status)).toEqual(['ACTIVE', 'INACTIVE']);
    expect(all[1]).toEqual(closed[0]);
    expect(await active(dep, id)).toBe(1);
  });

  it('el jugador creado se puede agregar a otro equipo (identidad global, no privada del equipo)', async () => {
    const id = (await create(pablo, dep).expect(201)).body.player.id as string;
    const otro = await team(L, 'Olas Altas');
    await admins.assignOwner(otro, zoe.id);
    await as(zoe).post(`/api/teams/${otro}/global-roster`).send({ playerId: id }).expect(201);
    expect(await active(otro, id)).toBe(1);
    expect(await active(dep, id)).toBe(1);
  });
});
