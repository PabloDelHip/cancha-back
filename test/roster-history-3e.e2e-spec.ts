/**
 * Módulo 3E (2026-10-17): historial y auditoría de plantillas (GET /tournaments/:id/roster-history).
 * - Derivado de lo que ya se guarda: altas, cambios (y anulaciones), bajas, reincorporaciones,
 *   excepciones, dorsales, bloqueos, retiros y equipos quitados. Sin duplicados.
 * - Solo propietario y administradores (TEAMS); aislado por torneo; también con el torneo finalizado.
 * - E8: quitar un equipo sin partidos conserva su historial administrativo (sin volver a ser
 *   participante); borrar un torneo o una ficha no deja bloqueos huérfanos.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types, type Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { todayISODate } from '../src/common/utils/dates.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, TM: U, OTHER: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const oid = (id: string) => new Types.ObjectId(id);
const today = todayISODate();
let seq = 0;

async function tournament(names: string[], by = O) {
  seq++;
  const t = (await as(by).post('/api/tournaments').send({ name: `Hist ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (const [i, name] of names.entries()) {
    const id = (await as(by).post('/api/teams').send({ name: `E${i + 1} ${name} H${seq}` }).expect(201)).body.id as string;
    await as(by).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
const newPlayer = async (name: string) => (await as(O).post('/api/players').send({ firstName: name, lastName: `H${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
const register = (t: string, p: string, body: Record<string, unknown>) => as(O).put(`/api/tournaments/${t}/players/${p}`).send(body);
const history = (t: string, q: Record<string, unknown> = {}, who = O) => as(who).get(`/api/tournaments/${t}/roster-history`).query(q);
const actionsOf = (body: { data: { action: string }[] }) => body.data.map((e) => e.action).reverse();
async function join(t: string, u: U, role: string) {
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}
const match = async (t: string, round: number, home: string, away: string, date = '2027-02-07') =>
  (await as(O).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date, time: '18:00' }).expect(201)).body.id as string;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, TM, OTHER] = [
    await registerOrganizer(http, 'DueñoHist'),
    await registerOrganizer(http, 'AdminHist'),
    await registerOrganizer(http, 'CoordHist'),
    await registerOrganizer(http, 'ClubHist'),
    await registerOrganizer(http, 'OtroHist'),
  ];
});
afterAll(async () => ctx?.close());

describe('3E — contenido del historial', () => {
  it('altas, dorsal, cambio de equipo (una sola vez), baja, reincorporación, bloqueo, retiro: con motivo, autor y rol', async () => {
    const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
    await join(t, ADM, 'ADMIN');
    const p = await newPlayer('Pablo');
    await register(t, p, { teamId: a, jerseyNumber: 9 }).expect(200);
    await register(t, p, { teamId: a, jerseyNumber: 10 }).expect(200);
    await as(ADM).put(`/api/tournaments/${t}/players/${p}`).send({ teamId: b, fromTeamId: a, transferReason: 'Se mudó de barrio' }).expect(200);
    await as(O).delete(`/api/tournaments/${t}/players/${p}`).send({ reason: 'Lesión larga' }).expect(204);
    await register(t, p, { teamId: b }).expect(200);
    await as(O).post(`/api/tournaments/${t}/players/${p}/block`).send({ reason: 'Falta la ficha médica' }).expect(200);
    await as(ADM).post(`/api/tournaments/${t}/players/${p}/unblock`).send({ reason: 'La entregó' }).expect(200);
    const m = await match(t, 1, b, c);
    await as(O).put(`/api/matches/${m}/result`).send({ homeScore: 1, awayScore: 0, status: 'FINISHED', playerStats: [] }).expect(200);
    await as(O).post(`/api/tournaments/${t}/teams/${c}/withdraw`).send({ reason: 'Abandonó el torneo' }).expect(200);
    await as(O).post(`/api/tournaments/${t}/teams/${c}/reinstate`).send({ reason: 'Acuerdo de la junta' }).expect(200);

    const res = (await history(t).expect(200)).body;
    expect(actionsOf(res)).toEqual(['REGISTERED', 'JERSEY_CHANGED', 'TRANSFER', 'UNREGISTERED', 'REJOINED', 'BLOCKED', 'UNBLOCKED', 'TEAM_WITHDRAWN', 'TEAM_REINSTATED']);
    const ev = (a: string) => res.data.find((e: { action: string }) => e.action === a);
    expect(ev('JERSEY_CHANGED')).toMatchObject({ playerId: p, teamId: a, details: { from: 9, to: 10 }, by: { userId: O.id, role: 'OWNER' } });
    expect(ev('TRANSFER')).toMatchObject({ teamId: b, fromTeamId: a, reason: 'Se mudó de barrio', by: { userId: ADM.id, role: 'ADMIN' } });
    expect(ev('UNREGISTERED')).toMatchObject({ teamId: b, reason: 'Lesión larga', date: today });
    expect(ev('BLOCKED')).toMatchObject({ teamId: b, reason: 'Falta la ficha médica', date: today });
    expect(ev('UNBLOCKED')).toMatchObject({ reason: 'La entregó', by: { role: 'ADMIN' } });
    expect(ev('TEAM_WITHDRAWN')).toMatchObject({ teamId: c, playerId: null, reason: 'Abandonó el torneo', details: { cancelledMatches: 0 } });
    expect(res.refs).toMatchObject({ players: { [p]: `Pablo H${seq}` }, users: { [O.id]: expect.any(String), [ADM.id]: expect.any(String) } });
    expect(res.refs.teams[a]).toContain('Águilas');
    expect(res.meta).toMatchObject({ page: 1, total: 9 });
  });

  it('transferencia anulada: la transferencia sigue (marcada) y la anulación queda con su motivo', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await newPlayer('Anulado');
    await register(t, p, { teamId: a, jerseyNumber: 5 }).expect(200);
    await register(t, p, { teamId: b, fromTeamId: a, transferReason: 'Por error' }).expect(200);
    await as(O).post(`/api/tournaments/${t}/players/${p}/annul-transfer`).send({ reason: 'Se eligió el equipo equivocado' }).expect(200);
    const res = (await history(t, { playerId: p }).expect(200)).body;
    expect(actionsOf(res)).toEqual(['REGISTERED', 'TRANSFER', 'TRANSFER_ANNULLED']);
    expect(res.data.find((e: { action: string }) => e.action === 'TRANSFER')).toMatchObject({ teamId: b, fromTeamId: a, details: { annulled: true } });
    expect(res.data[0]).toMatchObject({ action: 'TRANSFER_ANNULLED', teamId: a, fromTeamId: b, reason: 'Se eligió el equipo equivocado' });
  });

  it('el equipo cambia el dorsal desde su panel: queda con rol TEAM', async () => {
    const { t } = await tournament([]);
    const team = (await as(TM).post('/api/me/teams').send({ name: `Club Hist ${++seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${team}`).expect(201);
    const p = (await as(TM).post(`/api/teams/${team}/global-roster/players`).send({ firstName: 'Del', lastName: `Club${seq}`, position: 'FORWARD', requestId: randomUUID(), confirmNew: true }).expect(201)).body.player.id;
    await as(TM).put(`/api/teams/${team}/tournaments/${t}/players/${p}`).send({ jerseyNumber: 3 }).expect(200);
    await as(TM).put(`/api/teams/${team}/tournaments/${t}/players/${p}`).send({ jerseyNumber: 4 }).expect(200);
    const res = (await history(t).expect(200)).body;
    expect(res.data.map((e: { action: string; by: { role: string } }) => [e.action, e.by.role])).toEqual([['JERSEY_CHANGED', 'TEAM'], ['REGISTERED', 'TEAM']]);
  });

  it('registros anteriores a 3A: por sus fechas, sin autor ni hora (nada inventado)', async () => {
    const { t, teams: [a] } = await tournament(['Viejos']);
    const p = await newPlayer('Antiguo');
    await db().collection('team_memberships').insertOne({ playerId: oid(p), teamId: oid(a), tournamentId: oid(t), jerseyNumber: 4, startDate: '2026-01-10', endDate: '2026-03-01', active: false, endReason: 'Se fue del club' });
    const res = (await history(t).expect(200)).body;
    expect(res.data).toEqual([
      expect.objectContaining({ action: 'UNREGISTERED', at: null, date: '2026-03-01', by: null, legacy: true, reason: 'Se fue del club' }),
      expect.objectContaining({ action: 'REGISTERED', at: null, date: '2026-01-10', by: null, legacy: true }),
    ]);
  });
});

describe('3E — filtros y paginación', () => {
  it('por jugador, equipo (incluye el origen), acción, periodo; páginas estables; validación', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const [p, q] = [await newPlayer('Uno'), await newPlayer('Dos')];
    await register(t, p, { teamId: a }).expect(200);
    await register(t, q, { teamId: b }).expect(200);
    await register(t, p, { teamId: b, fromTeamId: a, transferReason: 'Cambio' }).expect(200);
    expect((await history(t, { playerId: q }).expect(200)).body.meta.total).toBe(1);
    expect(actionsOf((await history(t, { teamId: a }).expect(200)).body)).toEqual(['REGISTERED', 'TRANSFER']);
    expect((await history(t, { action: 'TRANSFER,REGISTERED' }).expect(200)).body.meta.total).toBe(3);
    expect((await history(t, { action: 'TRANSFER' }).expect(200)).body.data).toHaveLength(1);
    expect((await history(t, { from: today, to: today }).expect(200)).body.meta.total).toBe(3);
    expect((await history(t, { to: '2026-01-01' }).expect(200)).body.meta.total).toBe(0);

    const all = (await history(t).expect(200)).body.data.map((e: { id: string }) => e.id);
    const p1 = (await history(t, { limit: 2, page: 1 }).expect(200)).body;
    const p2 = (await history(t, { limit: 2, page: 2 }).expect(200)).body;
    expect(p1.meta).toMatchObject({ total: 3, totalPages: 2 });
    expect([...p1.data, ...p2.data].map((e: { id: string }) => e.id)).toEqual(all);

    await history(t, { action: 'NOPE' }).expect(400);
    await history(t, { limit: 101 }).expect(400);
    await history(t, { from: '2027-13-01' }).expect(400);
    await history(t, { playerId: 'x' }).expect(400);
  });
});

describe('3E — permisos, privacidad y aislamiento', () => {
  it('propietario y administrador sí; coordinador, equipo, otro organizador y anónimo no; finalizado se consulta', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await join(t, ADM, 'ADMIN');
    await join(t, COO, 'COORDINATOR');
    const p = await newPlayer('Privado');
    await register(t, p, { teamId: a }).expect(200);
    await as(O).post(`/api/tournaments/${t}/players/${p}/block`).send({ reason: 'Deuda de inscripción' }).expect(200);
    await history(t, {}, ADM).expect(200);
    await history(t, {}, COO).expect(403);
    await history(t, {}, TM).expect(403);
    await history(t, {}, OTHER).expect(403);
    await request(http).get(`/api/tournaments/${t}/roster-history`).expect(401);
    // Ninguna lectura pública ni del equipo lleva los motivos.
    const pub = JSON.stringify((await request(http).get(`/api/tournaments/${t}/players`).expect(200)).body);
    expect(pub).not.toContain('Deuda');
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    expect((await history(t).expect(200)).body.meta.total).toBe(2);
  });

  it('aislado por torneo: el mismo jugador en otro torneo (de otro organizador) no aparece', async () => {
    const one = await tournament(['Águilas']);
    const two = await tournament(['Búhos'], OTHER);
    const p = await newPlayer('Compartido');
    await register(one.t, p, { teamId: one.teams[0] }).expect(200);
    await as(OTHER).put(`/api/tournaments/${two.t}/players/${p}`).send({ teamId: two.teams[0] }).expect(200);
    await as(OTHER).post(`/api/tournaments/${two.t}/players/${p}/block`).send({ reason: 'Ajeno' }).expect(200);
    const res = (await history(one.t).expect(200)).body;
    expect(res.data.map((e: { action: string; teamId: string }) => [e.action, e.teamId])).toEqual([['REGISTERED', one.teams[0]]]);
    expect(JSON.stringify(res)).not.toContain('Ajeno');
    await history(two.t, {}, O).expect(403);
  });
});

describe('3E/E8 — integridad', () => {
  it('quitar un equipo sin partidos: deja de ser participante, pero su historial administrativo se conserva', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Quitado']);
    const p = await newPlayer('Del Quitado');
    await register(t, p, { teamId: b, jerseyNumber: 8 }).expect(200);
    await as(O).delete(`/api/tournaments/${t}/teams/${b}`).expect(204);
    expect((await as(O).get(`/api/tournaments/${t}/teams`).expect(200)).body.map((e: { teamId: string }) => e.teamId)).toEqual([a]);
    expect(await db().collection('team_memberships').countDocuments({ tournamentId: oid(t), teamId: oid(b) })).toBe(0);
    const res = (await history(t, { teamId: b }).expect(200)).body;
    expect(res.data).toEqual([
      expect.objectContaining({ action: 'TEAM_REMOVED', teamId: b, by: { userId: O.id, role: 'OWNER' }, details: { memberships: 1 } }),
      expect.objectContaining({ action: 'REGISTERED', playerId: p, teamId: b, details: { removedTeam: true } }),
    ]);
    // No cuenta como participación anterior: inscribirlo en otro equipo no es un cambio de equipo.
    await register(t, p, { teamId: a }).expect(200);
    // Y el equipo puede volver a inscribirse.
    await as(O).post(`/api/tournaments/${t}/teams/${b}`).expect(201);
  });

  it('carrera: quitar el equipo mientras se inscribe un jugador → la copia y la base coinciden', async () => {
    for (let round = 0; round < 12; round++) {
      const { t, teams: [, b] } = await tournament(['Águilas', 'Quitado']);
      const p = await newPlayer(`Carrera${round}`);
      const [removed, reg] = await Promise.all([as(O).delete(`/api/tournaments/${t}/teams/${b}`), register(t, p, { teamId: b })]);
      expect(removed.status).toBe(204);
      const archived = (await db().collection('removed_enrollments').findOne({ tournamentId: oid(t) }))!.memberships as unknown[];
      expect(await db().collection('team_memberships').countDocuments({ tournamentId: oid(t) })).toBe(0);
      // Si el alta llegó antes de quitarlo, quedó copiada; si llegó después, se rechazó.
      expect(archived.length).toBe(reg.status === 200 ? 1 : 0);
    }
  });

  it('borrar el torneo o la ficha del jugador no deja bloqueos ni copias huérfanas', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Quitado']);
    const [p, q] = [await newPlayer('Bloq'), await newPlayer('Ficha')];
    await register(t, p, { teamId: a }).expect(200);
    await register(t, q, { teamId: b }).expect(200);
    await as(O).post(`/api/tournaments/${t}/players/${p}/block`).send({ reason: 'Ficha' }).expect(200);
    await as(O).post(`/api/tournaments/${t}/players/${q}/block`).send({ reason: 'Ficha' }).expect(200);
    await as(O).delete(`/api/tournaments/${t}/teams/${b}`).expect(204);
    await as(O).delete(`/api/players/${q}`).expect(204);
    expect(await db().collection('player_blocks').countDocuments({ playerId: oid(q) })).toBe(0);
    expect((await db().collection('removed_enrollments').findOne({ tournamentId: oid(t) }))!.memberships).toEqual([]);
    await as(O).delete(`/api/tournaments/${t}`).expect(204);
    expect(await db().collection('player_blocks').countDocuments({ tournamentId: oid(t) })).toBe(0);
    expect(await db().collection('removed_enrollments').countDocuments({ tournamentId: oid(t) })).toBe(0);
  });

  it('P2: un equipo retirado sigue ocupando su plaza del cupo de equipos (maxTeams)', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    await match(t, 1, a, b);
    await as(O).post(`/api/tournaments/${t}/teams/${b}/withdraw`).send({ reason: 'Abandonó' }).expect(200);
    await as(O).patch(`/api/tournaments/${t}/registration`).send({ enabled: true, maxTeams: 2 }).expect(200);
    const token = (await as(O).post(`/api/tournaments/${t}/registration-link`).expect(200)).body.link.token as string;
    expect((await request(http).get(`/api/tournament-registration/${token}`).expect(200)).body.registration).toMatchObject({ open: false, closedReason: 'FULL', spotsLeft: 0 });
  });
});

describe('3E — rendimiento', () => {
  it('torneo con miles de registros (y otro torneo grande al lado): una página en poco tiempo y con índice', async () => {
    const { t, teams } = await tournament(['A', 'B', 'C', 'D']);
    const other = await tournament(['X']);
    const by = oid(O.id);
    const at = new Date();
    const docs = (tid: string, team: string[], n: number) =>
      Array.from({ length: n }, (_, i) => {
        const closed = i % 2 === 0;
        return {
          playerId: new Types.ObjectId(),
          teamId: oid(team[i % team.length]),
          tournamentId: oid(tid),
          jerseyNumber: null,
          startDate: '2027-01-01',
          registeredAt: '2027-01-01',
          endDate: closed ? '2027-02-01' : null,
          active: !closed,
          endReason: closed ? 'Baja' : null,
          audit: [
            { action: 'REGISTERED', reason: null, by, role: 'OWNER', at, details: null },
            { action: 'JERSEY_CHANGED', reason: null, by, role: 'OWNER', at, details: { from: null, to: 5 } },
            ...(closed ? [{ action: 'UNREGISTERED', reason: 'Baja', by, role: 'OWNER', at, details: null }] : []),
          ],
        };
      });
    await db().collection('team_memberships').insertMany(docs(t, teams, 4000));
    await db().collection('team_memberships').insertMany(docs(other.t, other.teams, 6000));
    await db().collection('player_blocks').insertMany(
      Array.from({ length: 1000 }, () => ({ tournamentId: oid(t), playerId: new Types.ObjectId(), since: '2027-01-05', until: '2027-01-10', reason: 'x', blockedBy: by, blockedRole: 'OWNER', liftReason: 'y', liftedBy: by, liftedRole: 'OWNER', liftedAt: at, createdAt: at, updatedAt: at })),
    );
    const started = Date.now();
    const res = (await history(t, { limit: 50, teamId: teams[1] }).expect(200)).body;
    const elapsed = Date.now() - started;
    expect(res.data).toHaveLength(50);
    expect(res.meta.total).toBe(1000 * 2); // B: posiciones impares, todas vigentes (alta + dorsal)
    console.log(`3E rendimiento: 12 000 eventos derivados (de 4 000 participaciones y 1 000 bloqueos) → página filtrada en ${elapsed} ms`);
    expect(elapsed).toBeLessThan(1000);
    const plan = await db().collection('team_memberships').find({ tournamentId: oid(t) }).explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
  });
});
