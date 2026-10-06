/**
 * Etapa 6D — Integración de Team Management (6A roles + 6B plantilla global) con torneos y perfiles.
 * Lo que las specs de 6A/6B no cubrían como sistema: transición completa de la custodia, personas
 * que no son jugadores, administradores ≠ plantilla, revocación con la sesión abierta, payloads
 * manipulados, multirol, privacidad de todos los endpoints del equipo, consultas fijas y fechas.
 */
import request from 'supertest';
import mongoose from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { TeamAdminsService } from '../src/modules/teams/team-admins.service.js';
import { todayISODate } from '../src/common/utils/dates.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type U = Awaited<ReturnType<typeof registerOrganizer>>;
const as = (u: U) => authed(http, u.token);
let admins: TeamAdminsService;
let seq = 0;
const team = async (by: U, name: string) => (await as(by).post('/api/teams').send({ name: `${name} ${++seq}` }).expect(201)).body.id as string;
const player = async (by: U, lastName = `Pérez ${++seq}`) =>
  (await as(by).post('/api/players').send({ confirmNew: true, firstName: 'Juan', lastName, position: 'FORWARD', birthDate: '2000-01-01' }).expect(201)).body.id as string;
const tournament = async (by: U, name: string) =>
  (await as(by).post('/api/tournaments').send({ name, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;

/** Pablo: organizador + propietario + delegado. Carlos y Mariana: cuentas sin ficha de jugador. */
let pablo: U, carlos: U, mariana: U, laura: U, zoe: U;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  admins = ctx.app.get(TeamAdminsService);
  [pablo, carlos, mariana, laura, zoe] = [
    await registerOrganizer(http, 'Pablo'),
    await registerOrganizer(http, 'Carlos'),
    await registerOrganizer(http, 'Mariana'),
    await registerOrganizer(http, 'Laura'),
    await registerOrganizer(http, 'Zoe'),
  ];
});
afterAll(async () => ctx?.close());

describe('Custodia provisional: transición completa', () => {
  it('creador edita sin OWNER → aparece OWNER → creador 403 en ficha y borrado; su torneo sigue funcionando', async () => {
    const t = await team(laura, 'Real Pacífico');
    const liga = await tournament(laura, 'Liga de Laura');
    await as(laura).post(`/api/tournaments/${liga}/teams/${t}`).expect(201);
    await as(laura).patch(`/api/teams/${t}`).send({ name: 'Real Pacífico FC', city: 'Mazatlán' }).expect(200); // 1. custodia

    await admins.assignOwner(t, pablo.id); // 2. aparece el propietario

    await as(laura).patch(`/api/teams/${t}`).send({ city: 'Culiacán' }).expect(403); // 3-4. custodia terminada
    await as(laura).patch(`/api/teams/${t}`).send({ name: 'Otro' }).expect(403);
    await as(laura).delete(`/api/teams/${t}`).expect(403);
    await as(laura).get(`/api/teams/${t}/global-roster`).expect(403); // nunca tuvo la plantilla
    await as(pablo).patch(`/api/teams/${t}`).send({ city: 'Culiacán' }).expect(200); // 5. administra el OWNER

    // 6. Laura sigue controlando SU torneo con ese equipo.
    const rival = await team(laura, 'Rival');
    await as(laura).post(`/api/tournaments/${liga}/teams/${rival}`).expect(201);
    const p = await player(laura);
    await as(laura).put(`/api/tournaments/${liga}/players/${p}`).send({ teamId: t, jerseyNumber: 9 }).expect(200);
    const m = (await as(laura).post('/api/matches').send({ tournamentId: liga, round: 1, homeTeamId: t, awayTeamId: rival, date: '2027-01-10', time: '18:00' }).expect(201)).body.id;
    await as(laura).put(`/api/matches/${m}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [{ playerId: p, teamId: t, played: true, goals: 1, assists: 0, yellowCards: 0, redCards: 0 }] }).expect(200);
    // …y el OWNER no controla el torneo de Laura.
    await as(pablo).put(`/api/tournaments/${liga}/players/${p}`).send({ teamId: t, jerseyNumber: 10 }).expect(403);
  });
});

describe('Personas, roles y plantilla son relaciones independientes', () => {
  let dep: string, taller: string, liga: string, ajeno: string;
  beforeAll(async () => {
    dep = await team(laura, 'Deportivo');
    taller = await team(laura, 'Taller');
    await admins.assignOwner(dep, pablo.id);
    await admins.assignOwner(taller, laura.id);
    await as(laura).post(`/api/teams/${taller}/managers`).send({ userId: pablo.id }).expect(201);
    await as(pablo).post(`/api/teams/${dep}/managers`).send({ email: carlos.email }).expect(201);
    liga = await tournament(pablo, 'Liga Municipal');
    ajeno = await team(laura, 'Ajeno');
    await as(pablo).post(`/api/tournaments/${liga}/teams/${ajeno}`).expect(201);
  });

  it('multirol: Pablo organiza, es propietario de uno y delegado de otro; organizar no suma equipos', async () => {
    const mine = (await as(pablo).get('/api/admin/teams?limit=100').expect(200)).body.data as { id: string; name: string; myRole: string | null; canEdit: boolean }[];
    const roleOf = (id: string) => mine.find((t) => t.id === id);
    expect(roleOf(dep)).toMatchObject({ myRole: 'OWNER', canEdit: true });
    expect(roleOf(taller)).toMatchObject({ myRole: 'MANAGER', canEdit: true });
    expect(roleOf(ajeno)).toMatchObject({ myRole: null, canEdit: false }); // equipo de su liga: organizar no lo hace suyo
    await as(pablo).patch(`/api/tournaments/${liga}`).send({ name: 'Liga Municipal 2027' }).expect(200); // organiza
  });

  it('Carlos (sin ficha de jugador) administra como delegado: plantilla y presentación', async () => {
    const p = await player(laura);
    await as(carlos).post(`/api/teams/${dep}/global-roster`).send({ playerId: p }).expect(201);
    await as(carlos).patch(`/api/teams/${dep}/`).send({ colors: { primary: '#123456', secondary: '#ffffff' } }).expect(200);
    const players = (await api().get(`/api/players?search=${encodeURIComponent('Carlos')}`).expect(200)).body.data;
    expect(players).toEqual([]); // no existe un Player "Carlos": no hace falta para administrar
  });

  it('administradores ≠ plantilla: un delegado no aparece como jugador y un jugador no es administrador', async () => {
    const roster = (await as(pablo).get(`/api/teams/${dep}/global-roster`).expect(200)).body.players as { player: { id: string; firstName: string } }[];
    const view = (await as(pablo).get(`/api/teams/${dep}/admins`).expect(200)).body;
    const adminIds = [view.owner.userId, ...view.managers.map((m: { userId: string }) => m.userId)];
    expect(roster.every((r) => !adminIds.includes(r.player.id))).toBe(true);
    expect(roster.map((r) => r.player.firstName)).not.toContain('Carlos');
    expect(adminIds.sort()).toEqual([pablo.id, carlos.id].sort());
  });

  it('manipular el payload no sirve: un delegado nunca cambia nombre ni abreviatura', async () => {
    const current = (await api().get(`/api/teams/${dep}`).expect(200)).body;
    await as(carlos).patch(`/api/teams/${dep}`).send({ name: 'Hackeado' }).expect(403);
    await as(carlos).patch(`/api/teams/${dep}`).send({ shortName: 'HAK' }).expect(403);
    await as(carlos).patch(`/api/teams/${dep}`).send({ name: current.name, city: 'X' }).expect(403); // aunque no cambie
    await as(carlos).patch(`/api/teams/${dep}`).send({ createdBy: carlos.id }).expect(400); // campo no permitido
    await as(carlos).post(`/api/teams/${dep}/managers`).send({ userId: zoe.id }).expect(403);
    expect((await api().get(`/api/teams/${dep}`).expect(200)).body).toMatchObject({ name: current.name, shortName: current.shortName });
  });

  it('Mariana (organizadora sin rol) administra su torneo con el equipo inscrito, pero nada global', async () => {
    const copa = await tournament(mariana, 'Copa Mazatlán');
    await as(mariana).post(`/api/tournaments/${copa}/teams/${dep}`).expect(201);
    await as(mariana).get(`/api/teams/${dep}/admins`).expect(403);
    await as(mariana).get(`/api/teams/${dep}/global-roster`).expect(403);
    const own = await player(mariana);
    await as(mariana).post(`/api/teams/${dep}/global-roster`).send({ playerId: own }).expect(403);
    await as(mariana).patch(`/api/teams/${dep}`).send({ city: 'X' }).expect(403);
    expect(((await as(mariana).get('/api/admin/teams?limit=100').expect(200)).body.data as { myRole: string | null }[]).every((t) => !t.myRole)).toBe(true);
  });

  it('revocación con la sesión abierta: la siguiente operación del ex-delegado es 403 (mismo token)', async () => {
    const p = await player(laura);
    await as(carlos).post(`/api/teams/${dep}/global-roster`).send({ playerId: p }).expect(201);
    await as(pablo).delete(`/api/teams/${dep}/managers/${carlos.id}`).expect(204);
    await as(carlos).get(`/api/teams/${dep}/global-roster`).expect(403);
    await as(carlos).delete(`/api/teams/${dep}/global-roster/${p}`).expect(403);
    await as(carlos).patch(`/api/teams/${dep}`).send({ city: 'Y' }).expect(403);
    // Volver a agregarlo abre otra concesión (el historial conserva la anterior).
    await as(pablo).post(`/api/teams/${dep}/managers`).send({ userId: carlos.id }).expect(201);
    await as(carlos).get(`/api/teams/${dep}/global-roster`).expect(200);
  });
});

describe('Privacidad de TODOS los endpoints del equipo (públicos y administrativos)', () => {
  it('ninguna respuesta contiene datos de cuenta, auditoría ni campos internos', async () => {
    const t = await team(laura, 'Privado');
    await admins.assignOwner(t, pablo.id);
    await as(pablo).post(`/api/teams/${t}/managers`).send({ userId: carlos.id }).expect(201);
    const p = await player(laura);
    await as(pablo).post(`/api/teams/${t}/global-roster`).send({ playerId: p }).expect(201);
    await as(pablo).delete(`/api/teams/${t}/global-roster/${p}`).expect(204); // deja removedBy en la base
    await as(pablo).post(`/api/teams/${t}/global-roster`).send({ playerId: p }).expect(201);

    const FORBIDDEN = ['birthDate', 'email', 'phone', 'password', 'passwordHash', 'accessToken', 'refreshToken', 'token', 'createdBy', 'organizerId', 'addedBy', 'removedBy', 'grantedBy', 'revokedBy', 'revokedAt', 'writeSeq', 'searchName', 'source'];
    const walk = (v: unknown, path = '$'): string[] =>
      Array.isArray(v)
        ? v.flatMap((x, i) => walk(x, `${path}[${i}]`))
        : v && typeof v === 'object'
          ? Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) ? [`${path}.${k}`] : []), ...walk(x, `${path}.${k}`)])
          : [];
    const responses = {
      publicList: (await api().get('/api/teams?limit=100').expect(200)).body,
      publicTeam: (await api().get(`/api/teams/${t}`).expect(200)).body,
      publicProfile: (await api().get(`/api/teams/${t}/profile`).expect(200)).body,
      legacyRoster: (await api().get(`/api/teams/${t}/roster`).expect(200)).body,
      memberships: (await api().get(`/api/teams/${t}/memberships`).expect(200)).body,
      admins: (await as(pablo).get(`/api/teams/${t}/admins`).expect(200)).body,
      globalRosterAll: (await as(pablo).get(`/api/teams/${t}/global-roster?status=all`).expect(200)).body,
      adminTeams: (await as(pablo).get('/api/admin/teams?limit=100').expect(200)).body,
    };
    for (const [name, body] of Object.entries(responses)) expect({ name, leaks: walk(body) }).toEqual({ name, leaks: [] });
    expect(JSON.stringify(responses)).not.toMatch(/@example\.com/);
    expect(responses.publicProfile.currentRoster).toHaveLength(1);
  });
});

describe('Consultas fijas (sin N+1) y fechas', () => {
  const countQueries = async (fn: () => Promise<unknown>) => {
    const calls: string[] = [];
    mongoose.set('debug', (collection: string) => void calls.push(collection));
    try {
      await fn();
    } finally {
      mongoose.set('debug', false);
    }
    return calls.length;
  };

  it('/admin/teams, /admins y /global-roster no crecen con equipos, delegados o jugadores', async () => {
    const owner = await registerOrganizer(http, 'Dueña');
    const small = await team(laura, 'Pequeño');
    await admins.assignOwner(small, owner.id);
    const qSmallList = await countQueries(() => as(owner).get('/api/admin/teams?limit=100').expect(200));
    const qSmallAdmins = await countQueries(() => as(owner).get(`/api/teams/${small}/admins`).expect(200));
    const qSmallRoster = await countQueries(() => as(owner).get(`/api/teams/${small}/global-roster`).expect(200));

    for (let i = 0; i < 4; i++) {
      const t = await team(laura, `Grande ${i}`);
      await admins.assignOwner(t, owner.id);
    }
    const managers = [];
    for (let i = 0; i < 5; i++) managers.push(await registerOrganizer(http, `Delegado${i}`));
    for (const m of managers) await as(owner).post(`/api/teams/${small}/managers`).send({ userId: m.id }).expect(201);
    for (let i = 0; i < 25; i++) {
      const p = await player(laura);
      await as(owner).post(`/api/teams/${small}/global-roster`).send({ playerId: p }).expect(201);
    }

    expect(await countQueries(() => as(owner).get('/api/admin/teams?limit=100').expect(200))).toBe(qSmallList);
    expect(await countQueries(() => as(owner).get(`/api/teams/${small}/admins`).expect(200))).toBe(qSmallAdmins);
    expect(await countQueries(() => as(owner).get(`/api/teams/${small}/global-roster`).expect(200))).toBe(qSmallRoster);
    expect(qSmallAdmins).toBeLessThanOrEqual(6);
    expect(qSmallRoster).toBeLessThanOrEqual(6);
  });

  it('fechas: joinedAt/leftAt son fechas deportivas YYYY-MM-DD (día del servidor); since/revokedAt son timestamps', async () => {
    const t = await team(laura, 'Fechas');
    await admins.assignOwner(t, pablo.id);
    const p = await player(laura);
    const added = (await as(pablo).post(`/api/teams/${t}/global-roster`).send({ playerId: p }).expect(201)).body;
    expect(added.joinedAt).toBe(todayISODate());
    await as(pablo).delete(`/api/teams/${t}/global-roster/${p}`).expect(204);
    const [closed] = (await as(pablo).get(`/api/teams/${t}/global-roster?status=inactive`).expect(200)).body.players;
    expect(closed.leftAt).toBe(todayISODate());
    const view = (await as(pablo).get(`/api/teams/${t}/admins`).expect(200)).body;
    expect(new Date(view.owner.since).toISOString()).toBe(view.owner.since); // instante UTC completo, el cliente lo muestra en su hora local
  });
});
