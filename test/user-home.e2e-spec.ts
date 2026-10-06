/**
 * Panel según capacidades reales (nunca User.role): organizar torneos se activa voluntariamente
 * ("Quiero organizar un torneo") o se conserva si ya organizas; administrar equipos sale de
 * TeamAdmin. Inscripciones incompletas por enlace (registration_drafts): se guardan mientras se
 * avanza, se retoman, y se borran al enviar o al cancelar sin tocar equipos ni jugadores. API real.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { User } from '../src/modules/users/schemas/user.schema.js';
import { Tournament } from '../src/modules/tournaments/schemas/tournament.schema.js';
import { RegistrationDraft } from '../src/modules/registration/schemas/registration-draft.schema.js';
import { TeamAdmin } from '../src/modules/teams/schemas/team-admin.schema.js';
import { TeamAdminStatus, UserRole } from '../src/common/enums/index.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type Acc = { id: string; token: string };
const as = (u: Acc) => authed(http, u.token);
let users: Model<User>;
let tournaments: Model<Tournament>;
let drafts: Model<RegistrationDraft>;
let admins: Model<TeamAdmin>;
let O: Acc;
let seq = 0;

/** Cuenta "de club": se registra sin activar organizar (como quien llega por un enlace). */
async function clubAccount(name: string): Promise<Acc> {
  const res = await api().post('/api/auth/register').send({ firstName: name, lastName: 'Club', email: `${name.toLowerCase()}${++seq}@club.test`, password: 'password123' }).expect(201);
  return { id: res.body.user.id, token: res.body.accessToken };
}
const home = async (u: Acc) => (await as(u).get('/api/me/home').expect(200)).body;
const newTournament = (u: Acc, name = `Liga ${++seq}`) => as(u).post('/api/tournaments').send({ name, format: 'FOOTBALL_7', category: 'Libre', startDate: '2099-01-01', status: 'ACTIVE' });
async function openLink() {
  const t = (await newTournament(O).expect(201)).body.id as string;
  await as(O).patch(`/api/tournaments/${t}/registration`).send({ enabled: true }).expect(200);
  const token = (await as(O).post(`/api/tournaments/${t}/registration-link`).expect(200)).body.link.token as string;
  return { t, token };
}
async function playerFor(owner: Acc, team: string) {
  const r = await as(owner).post(`/api/teams/${team}/global-roster/players`).send({ firstName: 'Jugador', lastName: `Club ${++seq}`, position: 'FORWARD', requestId: randomUUID(), confirmNew: true }).expect(201);
  return r.body.player.id as string;
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  users = ctx.app.get(getModelToken(User.name));
  tournaments = ctx.app.get(getModelToken(Tournament.name));
  drafts = ctx.app.get(getModelToken(RegistrationDraft.name));
  admins = ctx.app.get(getModelToken(TeamAdmin.name));
  const o = await registerOrganizer(http, 'Organiza');
  O = { id: o.id, token: o.token };
});
afterAll(async () => ctx?.close());

describe('Capacidad de organizar torneos', () => {
  it('cuenta nueva: no organiza, no ve torneos y crear torneo → 403 ORGANIZER_NOT_ENABLED (aunque User.role sea ORGANIZER)', async () => {
    const u = await clubAccount('Nuevo');
    expect(await home(u)).toMatchObject({ organizer: { canOrganize: false, enabled: false, tournaments: 0 }, teams: { total: 0 }, registrations: { drafts: [], pendingRequests: [] } });
    expect((await users.findById(u.id).lean())!.role).toBe(UserRole.ORGANIZER); // legacy: no cuenta
    const res = await newTournament(u).expect(403);
    expect(res.body.code).toBe('ORGANIZER_NOT_ENABLED');
  });

  it('"Quiero organizar un torneo": activa (idempotente, conserva la fecha) y ya puede crear', async () => {
    const u = await clubAccount('Quiere');
    const first = (await as(u).post('/api/me/organizer').expect(200)).body;
    expect(first).toMatchObject({ canOrganize: true, enabled: true });
    const at = (await users.findById(u.id).lean())!.organizerEnabledAt!.getTime();
    await as(u).post('/api/me/organizer').expect(200);
    expect((await users.findById(u.id).lean())!.organizerEnabledAt!.getTime()).toBe(at);
    await newTournament(u).expect(201);
    expect((await home(u)).organizer).toMatchObject({ canOrganize: true, tournaments: 1 });
  });

  it('quien ya organiza un torneo conserva el acceso aunque nunca lo activara (cuentas anteriores)', async () => {
    const u = await clubAccount('Antiguo');
    await as(u).post('/api/me/organizer').expect(200);
    await newTournament(u).expect(201);
    await users.updateOne({ _id: new Types.ObjectId(u.id) }, { $set: { organizerEnabledAt: null } });
    expect((await home(u)).organizer).toMatchObject({ canOrganize: true, enabled: false, tournaments: 1 });
    await newTournament(u).expect(201);
  });

  it('sin sesión: 401', async () => {
    await api().get('/api/me/home').expect(401);
    await api().post('/api/me/organizer').expect(401);
  });
});

describe('Mi equipo desde el panel', () => {
  it('POST /me/teams: quedo como OWNER (aparece en Mis equipos) sin poder organizar torneos', async () => {
    const u = await clubAccount('Capitan');
    const team = (await as(u).post('/api/me/teams').send({ name: `Club Propio ${++seq}` }).expect(201)).body;
    expect(team).toMatchObject({ id: expect.any(String), name: expect.stringMatching(/Club Propio/) });
    expect(await home(u)).toMatchObject({ teams: { total: 1, owner: 1, manager: 0 }, organizer: { canOrganize: false } });
    const mine = (await as(u).get('/api/admin/teams?limit=100').expect(200)).body.data as { id: string; myRole: string }[];
    expect(mine.find((t) => t.id === team.id)?.myRole).toBe('OWNER');
    await as(u).post('/api/me/teams').send({ name: '' }).expect(400);
  });
});

describe('Inscripciones incompletas (enlace de inscripción)', () => {
  let u: Acc, team: string, link: { t: string; token: string }, p1: string, p2: string;
  beforeAll(async () => {
    u = await clubAccount('Delegado');
    link = await openLink();
    team = (await as(u).post(`/api/tournament-registration/${link.token}/teams`).send({ name: `Equipo Enlace ${++seq}` }).expect(201)).body.team.id;
    [p1, p2] = [await playerFor(u, team), await playerFor(u, team)];
  });

  it('guardar el progreso (upsert) y recuperarlo; el panel lo muestra con torneo, equipo, paso y enlace', async () => {
    await as(u).put(`/api/tournament-registration/${link.token}/draft`).send({ teamId: team, playerIds: [p1], step: 'players' }).expect(200);
    const saved = (await as(u).put(`/api/tournament-registration/${link.token}/draft`).send({ teamId: team, playerIds: [p1, p2], step: 'review' }).expect(200)).body.draft;
    expect(saved).toMatchObject({ teamId: team, playerIds: [p1, p2], step: 'review' });
    expect((await as(u).get(`/api/tournament-registration/${link.token}/draft`).expect(200)).body.draft).toMatchObject({ teamId: team, step: 'review' });
    expect(await drafts.countDocuments({ userId: new Types.ObjectId(u.id) })).toBe(1);
    const h = await home(u);
    expect(h.registrations.drafts).toEqual([
      expect.objectContaining({ tournament: expect.objectContaining({ id: link.t }), team: expect.objectContaining({ id: team }), step: 'review', playerCount: 2, token: link.token }),
    ]);
    expect(h.organizer.canOrganize).toBe(false); // inscribir no convierte en organizador
  });

  it('solo con equipos que administro: otro equipo → 403; sin sesión 401; datos inválidos 400', async () => {
    const otro = await clubAccount('Ajeno');
    const ajeno = (await as(otro).post('/api/me/teams').send({ name: `Ajeno ${++seq}` }).expect(201)).body.id;
    await as(u).put(`/api/tournament-registration/${link.token}/draft`).send({ teamId: ajeno, playerIds: [], step: 'players' }).expect(403);
    await api().put(`/api/tournament-registration/${link.token}/draft`).send({ teamId: team, playerIds: [], step: 'players' }).expect(401);
    await as(u).put(`/api/tournament-registration/${link.token}/draft`).send({ teamId: team, playerIds: ['x'], step: 'players' }).expect(400);
    await as(u).put(`/api/tournament-registration/${link.token}/draft`).send({ teamId: team, playerIds: [], step: 'enviar' }).expect(400);
    // Nadie más ve mi borrador.
    expect((await home(otro)).registrations.drafts).toEqual([]);
    expect((await as(otro).get(`/api/tournament-registration/${link.token}/draft`).expect(200)).body).toEqual({ draft: null });
  });

  it('si dejo de administrar el equipo, el borrador vuelve a "elegir equipo" sin filtrar nada', async () => {
    await admins.updateOne({ teamId: new Types.ObjectId(team), userId: new Types.ObjectId(u.id) }, { $set: { status: TeamAdminStatus.INACTIVE } });
    expect((await as(u).get(`/api/tournament-registration/${link.token}/draft`).expect(200)).body.draft).toMatchObject({ teamId: null, playerIds: [], step: 'team' });
    await admins.updateOne({ teamId: new Types.ObjectId(team), userId: new Types.ObjectId(u.id) }, { $set: { status: TeamAdminStatus.ACTIVE } });
  });

  it('enviar la solicitud borra el borrador y pasa a "enviada, esperando al organizador"', async () => {
    await as(u).put(`/api/tournament-registration/${link.token}/draft`).send({ teamId: team, playerIds: [p1, p2], step: 'review' }).expect(200);
    await as(u).post(`/api/tournament-registration/${link.token}/requests`).send({ teamId: team, playerIds: [p1, p2] }).expect(201);
    const h = await home(u);
    expect(h.registrations.drafts).toEqual([]);
    expect(h.registrations.pendingRequests).toEqual([expect.objectContaining({ tournament: expect.objectContaining({ id: link.t }), team: expect.objectContaining({ id: team }), playerCount: 2, token: link.token })]);
    // Un guardado que llega tarde (después del envío) no resucita el borrador.
    expect((await as(u).put(`/api/tournament-registration/${link.token}/draft`).send({ teamId: team, playerIds: [p1], step: 'review' }).expect(200)).body).toEqual({ draft: null });
    expect((await home(u)).registrations.drafts).toEqual([]);
  });

  it('cancelar (por enlace o desde el panel) borra solo el borrador: equipo, plantilla y jugadores siguen', async () => {
    const l2 = await openLink();
    await as(u).put(`/api/tournament-registration/${l2.token}/draft`).send({ teamId: team, playerIds: [p1], step: 'players' }).expect(200);
    const rosterBefore = (await as(u).get(`/api/teams/${team}/global-roster`).expect(200)).body.players.length;
    await as(u).delete(`/api/tournament-registration/${l2.token}/draft`).expect(204);
    await as(u).delete(`/api/tournament-registration/${l2.token}/draft`).expect(204); // idempotente
    expect((await home(u)).registrations.drafts).toEqual([]);
    expect((await as(u).get(`/api/teams/${team}/global-roster`).expect(200)).body.players.length).toBe(rosterBefore);
    // Desde el panel, aunque el enlace ya no esté activo: el panel muestra token null y se puede cancelar.
    await as(u).put(`/api/tournament-registration/${l2.token}/draft`).send({ teamId: team, playerIds: [], step: 'players' }).expect(200);
    await as(O).delete(`/api/tournaments/${l2.t}/registration-link`).expect(204);
    expect((await home(u)).registrations.drafts[0]).toMatchObject({ token: null });
    await as(u).delete(`/api/me/registration-drafts/${l2.t}`).expect(204);
    expect((await home(u)).registrations.drafts).toEqual([]);
  });

  it('guardados simultáneos del primer borrador: uno solo por usuario y torneo', async () => {
    const l3 = await openLink();
    const res = await Promise.all(Array.from({ length: 6 }, () => as(u).put(`/api/tournament-registration/${l3.token}/draft`).send({ teamId: team, playerIds: [p1], step: 'players' })));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect(await drafts.countDocuments({ userId: new Types.ObjectId(u.id), tournamentId: new Types.ObjectId(l3.t) })).toBe(1);
  });

  it('privacidad: el panel no expone datos de otras cuentas ni internos', async () => {
    const json = JSON.stringify(await home(u));
    for (const k of ['organizerId', 'submittedBy', 'createdBy', 'tokenHash', 'tokenCiphertext', 'email', 'passwordHash']) expect(json).not.toContain(k);
    expect(await tournaments.countDocuments({ organizerId: new Types.ObjectId(u.id) })).toBe(0);
  });
});
