/**
 * Etapa 7 — Inscripción de equipos por link. Enlace privado (token), solicitudes con la plantilla
 * GLOBAL del equipo, aprobación atómica que crea TournamentTeam + TeamMembership, permisos por
 * relación (organizador / OWNER-MANAGER), concurrencia, privacidad. API real.
 */
import request from 'supertest';
import mongoose, { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { TeamAdminsService } from '../src/modules/teams/team-admins.service.js';
import { TeamMembership } from '../src/modules/players/schemas/team-membership.schema.js';
import { TournamentTeam } from '../src/modules/tournaments/schemas/tournament-team.schema.js';
import { RegistrationLink } from '../src/modules/registration/schemas/registration-link.schema.js';
import { RegistrationRequest } from '../src/modules/registration/schemas/registration-request.schema.js';
import { TeamRoster } from '../src/modules/teams/schemas/team-roster.schema.js';
import { TeamAdmin } from '../src/modules/teams/schemas/team-admin.schema.js';
import { RegistrationLinkStatus, RegistrationRequestStatus, TeamAdminRole, TeamAdminSource, TeamAdminStatus, TeamRosterStatus } from '../src/common/enums/index.js';
import { todayISODate } from '../src/common/utils/dates.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type U = Awaited<ReturnType<typeof registerOrganizer>>;
const as = (u: U) => authed(http, u.token);
const oid = (id: string) => new Types.ObjectId(id);
let admins: TeamAdminsService;
let memberships: Model<TeamMembership>;
let enrollments: Model<TournamentTeam>;
let links: Model<RegistrationLink>;
let requests: Model<RegistrationRequest>;
let rosters: Model<TeamRoster>;
let teamAdmins: Model<TeamAdmin>;

/** L organiza; Pablo es OWNER (y organiza su propio torneo); Carlos MANAGER; Zoe no tiene nada. */
let L: U, pablo: U, carlos: U, zoe: U;
let seq = 0;
const team = async (by: U, name = 'Equipo') => (await as(by).post('/api/teams').send({ name: `${name} ${++seq}` }).expect(201)).body.id as string;
const player = async (by: U, first = 'Jugador') =>
  (await as(by).post('/api/players').send({ confirmNew: true, firstName: first, lastName: `Apellido ${++seq}`, position: 'MIDFIELDER', birthDate: '2000-02-02' }).expect(201)).body.id as string;
const tournament = async (by: U, name = 'Liga') =>
  (await as(by).post('/api/tournaments').send({ name: `${name} ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-02-01', status: 'ACTIVE' }).expect(201)).body.id as string;
/** Torneo con inscripción abierta y enlace generado. */
async function openTournament(by: U, settings: Record<string, unknown> = {}) {
  const t = await tournament(by);
  await as(by).patch(`/api/tournaments/${t}/registration`).send({ enabled: true, ...settings }).expect(200);
  const token = (await as(by).post(`/api/tournaments/${t}/registration-link`).expect(200)).body.link.token as string;
  return { t, token };
}
/** Equipo con OWNER y plantilla global de `n` jugadores. */
async function ownedTeam(owner: U, n: number, name = 'Deportivo') {
  const t = await team(L, name);
  await admins.assignOwner(t, owner.id);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = await player(L);
    await as(owner).post(`/api/teams/${t}/global-roster`).send({ playerId: p }).expect(201);
    ids.push(p);
  }
  return { team: t, players: ids };
}
const submit = (u: U, token: string, teamId: string, playerIds: string[]) => as(u).post(`/api/tournament-registration/${token}/requests`).send({ teamId, playerIds });
const approve = (u: U, t: string, r: string) => as(u).post(`/api/tournaments/${t}/registration-requests/${r}/approve`);
const reject = (u: U, t: string, r: string, reason?: string) => as(u).post(`/api/tournaments/${t}/registration-requests/${r}/reject`).send(reason ? { reason } : {});
const activeMemberships = (t: string, teamId?: string) => memberships.countDocuments({ tournamentId: oid(t), ...(teamId ? { teamId: oid(teamId) } : {}), active: true });

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  admins = ctx.app.get(TeamAdminsService);
  memberships = ctx.app.get(getModelToken(TeamMembership.name));
  enrollments = ctx.app.get(getModelToken(TournamentTeam.name));
  links = ctx.app.get(getModelToken(RegistrationLink.name));
  requests = ctx.app.get(getModelToken(RegistrationRequest.name));
  rosters = ctx.app.get(getModelToken(TeamRoster.name));
  teamAdmins = ctx.app.get(getModelToken(TeamAdmin.name));
  [L, pablo, carlos, zoe] = [await registerOrganizer(http, 'Liga'), await registerOrganizer(http, 'Pablo'), await registerOrganizer(http, 'Carlos'), await registerOrganizer(http, 'Zoe')];
});
afterAll(async () => ctx?.close());

describe('Configuración de inscripción (organizador)', () => {
  it('por defecto cerrada y sin límites; abrir y configurar; validaciones; solo su organizador', async () => {
    const t = await tournament(L);
    const initial = (await as(L).get(`/api/tournaments/${t}/registration`).expect(200)).body;
    expect(initial).toMatchObject({
      registration: { enabled: false, approvalRequired: true, minPlayers: null, maxPlayers: null, maxTeams: null, deadline: null },
      open: false,
      closedReason: 'DISABLED',
      link: null,
      counts: { PENDING: 0, APPROVED: 0, REJECTED: 0, CANCELLED: 0 },
    });
    const updated = (await as(L).patch(`/api/tournaments/${t}/registration`).send({ enabled: true, minPlayers: 12, maxPlayers: 20, maxTeams: 16, deadline: '2099-10-15' }).expect(200)).body;
    expect(updated).toMatchObject({ open: true, registration: { minPlayers: 12, maxPlayers: 20, maxTeams: 16, deadline: '2099-10-15' } });
    await as(L).patch(`/api/tournaments/${t}/registration`).send({ minPlayers: 21 }).expect(400); // min > max
    await as(L).patch(`/api/tournaments/${t}/registration`).send({ deadline: '15/10/2099' }).expect(400);
    await as(L).patch(`/api/tournaments/${t}/registration`).send({ approvalRequired: false }).expect(400); // V1: siempre con aprobación
    await as(L).patch(`/api/tournaments/${t}/registration`).send({ maxPlayers: null }).expect(200); // null quita el límite
    for (const u of [pablo, zoe]) {
      await as(u).get(`/api/tournaments/${t}/registration`).expect(403);
      await as(u).patch(`/api/tournaments/${t}/registration`).send({ enabled: false }).expect(403);
      await as(u).post(`/api/tournaments/${t}/registration-link`).expect(403);
    }
    await api().get(`/api/tournaments/${t}/registration`).expect(401);
  });
});

describe('Enlace privado', () => {
  it('generar → resolver (público, sin datos internos) → re-copiar el mismo → regenerar (el viejo muere) → revocar', async () => {
    const t = await tournament(L, 'Apertura');
    await as(L).patch(`/api/tournaments/${t}/registration`).send({ enabled: true, minPlayers: 2, maxPlayers: 20 }).expect(200);
    const first = (await as(L).post(`/api/tournaments/${t}/registration-link`).expect(200)).body.link.token as string;
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(t);
    expect((await as(L).get(`/api/tournaments/${t}/registration`).expect(200)).body.link.token).toBe(first); // se puede volver a copiar

    const pub = (await api().get(`/api/tournament-registration/${first}`).expect(200)).body;
    expect(pub).toMatchObject({ tournament: { id: t, status: 'ACTIVE' }, registration: { open: true, minPlayers: 2, maxPlayers: 20, spotsLeft: null } });
    const json = JSON.stringify(pub);
    for (const k of ['organizerId', 'createdBy', 'tokenHash', 'tokenCiphertext', 'writeSeq', 'email', 'settings', 'phases']) expect(json).not.toContain(`"${k}"`);
    expect(json).not.toContain(L.id);

    const stored = await links.findOne({ tournamentId: oid(t) }).select('+tokenCiphertext').lean();
    expect(JSON.stringify(stored)).not.toContain(first); // nunca en claro

    const second = (await as(L).post(`/api/tournaments/${t}/registration-link`).expect(200)).body.link.token as string;
    expect(second).not.toBe(first);
    await api().get(`/api/tournament-registration/${first}`).expect(404);
    await api().get(`/api/tournament-registration/${second}`).expect(200);

    await as(L).delete(`/api/tournaments/${t}/registration-link`).expect(204);
    await api().get(`/api/tournament-registration/${second}`).expect(404);
    await as(L).delete(`/api/tournaments/${t}/registration-link`).expect(404);
    expect((await as(L).get(`/api/tournaments/${t}/registration`).expect(200)).body.link).toBeNull();
  });

  it('tokens malformados o inexistentes: 404 con el mismo mensaje (no revelan nada)', async () => {
    const bad = ['x', 'a'.repeat(43), '../../etc', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!'];
    const messages = new Set<string>();
    for (const tok of bad) messages.add((await api().get(`/api/tournament-registration/${encodeURIComponent(tok)}`).expect(404)).body.message);
    expect(messages.size).toBe(1);
  });

  it('regenerar 5 veces a la vez → exactamente un enlace ACTIVE', async () => {
    const t = await tournament(L);
    await Promise.all(Array.from({ length: 5 }, () => as(L).post(`/api/tournaments/${t}/registration-link`)));
    expect(await links.countDocuments({ tournamentId: oid(t), status: RegistrationLinkStatus.ACTIVE })).toBe(1);
  });
});

describe('Permisos: el link no autoriza; se inscribe como OWNER/MANAGER', () => {
  it('OWNER y MANAGER envían; usuario cualquiera, organizador sin rol y creador sin OWNER no', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 3);
    const tig = await ownedTeam(zoe, 2, 'Tigres');
    await as(zoe).post(`/api/teams/${tig.team}/managers`).send({ userId: carlos.id }).expect(201);
    await submit(zoe, token, dep.team, dep.players).expect(403); // equipo ajeno
    await submit(L, token, dep.team, dep.players).expect(403); // organizador del torneo, sin rol en el equipo
    const custody = await team(L, 'Sin dueño'); // L lo creó: custodia de ficha, NO administración
    await submit(L, token, custody, dep.players).expect(403);
    await api().post(`/api/tournament-registration/${token}/requests`).send({ teamId: dep.team, playerIds: dep.players }).expect(401);
    await submit(pablo, token, dep.team, dep.players).expect(201); // OWNER
    await submit(carlos, token, tig.team, tig.players).expect(201); // MANAGER
    expect(await requests.countDocuments({ tournamentId: oid(t), status: RegistrationRequestStatus.PENDING })).toBe(2);
  });

  it('un OWNER no puede aprobarse a sí mismo en un torneo ajeno; si además organiza el torneo, sí (multirol)', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 2);
    const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
    await approve(pablo, t, r).expect(403);
    await reject(pablo, t, r).expect(403);
    await as(pablo).get(`/api/tournaments/${t}/registration-requests`).expect(403);

    const own = await openTournament(pablo); // Pablo organiza su torneo y es OWNER de su equipo
    const r2 = (await submit(pablo, own.token, dep.team, dep.players).expect(201)).body.id;
    await approve(pablo, own.t, r2).expect(200); // autorizado por organizerId, no por TeamAdmin
    expect(await enrollments.countDocuments({ tournamentId: oid(own.t), teamId: oid(dep.team) })).toBe(1);
  });
});

describe('Selección desde la plantilla GLOBAL ACTIVE', () => {
  it('solo jugadores ACTIVE del equipo; límites min/max en el servidor; sin repetidos', async () => {
    const { token } = await openTournament(L, { minPlayers: 2, maxPlayers: 3 });
    const dep = await ownedTeam(pablo, 4);
    const outsider = await player(L);
    await as(pablo).delete(`/api/teams/${dep.team}/global-roster/${dep.players[3]}`).expect(204);
    let res = await submit(pablo, token, dep.team, [dep.players[0], outsider]).expect(409);
    expect(res.body.problems.map((p: { code: string }) => p.code)).toContain('NOT_IN_ROSTER');
    res = await submit(pablo, token, dep.team, [dep.players[0], dep.players[3]]).expect(409); // retirado: INACTIVE
    expect(res.body.problems[0].playerIds).toEqual([dep.players[3]]);
    expect((await submit(pablo, token, dep.team, [dep.players[0]]).expect(409)).body.problems[0].code).toBe('TOO_FEW');
    const five = await ownedTeam(pablo, 5);
    expect((await submit(pablo, token, five.team, five.players).expect(409)).body.problems[0].code).toBe('TOO_MANY');
    await submit(pablo, token, dep.team, [dep.players[0], dep.players[0]]).expect(400);
    await submit(pablo, token, dep.team, []).expect(400);
    await submit(pablo, token, dep.team, dep.players.slice(0, 3)).expect(201);
  });

  it('la solicitud conserva la selección enviada aunque la plantilla cambie después', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 3);
    const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
    const extra = await player(L);
    await as(pablo).post(`/api/teams/${dep.team}/global-roster`).send({ playerId: extra }).expect(201);
    const detail = (await as(L).get(`/api/tournaments/${t}/registration-requests/${r}`).expect(200)).body;
    expect(detail.players.map((p: { player: { id: string } }) => p.player.id)).toEqual(dep.players);
    expect(detail.playerCount).toBe(3);
  });
});

describe('Ciclo de vida de la solicitud', () => {
  it('una PENDING por equipo; 5 envíos simultáneos → 1; rechazo con motivo → reintento → cancelar → otra', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 2);
    const res = await Promise.all(Array.from({ length: 5 }, () => submit(pablo, token, dep.team, dep.players)));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    const first = res.find((r) => r.status === 201)!.body.id;
    await submit(pablo, token, dep.team, dep.players).expect(409);

    const rejected = (await reject(L, t, first, 'La plantilla está incompleta').expect(200)).body;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectionReason: 'La plantilla está incompleta' });
    await reject(L, t, first).expect(409);
    await approve(L, t, first).expect(409);

    const second = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
    await as(zoe).post(`/api/tournament-registration/${token}/requests/${second}/cancel`).expect(403);
    await as(pablo).post(`/api/tournament-registration/${token}/requests/${second}/cancel`).expect(204);
    await as(pablo).post(`/api/tournament-registration/${token}/requests/${second}/cancel`).expect(409);
    await approve(L, t, second).expect(409);
    const third = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;

    const history = (await as(pablo).get(`/api/tournament-registration/${token}/my-teams`).expect(200)).body.teams.find((x: { team: { id: string } }) => x.team.id === dep.team);
    expect(history.requests.map((r: { status: string }) => r.status)).toEqual(['PENDING', 'CANCELLED', 'REJECTED']);
    expect(history.requests[2].rejectionReason).toBe('La plantilla está incompleta');
    expect(await requests.countDocuments({ tournamentId: oid(t), teamId: oid(dep.team) })).toBe(3); // nada se borra
    const list = (await as(L).get(`/api/tournaments/${t}/registration-requests?status=PENDING`).expect(200)).body;
    expect(list.requests.map((r: { id: string }) => r.id)).toEqual([third]);
    expect(list.counts).toMatchObject({ PENDING: 1, REJECTED: 1, CANCELLED: 1, APPROVED: 0 });
  });

  it('equipo ya inscrito manualmente por el organizador → no puede solicitar', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 2);
    await as(L).post(`/api/tournaments/${t}/teams/${dep.team}`).expect(201);
    const res = await submit(pablo, token, dep.team, dep.players).expect(409);
    expect(res.body.message).toMatch(/ya está inscrito en el torneo/);
  });
});

describe('Aprobación atómica y casos de dominio', () => {
  it('CASO A–C: aprobar crea TournamentTeam + TeamMembership sin tocar la plantilla; retiros independientes', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 3);
    const [juan, pedro] = dep.players;
    const rosterBefore = await rosters.find({ teamId: oid(dep.team) }).lean();
    const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
    const approved = (await approve(L, t, r).expect(200)).body;
    expect(approved).toMatchObject({ status: 'APPROVED', problems: [] });
    expect(await enrollments.countDocuments({ tournamentId: oid(t), teamId: oid(dep.team) })).toBe(1);
    const ms = await memberships.find({ tournamentId: oid(t), teamId: oid(dep.team) }).lean();
    expect(ms.map((m) => [m.playerId.toHexString(), m.active, m.jerseyNumber, m.startDate]).sort()).toEqual(dep.players.map((p) => [p, true, null, todayISODate()]).sort());
    expect(await rosters.find({ teamId: oid(dep.team) }).lean()).toEqual(rosterBefore); // CASO A: plantilla intacta
    // Plantilla del torneo (flujo existente) muestra a los 3.
    expect((await api().get(`/api/tournaments/${t}/players?teamId=${dep.team}`).expect(200)).body).toHaveLength(3);
    // Partido con goles de Juan (historia oficial).
    const rival = await team(L, 'Rival');
    await as(L).post(`/api/tournaments/${t}/teams/${rival}`).expect(201);
    const m = (await as(L).post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: dep.team, awayTeamId: rival, date: '2027-02-10', time: '18:00' }).expect(201)).body.id;
    await as(L).put(`/api/matches/${m}/result`).send({ homeScore: 2, awayScore: 0, playerStats: [{ playerId: juan, teamId: dep.team, played: true, goals: 2, assists: 0, yellowCards: 0, redCards: 0 }] }).expect(200);
    const statsBefore = (await api().get(`/api/players/${juan}/stats`).expect(200)).body;

    // CASO B: retiro GLOBAL de Juan → su participación y estadísticas quedan.
    await as(pablo).delete(`/api/teams/${dep.team}/global-roster/${juan}`).expect(204);
    expect(await memberships.countDocuments({ tournamentId: oid(t), playerId: oid(juan), active: true })).toBe(1);
    expect((await api().get(`/api/players/${juan}/stats`).expect(200)).body).toEqual(statsBefore);

    // CASO C: el organizador retira a Pedro del torneo → su plantilla global sigue ACTIVE.
    await as(L).delete(`/api/tournaments/${t}/players/${pedro}`).expect(204);
    expect(await memberships.countDocuments({ tournamentId: oid(t), playerId: oid(pedro), active: true })).toBe(0);
    expect(await rosters.countDocuments({ teamId: oid(dep.team), playerId: oid(pedro), status: TeamRosterStatus.ACTIVE })).toBe(1);

    // Ya aprobado: el equipo ve su estado y no puede volver a solicitar.
    const mine = (await as(pablo).get(`/api/tournament-registration/${token}/my-teams`).expect(200)).body.teams.find((x: { team: { id: string } }) => x.team.id === dep.team);
    expect(mine).toMatchObject({ enrolled: true, requests: [{ status: 'APPROVED' }] });
    await submit(pablo, token, dep.team, [pedro]).expect(409);
  });

  it('CASO D: el mismo jugador en equipos distintos de torneos distintos; CASO E: dos equipos del mismo torneo → bloqueado sin estado parcial', async () => {
    const juan = await player(L, 'Juan');
    const teams = [];
    for (const [owner, name] of [[pablo, 'Deportivo'], [zoe, 'Tigres'], [carlos, 'Halcones']] as const) {
      const t = await team(L, name);
      await admins.assignOwner(t, owner.id);
      await as(owner).post(`/api/teams/${t}/global-roster`).send({ playerId: juan }).expect(201);
      teams.push({ owner, t });
    }
    const leagues = [await openTournament(L), await openTournament(L), await openTournament(L)];
    for (let i = 0; i < 3; i++) {
      const r = (await submit(teams[i].owner, leagues[i].token, teams[i].t, [juan]).expect(201)).body.id;
      await approve(L, leagues[i].t, r).expect(200);
    }
    expect(await memberships.countDocuments({ playerId: oid(juan), active: true })).toBe(3); // CASO D

    // CASO E: Tigres intenta a Juan en la liga donde ya juega con Deportivo.
    const r = (await submit(zoe, leagues[0].token, teams[1].t, [juan]).expect(409)).body;
    expect(r.problems.map((p: { code: string }) => p.code)).toContain('OTHER_TEAM');
    expect(r.message).toMatch(/ya juega con Deportivo/);
  });

  it('la plantilla cambió antes de aprobar → 409 y NADA se crea (la solicitud sigue PENDING); el detalle lo señala', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 3);
    const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
    await as(pablo).delete(`/api/teams/${dep.team}/global-roster/${dep.players[1]}`).expect(204);
    const detail = (await as(L).get(`/api/tournaments/${t}/registration-requests/${r}`).expect(200)).body;
    expect(detail.problems[0].code).toBe('NOT_IN_ROSTER');
    expect(detail.players.find((p: { player: { id: string } }) => p.player.id === dep.players[1]).problem).toBe('NOT_IN_ROSTER');
    expect((await approve(L, t, r).expect(409)).body.message).toMatch(/La plantilla cambió/);
    expect(await enrollments.countDocuments({ tournamentId: oid(t) })).toBe(0);
    expect(await activeMemberships(t)).toBe(0);
    expect((await requests.findById(r).lean())!.status).toBe('PENDING');
  });
});

describe('Concurrencia de aprobaciones', () => {
  it('4 aprobaciones simultáneas de la misma solicitud → 1 inscripción, N membresías únicas, 1 APPROVED', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 4);
    const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
    const res = await Promise.all([1, 2, 3, 4].map(() => approve(L, t, r)));
    expect(res.map((x) => x.status).sort()).toEqual([200, 409, 409, 409]);
    expect(await enrollments.countDocuments({ tournamentId: oid(t) })).toBe(1);
    expect(await activeMemberships(t)).toBe(4);
  });

  it('último cupo: maxTeams = 2 con 1 inscrito y 3 aprobaciones a la vez → nunca más de 2 equipos', async () => {
    const { t, token } = await openTournament(L, { maxTeams: 2 });
    const pre = await ownedTeam(pablo, 1);
    await approve(L, t, (await submit(pablo, token, pre.team, pre.players).expect(201)).body.id).expect(200);
    const pending = [];
    for (let i = 0; i < 3; i++) {
      const x = await ownedTeam(pablo, 1, `Aspirante ${i}`);
      pending.push((await submit(pablo, token, x.team, x.players).expect(201)).body.id);
    }
    const res = await Promise.all(pending.map((r) => approve(L, t, r)));
    expect(res.filter((x) => x.status === 200)).toHaveLength(1);
    expect(await enrollments.countDocuments({ tournamentId: oid(t) })).toBe(2);
    expect(await activeMemberships(t)).toBe(2);
    expect((await api().get(`/api/tournament-registration/${token}`).expect(200)).body.registration).toMatchObject({ open: false, closedReason: 'FULL', spotsLeft: 0 });
  });

  it('aprobar y rechazar a la vez: o todo aprobado o nada (sin membresías huérfanas)', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, token } = await openTournament(L);
      const dep = await ownedTeam(pablo, 3);
      const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
      await Promise.all([approve(L, t, r), reject(L, t, r)]);
      const status = (await requests.findById(r).lean())!.status;
      const enrolled = await enrollments.countDocuments({ tournamentId: oid(t) });
      const ms = await activeMemberships(t);
      if (status === 'APPROVED') expect([enrolled, ms]).toEqual([1, 3]);
      else expect([status, enrolled, ms]).toEqual(['REJECTED', 0, 0]);
    }
  });
});

describe('Enlace revocado, inscripción cerrada, fecha límite y torneo FINISHED', () => {
  it('revocar o cerrar no borra PENDING y siguen aprobándose; nuevas solicitudes bloqueadas', async () => {
    const { t, token } = await openTournament(L);
    const a = await ownedTeam(pablo, 2);
    const b = await ownedTeam(pablo, 2, 'Otro');
    const ra = (await submit(pablo, token, a.team, a.players).expect(201)).body.id;
    const rb = (await submit(pablo, token, b.team, b.players).expect(201)).body.id;
    await as(L).delete(`/api/tournaments/${t}/registration-link`).expect(204);
    await submit(pablo, token, a.team, a.players).expect(404);
    await approve(L, t, ra).expect(200);
    const fresh = (await as(L).post(`/api/tournaments/${t}/registration-link`).expect(200)).body.link.token;
    await as(L).patch(`/api/tournaments/${t}/registration`).send({ enabled: false }).expect(200);
    expect((await api().get(`/api/tournament-registration/${fresh}`).expect(200)).body.registration).toMatchObject({ open: false, closedReason: 'DISABLED' });
    const c = await ownedTeam(pablo, 2, 'Tardío');
    expect((await submit(pablo, fresh, c.team, c.players).expect(409)).body.message).toMatch(/cerradas/);
    await approve(L, t, rb).expect(200); // enviada cuando estaba abierta: se puede aprobar
  });

  it('fecha límite inclusiva: hoy aún se puede; ayer ya no', async () => {
    const { t, token } = await openTournament(L, { deadline: todayISODate() });
    const dep = await ownedTeam(pablo, 1);
    expect((await api().get(`/api/tournament-registration/${token}`).expect(200)).body.registration.open).toBe(true);
    const d = new Date();
    d.setDate(d.getDate() - 1);
    await as(L).patch(`/api/tournaments/${t}/registration`).send({ deadline: todayISODate(d) }).expect(200);
    expect((await api().get(`/api/tournament-registration/${token}`).expect(200)).body.registration).toMatchObject({ open: false, closedReason: 'DEADLINE' });
    expect((await submit(pablo, token, dep.team, dep.players).expect(409)).body.message).toMatch(/fecha límite/);
  });

  it('FINISHED es terminal: nada se escribe; la historia se sigue leyendo', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 1);
    const other = await ownedTeam(pablo, 1, 'Otro');
    const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
    const r2 = (await submit(pablo, token, other.team, other.players).expect(201)).body.id;
    await approve(L, t, r2).expect(200);
    await as(L).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    expect((await api().get(`/api/tournament-registration/${token}`).expect(200)).body.registration).toMatchObject({ open: false, closedReason: 'FINISHED' });
    await as(L).patch(`/api/tournaments/${t}/registration`).send({ enabled: true }).expect(409);
    await as(L).post(`/api/tournaments/${t}/registration-link`).expect(409);
    await submit(pablo, token, dep.team, dep.players).expect(409);
    await approve(L, t, r).expect(409);
    await reject(L, t, r).expect(409);
    await as(pablo).post(`/api/tournament-registration/${token}/requests/${r}/cancel`).expect(409);
    await as(L).get(`/api/tournaments/${t}/registration-requests`).expect(200);
    await as(L).get(`/api/tournaments/${t}/registration-requests/${r2}`).expect(200);
  });
});

describe('Crear equipo desde el flujo', () => {
  it('quien lo crea queda OWNER (source CREATOR) y puede continuar; POST /teams normal no crea OWNER', async () => {
    const { token } = await openTournament(L);
    const created = (await as(zoe).post(`/api/tournament-registration/${token}/teams`).send({ name: 'Atlético Nuevo' }).expect(201)).body;
    expect(created).toMatchObject({ myRole: 'OWNER', rosterSize: 0, enrolled: false, team: { name: 'Atlético Nuevo' } });
    expect(await teamAdmins.countDocuments({ teamId: oid(created.team.id), userId: oid(zoe.id), role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE, source: TeamAdminSource.CREATOR })).toBe(1);
    const mine = (await as(zoe).get(`/api/tournament-registration/${token}/my-teams`).expect(200)).body.teams;
    expect(mine.map((x: { team: { id: string } }) => x.team.id)).toContain(created.team.id);
    const p = await player(L);
    await as(zoe).post(`/api/teams/${created.team.id}/global-roster`).send({ playerId: p }).expect(201);
    await submit(zoe, token, created.team.id, [p]).expect(201);
    // El flujo normal del organizador no cambió: crear un equipo no da propiedad.
    const plain = await team(L, 'Del organizador');
    expect(await teamAdmins.countDocuments({ teamId: oid(plain) })).toBe(0);
    // Con el enlace inválido no se crea nada.
    await as(zoe).post('/api/tournament-registration/xyz/teams').send({ name: 'Nada' }).expect(404);
  });
});

describe('Privacidad y consultas fijas', () => {
  it('respuestas del organizador y del equipo sin datos de cuenta ni auditoría interna', async () => {
    const { t, token } = await openTournament(L);
    const dep = await ownedTeam(pablo, 2);
    const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
    await reject(L, t, r, 'Motivo');
    const FORBIDDEN = ['email', 'birthDate', 'phone', 'password', 'passwordHash', 'createdBy', 'organizerId', 'tokenHash', 'tokenCiphertext', 'writeSeq', 'submittedById', 'reviewedBy', 'cancelledBy', 'addedBy', 'removedBy', 'grantedBy'];
    const walk = (v: unknown): string[] =>
      Array.isArray(v) ? v.flatMap(walk) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) ? [k] : []), ...walk(x)]) : [];
    const bodies = [
      (await api().get(`/api/tournament-registration/${token}`).expect(200)).body,
      (await as(pablo).get(`/api/tournament-registration/${token}/my-teams`).expect(200)).body,
      (await as(L).get(`/api/tournaments/${t}/registration-requests`).expect(200)).body,
      (await as(L).get(`/api/tournaments/${t}/registration-requests/${r}`).expect(200)).body,
      (await as(L).get(`/api/tournaments/${t}/registration`).expect(200)).body,
    ];
    for (const b of bodies) expect(walk(b)).toEqual([]);
    const json = JSON.stringify(bodies);
    expect(json).not.toMatch(/@example\.com/);
    expect(json).not.toContain(pablo.id); // el remitente se muestra por nombre, sin id de cuenta
  });

  it('detalle y aprobación con 25 jugadores: mismas consultas que con 2 (sin una por jugador)', async () => {
    const count = async (fn: () => Promise<unknown>) => {
      const calls: string[] = [];
      mongoose.set('debug', (c: string) => void calls.push(c));
      try {
        await fn();
      } finally {
        mongoose.set('debug', false);
      }
      return calls.length;
    };
    const measure = async (n: number) => {
      const { t, token } = await openTournament(L);
      const dep = await ownedTeam(pablo, n);
      const r = (await submit(pablo, token, dep.team, dep.players).expect(201)).body.id;
      const detail = await count(() => as(L).get(`/api/tournaments/${t}/registration-requests/${r}`).expect(200));
      const approval = await count(() => approve(L, t, r).expect(200));
      expect(await activeMemberships(t)).toBe(n);
      return [detail, approval];
    };
    expect(await measure(25)).toEqual(await measure(2));
  });
});
