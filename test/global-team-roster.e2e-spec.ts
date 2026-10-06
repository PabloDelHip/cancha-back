/**
 * Etapa 6B — Plantilla GLOBAL del equipo (TeamRoster): pertenencia Player ↔ Team independiente de
 * torneos, administrada por OWNER/MANAGER (TeamAccessService), con historial por periodos. Nunca
 * toca TeamMembership (participación en torneos) ni la historia oficial. API real.
 */
import request from 'supertest';
import mongoose, { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { TeamAdminsService } from '../src/modules/teams/team-admins.service.js';
import { TeamRoster } from '../src/modules/teams/schemas/team-roster.schema.js';
import { TeamRosterStatus } from '../src/common/enums/index.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type U = Awaited<ReturnType<typeof registerOrganizer>>;
const as = (u: U) => authed(http, u.token);
const oid = (id: string) => new Types.ObjectId(id);
let rosters: Model<TeamRoster>;
let admins: TeamAdminsService;

/** L organiza Liga Municipal y Copa; S organiza la Sabatina. Pablo/Carlos/Roberto administran equipos. */
let L: U, S: U, pablo: U, carlos: U, roberto: U, zoe: U;
let seq = 0;
const team = async (by: U, name: string) => (await as(by).post('/api/teams').send({ name: `${name} ${++seq}` }).expect(201)).body.id as string;
const player = async (by: U, extra: Record<string, unknown> = {}) =>
  (await as(by).post('/api/players').send({ confirmNew: true, firstName: 'Juan', lastName: `Pérez ${++seq}`, position: 'FORWARD', birthDate: '2001-04-18', ...extra }).expect(201)).body.id as string;
const add = (by: U, t: string, p: string) => as(by).post(`/api/teams/${t}/global-roster`).send({ playerId: p });
const drop = (by: U, t: string, p: string) => as(by).delete(`/api/teams/${t}/global-roster/${p}`);
const list = async (by: U, t: string, status = 'active') =>
  (await as(by).get(`/api/teams/${t}/global-roster?status=${status}`).expect(200)).body as {
    players: { periodId: string; player: { id: string }; status: string; joinedAt: string; leftAt: string | null }[];
  };
const active = (t: string, p: string) => rosters.countDocuments({ teamId: oid(t), playerId: oid(p), status: TeamRosterStatus.ACTIVE });

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  rosters = ctx.app.get<Model<TeamRoster>>(getModelToken(TeamRoster.name));
  admins = ctx.app.get(TeamAdminsService);
  [L, S, pablo, carlos, roberto, zoe] = [
    await registerOrganizer(http, 'Liga'),
    await registerOrganizer(http, 'Sabatina'),
    await registerOrganizer(http, 'Pablo'),
    await registerOrganizer(http, 'Carlos'),
    await registerOrganizer(http, 'Roberto'),
    await registerOrganizer(http, 'Zoe'),
  ];
});
afterAll(async () => ctx?.close());

describe('Permisos: solo OWNER/MANAGER (TeamAccessService)', () => {
  let dep: string, juan: string;
  beforeAll(async () => {
    dep = await team(L, 'Deportivo');
    await admins.assignOwner(dep, pablo.id);
    await as(pablo).post(`/api/teams/${dep}/managers`).send({ userId: carlos.id }).expect(201);
    juan = await player(L);
  });

  it('OWNER agrega (201) y retira (204); MANAGER agrega y retira', async () => {
    const r = await add(pablo, dep, juan).expect(201);
    expect(r.body).toMatchObject({ player: { id: juan }, status: 'ACTIVE', leftAt: null });
    await drop(pablo, dep, juan).expect(204);
    await add(carlos, dep, juan).expect(201);
    await drop(carlos, dep, juan).expect(204);
    expect(await active(dep, juan)).toBe(0);
  });

  it('usuario cualquiera y organizador sin rol global → 403 (leer, agregar, retirar)', async () => {
    for (const u of [zoe, L]) {
      await as(u).get(`/api/teams/${dep}/global-roster`).expect(403);
      await add(u, dep, juan).expect(403);
      await drop(u, dep, juan).expect(403);
    }
  });

  it('createdBy de un equipo SIN OWNER no obtiene acceso a la plantilla global (la custodia no se extiende)', async () => {
    const real = await team(L, 'Real Pacífico');
    await as(L).patch(`/api/teams/${real}`).send({ city: 'Mazatlán' }).expect(200); // custodia de 6A: sí edita la ficha
    await as(L).get(`/api/teams/${real}/global-roster`).expect(403);
    await add(L, real, juan).expect(403);
    // Un equipo sin OWNER existe con plantilla global vacía y perfil público normal.
    const profile = (await api().get(`/api/teams/${real}/profile`).expect(200)).body;
    expect(profile.currentRoster).toEqual([]);
  });

  it('sin sesión 401; equipo o jugador inexistente 404; id inválido 400; body inválido 400', async () => {
    const ghost = '000000000000000000000000';
    await api().get(`/api/teams/${dep}/global-roster`).expect(401);
    await api().post(`/api/teams/${dep}/global-roster`).send({ playerId: juan }).expect(401);
    await api().delete(`/api/teams/${dep}/global-roster/${juan}`).expect(401);
    await as(pablo).get(`/api/teams/${ghost}/global-roster`).expect(404);
    await add(pablo, ghost, juan).expect(404);
    await add(pablo, dep, ghost).expect(404);
    await drop(pablo, dep, ghost).expect(404); // nunca perteneció
    await as(pablo).get('/api/teams/no-es-id/global-roster').expect(400);
    await drop(pablo, dep, 'no-es-id').expect(400);
    await as(pablo).post(`/api/teams/${dep}/global-roster`).send({ playerId: 'x' }).expect(400);
    await as(pablo).post(`/api/teams/${dep}/global-roster`).send({ playerId: juan, jerseyNumber: 10 }).expect(400); // sin dorsal global
    await as(pablo).get(`/api/teams/${dep}/global-roster?status=raro`).expect(400);
  });
});

describe('Periodos, idempotencia y reincorporación', () => {
  let dep: string, juan: string;
  beforeAll(async () => {
    dep = await team(L, 'Deportivo');
    await admins.assignOwner(dep, pablo.id);
    juan = await player(L);
  });

  it('alta duplicada idempotente (200, un solo ACTIVE); baja duplicada consistente (204)', async () => {
    await add(pablo, dep, juan).expect(201);
    await add(pablo, dep, juan).expect(200);
    expect(await active(dep, juan)).toBe(1);
    await drop(pablo, dep, juan).expect(204);
    await drop(pablo, dep, juan).expect(204);
    expect(await active(dep, juan)).toBe(0);
  });

  it('reincorporación: abre un periodo nuevo y conserva el anterior intacto', async () => {
    const before = (await list(pablo, dep, 'inactive')).players;
    expect(before).toHaveLength(1);
    await add(pablo, dep, juan).expect(201);
    const all = (await list(pablo, dep, 'all')).players;
    expect(all.map((p) => p.status)).toEqual(['ACTIVE', 'INACTIVE']);
    expect(all[1]).toEqual(before[0]); // el periodo cerrado no cambió
    expect(all[1].leftAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(all[0].periodId).not.toBe(all[1].periodId);
    expect((await list(pablo, dep)).players.map((p) => p.player.id)).toEqual([juan]);
  });

  it('la base rechaza un segundo periodo ACTIVE aunque se salte el service (índice único parcial)', async () => {
    await expect(
      rosters.create({ teamId: oid(dep), playerId: oid(juan), status: TeamRosterStatus.ACTIVE, joinedAt: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 11000 });
  });
});

describe('Concurrencia', () => {
  let dep: string;
  beforeAll(async () => {
    dep = await team(L, 'Deportivo');
    await admins.assignOwner(dep, pablo.id);
  });

  it('6 altas simultáneas del mismo jugador → exactamente 1 ACTIVE (un 201, el resto 200)', async () => {
    const p = await player(L);
    const res = await Promise.all(Array.from({ length: 6 }, () => add(pablo, dep, p)));
    expect(res.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(await active(dep, p)).toBe(1);
  });

  it('6 bajas simultáneas → todas 204, un solo periodo cerrado', async () => {
    const p = await player(L);
    await add(pablo, dep, p).expect(201);
    const res = await Promise.all(Array.from({ length: 6 }, () => drop(pablo, dep, p)));
    expect(res.every((r) => r.status === 204)).toBe(true);
    expect(await rosters.countDocuments({ teamId: oid(dep), playerId: oid(p) })).toBe(1);
    expect(await active(dep, p)).toBe(0);
  });

  it('altas y bajas mezcladas a la vez: nunca 2 ACTIVE ni periodos imposibles', async () => {
    const p = await player(L);
    await add(pablo, dep, p).expect(201);
    for (let round = 0; round < 3; round++) {
      await Promise.all([add(pablo, dep, p), drop(pablo, dep, p), add(pablo, dep, p), drop(pablo, dep, p)]);
      const periods = await rosters.find({ teamId: oid(dep), playerId: oid(p) }).lean();
      expect(periods.filter((x) => x.status === TeamRosterStatus.ACTIVE).length).toBeLessThanOrEqual(1);
      for (const x of periods) {
        if (x.status === TeamRosterStatus.ACTIVE) expect(x.leftAt).toBeNull();
        else expect(x.leftAt! >= x.joinedAt).toBe(true);
      }
    }
  });
});

describe('Prueba de dominio: Juan en 3 equipos, torneos y plantilla global independientes', () => {
  let dep: string, tal: string, olas: string, rivalL: string, rivalS: string;
  let liga: string, copa: string, sabatina: string, juan: string;
  const membershipsOf = async (p: string) =>
    ((await api().get(`/api/players/${p}/memberships`).expect(200)).body as { tournamentId: string; teamId: string; active: boolean; endDate: string | null }[])
      .map((m) => `${m.teamId}|${m.tournamentId}|${m.active}|${m.endDate}`)
      .sort();

  beforeAll(async () => {
    // Equipos: los crean los organizadores; sus administradores son otros usuarios.
    dep = await team(L, 'Deportivo Mazatlán');
    tal = await team(S, 'Taller Beltrán');
    olas = await team(L, 'Olas Altas');
    rivalL = await team(L, 'Venados');
    rivalS = await team(S, 'Marlins');
    await admins.assignOwner(dep, pablo.id);
    await admins.assignOwner(tal, carlos.id);
    await admins.assignOwner(olas, roberto.id);
    await as(carlos).post(`/api/teams/${tal}/managers`).send({ userId: zoe.id }).expect(201);
    juan = await player(L, { firstName: 'Juan', lastName: 'Pérez Dominio' });

    // Plantilla global: Juan en los TRES a la vez (uno lo agrega un MANAGER).
    await add(pablo, dep, juan).expect(201);
    await add(zoe, tal, juan).expect(201);
    await add(roberto, olas, juan).expect(201);

    // Torneos (los organizadores controlan la participación en SUS torneos).
    const tournament = async (by: U, name: string) =>
      (await as(by).post('/api/tournaments').send({ name, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
    liga = await tournament(L, 'Liga Municipal');
    copa = await tournament(L, 'Copa Mazatlán');
    sabatina = await tournament(S, 'Liga Sabatina');
    for (const [by, t, teams] of [[L, liga, [dep, rivalL]], [L, copa, [dep, rivalL]], [S, sabatina, [tal, rivalS]]] as const) {
      for (const x of teams) await as(by).post(`/api/tournaments/${t}/teams/${x}`).expect(201);
    }
    await as(L).put(`/api/tournaments/${liga}/players/${juan}`).send({ teamId: dep, jerseyNumber: 10, startDate: '2027-01-01' }).expect(200);
    await as(L).put(`/api/tournaments/${copa}/players/${juan}`).send({ teamId: dep, jerseyNumber: 7, startDate: '2027-01-01' }).expect(200);
    await as(S).put(`/api/tournaments/${sabatina}/players/${juan}`).send({ teamId: tal, jerseyNumber: 8, startDate: '2027-01-01' }).expect(200);

    // Historia oficial: partidos con goles de Juan; la Copa se finaliza con Deportivo campeón.
    const play = async (by: U, t: string, home: string, away: string, goals: number) => {
      const m = (await as(by).post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: home, awayTeamId: away, date: '2027-01-10', time: '18:00' }).expect(201)).body.id;
      await as(by).put(`/api/matches/${m}/result`).send({ homeScore: goals, awayScore: 0, playerStats: [{ playerId: juan, teamId: home, played: true, goals, assists: 0, yellowCards: 0, redCards: 0 }] }).expect(200);
    };
    await play(L, liga, dep, rivalL, 2);
    await play(L, copa, dep, rivalL, 3);
    await play(S, sabatina, tal, rivalS, 1);
    await as(L).post(`/api/tournaments/${copa}/finish`).send({}).expect(200);
  });

  it('Juan pertenece globalmente a 3 equipos a la vez, sin equipo "principal"', async () => {
    for (const [owner, t] of [[pablo, dep], [carlos, tal], [roberto, olas]] as const) {
      expect((await list(owner, t)).players.map((p) => p.player.id)).toEqual([juan]);
    }
    expect(await rosters.countDocuments({ playerId: oid(juan), status: TeamRosterStatus.ACTIVE })).toBe(3);
  });

  it('el organizador retira a Juan de Liga Municipal: solo cambia esa participación, nunca la plantilla global', async () => {
    const globalBefore = await rosters.find({ playerId: oid(juan) }).lean();
    await as(L).delete(`/api/tournaments/${liga}/players/${juan}`).expect(204);
    expect(await rosters.find({ playerId: oid(juan) }).lean()).toEqual(globalBefore);
    const ms = (await api().get(`/api/players/${juan}/memberships`).expect(200)).body as { tournamentId: string; teamId: string; active: boolean }[];
    const state = (t: string) => ms.find((m) => m.tournamentId === t)!.active;
    expect([state(liga), state(copa), state(sabatina)]).toEqual([false, true, true]);
  });

  it('el OWNER retira a Juan globalmente de Deportivo: participaciones, partidos, estadísticas y honors intactos', async () => {
    const membershipsBefore = await membershipsOf(juan);
    const profileBefore = (await api().get(`/api/players/${juan}/profile`).expect(200)).body;
    const teamProfileBefore = (await api().get(`/api/teams/${dep}/profile`).expect(200)).body;
    const statsBefore = (await api().get(`/api/players/${juan}/stats`).expect(200)).body;

    expect(membershipsBefore).toHaveLength(3);
    expect(membershipsBefore.some((m) => m.startsWith(`${dep}|${liga}|false|`))).toBe(true); // Liga: ya retirado por el organizador
    expect(membershipsBefore.filter((m) => m.endsWith('|null') && m.includes('|true|'))).toHaveLength(2); // Copa y Sabatina activas
    expect(statsBefore).toBeTruthy();

    await drop(pablo, dep, juan).expect(204);

    const state = await rosters.find({ playerId: oid(juan), status: TeamRosterStatus.ACTIVE }).lean();
    expect(state.map((r) => r.teamId.toHexString()).sort()).toEqual([tal, olas].sort());
    expect(await membershipsOf(juan)).toEqual(membershipsBefore); // Liga INACTIVE y Copa ACTIVE, sin tocar
    expect((await api().get(`/api/players/${juan}/stats`).expect(200)).body).toEqual(statsBefore);
    const profileAfter = (await api().get(`/api/players/${juan}/profile`).expect(200)).body;
    expect(profileAfter).toEqual(profileBefore); // carrera, competiciones, honors, hitos…
    expect(profileAfter.honors.map((h: { type: string; tournament: { id: string } }) => [h.type, h.tournament.id])).toContainEqual(['CHAMPION', copa]);
    const teamProfileAfter = (await api().get(`/api/teams/${dep}/profile`).expect(200)).body;
    expect(teamProfileAfter.rosters).toEqual(teamProfileBefore.rosters); // plantillas por torneo intactas
    expect(teamProfileAfter.honors).toEqual(teamProfileBefore.honors);
    expect(teamProfileBefore.currentRoster.map((r: { player: { id: string } }) => r.player.id)).toEqual([juan]);
    expect(teamProfileAfter.currentRoster).toEqual([]); // solo cambia la plantilla GLOBAL actual
  });
});

describe('Player Profile V2 y Team Profile no se derivan de la plantilla global', () => {
  it('un jugador en plantilla pero sin partidos no suma equipos, competiciones ni honors', async () => {
    const dep = await team(L, 'Deportivo');
    await admins.assignOwner(dep, pablo.id);
    const nuevo = await player(L);
    await add(pablo, dep, nuevo).expect(201);
    const p = (await api().get(`/api/players/${nuevo}/profile`).expect(200)).body;
    expect(p.career).toMatchObject({ appearances: 0, teams: 0, competitions: 0, titles: 0 });
    expect(p).toMatchObject({ competitions: [], byTeam: [], honors: [], currentParticipations: [], history: [] });
    const tp = (await api().get(`/api/teams/${dep}/profile`).expect(200)).body;
    expect(tp.currentRoster).toEqual([{ player: expect.objectContaining({ id: nuevo }), joinedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }]);
    expect(tp).toMatchObject({ rosters: [], topScorers: [], career: { matchesPlayed: 0 } });
  });
});

describe('Privacidad y rendimiento', () => {
  let dep: string;
  const ids: string[] = [];
  beforeAll(async () => {
    dep = await team(L, 'Deportivo');
    await admins.assignOwner(dep, pablo.id);
    for (let i = 0; i < 25; i++) {
      const p = await player(L, { birthDate: '2010-02-02' });
      ids.push(p);
      await add(pablo, dep, p).expect(201);
    }
  });

  it('ni la respuesta administrativa ni el perfil público exponen datos privados', async () => {
    const FORBIDDEN = ['birthDate', 'email', 'createdBy', 'addedBy', 'removedBy', 'organizerId', 'searchName', 'passwordHash'];
    const walk = (v: unknown): string[] =>
      Array.isArray(v) ? v.flatMap(walk) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) ? [k] : []), ...walk(x)]) : [];
    const adminBody = await list(pablo, dep, 'all');
    const publicBody = (await api().get(`/api/teams/${dep}/profile`).expect(200)).body;
    expect(walk(adminBody)).toEqual([]);
    expect(walk(publicBody)).toEqual([]);
    expect(JSON.stringify([adminBody, publicBody])).not.toContain(pablo.id); // quién dio de alta no se publica
    expect(publicBody.currentRoster[0].player.age).toBeGreaterThan(0); // edad sí, fecha nunca
  });

  it('25 jugadores: consultas fijas (sin una por jugador) en admin y perfil; /admin/teams trae el tamaño', async () => {
    const calls: string[] = [];
    mongoose.set('debug', (collection: string) => void calls.push(collection));
    await list(pablo, dep);
    const adminQueries = calls.length;
    calls.length = 0;
    await api().get(`/api/teams/${dep}/profile`).expect(200);
    const profileQueries = calls.filter((c) => c === 'players' || c === 'team_rosters').length;
    mongoose.set('debug', false);
    expect(adminQueries).toBeGreaterThanOrEqual(3); // el contador sí registra consultas
    expect(adminQueries).toBeLessThanOrEqual(5); // equipo, rol, roster, players
    expect(profileQueries).toBeGreaterThanOrEqual(2);
    expect(profileQueries).toBeLessThanOrEqual(2);
    const mine = (await as(pablo).get('/api/admin/teams?limit=100').expect(200)).body.data as { id: string; globalRosterSize: number }[];
    expect(mine.find((t) => t.id === dep)!.globalRosterSize).toBe(25);
  });
});

describe('Integridad al borrar', () => {
  it('Team con jugadores ACTIVE en plantilla → 409; tras retirarlos se borra junto con sus periodos', async () => {
    const t = await team(L, 'Efímero');
    await admins.assignOwner(t, pablo.id);
    const p = await player(L);
    await add(pablo, t, p).expect(201);
    await as(pablo).delete(`/api/teams/${t}`).expect(409);
    await drop(pablo, t, p).expect(204);
    await as(pablo).delete(`/api/teams/${t}`).expect(204);
    expect(await rosters.countDocuments({ teamId: oid(t) })).toBe(0);
  });

  it('Player en la plantilla ACTIVE de algún equipo → 409; retirado, se borra sin dejar huérfanos', async () => {
    const t = await team(L, 'Deportivo');
    await admins.assignOwner(t, pablo.id);
    const p = await player(L);
    await add(pablo, t, p).expect(201);
    await as(L).delete(`/api/players/${p}`).expect(409);
    await drop(pablo, t, p).expect(204);
    await as(L).delete(`/api/players/${p}`).expect(204);
    expect(await rosters.countDocuments({ playerId: oid(p) })).toBe(0);
  });
});
