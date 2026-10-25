/**
 * Módulo 10A (2026-10-24): cierre y temporadas. Vista previa del cierre (bloqueantes, advertencias,
 * permisos), cierre (listo, con pendientes, en juego, simultáneo, repetido, auditoría), protección e
 * historial del torneo finalizado, reportes del módulo 8 y nueva temporada (qué copia y qué no).
 * Base en memoria (createTestApp): nunca producción.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, type Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, SCO: U, OUT: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const oid = (id: string) => new Types.ObjectId(id);
let seq = 0;

/** Torneo de liga con `n` equipos (un jugador por equipo) y colaboradores de todos los roles. */
async function league(n = 4, extra: Record<string, unknown> = {}) {
  seq++;
  const res = await as(O).post('/api/tournaments').send({ name: `Cierre ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE', ...extra });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  const t = res.body.id as string;
  const teams: string[] = [];
  const players: string[] = [];
  for (let i = 0; i < n; i++) {
    const team = (await as(O).post('/api/teams').send({ name: `Equipo ${seq}-${i}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${team}`).expect(201);
    const p = (await as(O).post('/api/players').send({ firstName: 'Jugador', lastName: `${seq}-${i}`, position: 'FORWARD', confirmNew: true }).expect(201)).body.id as string;
    await as(O).put(`/api/tournaments/${t}/players/${p}`).send({ teamId: team }).expect(200);
    teams.push(team);
    players.push(p);
  }
  for (const [u, role] of [[ADM, 'ADMIN'], [COO, 'COORDINATOR'], [SCO, 'SCORER']] as const) {
    const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body.token;
    await as(u).post(`/api/invitations/${inv}/accept`).expect(200);
  }
  return { t, teams, players };
}
const match = async (t: string, round: number, home: string, away: string) =>
  (await as(O).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date: `2027-02-0${round}`, time: '10:00' }).expect(201)).body.id as string;
const result = (id: string, home: number, away: number, playerStats: unknown[] = []) => as(O).put(`/api/matches/${id}/result`).send({ homeScore: home, awayScore: away, playerStats }).expect(200);
const preview = async (t: string, u = O) => (await as(u).get(`/api/tournaments/${t}/closure`).expect(200)).body;
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, SCO, OUT] = await Promise.all(['DuenoCierre', 'AdminCierre', 'CoordCierre', 'AnotCierre', 'AjenoCierre'].map((n) => registerOrganizer(http, n)));
});
afterAll(async () => ctx?.close());

describe('10A — vista previa del cierre', () => {
  it('con partidos pendientes de todo tipo: se puede finalizar con confirmación; advertencias claras; cancelados no cuentan', async () => {
    const { t, teams: [a, b, c, d] } = await league(4);
    const m1 = await match(t, 1, a, b);
    await result(m1, 2, 0);
    await match(t, 1, c, d); // programado
    const pp = await match(t, 2, a, c);
    const ps = await match(t, 2, b, d);
    const su = await match(t, 3, a, d);
    const ca = await match(t, 3, b, c);
    await db().collection('matches').updateOne({ _id: oid(pp) }, { $set: { status: 'POSTPONED' } });
    await db().collection('matches').updateOne({ _id: oid(ps) }, { $set: { status: 'POSTPONED', pendingSchedule: true } });
    await db().collection('matches').updateOne({ _id: oid(su) }, { $set: { status: 'SUSPENDED' } });
    await db().collection('matches').updateOne({ _id: oid(ca) }, { $set: { status: 'CANCELLED' } });
    const p = await preview(t);
    expect(p).toMatchObject({ status: 'ACTIVE', canFinish: true, requiresConfirmation: true, blockers: [], teams: { enrolled: 4, withdrawn: 0 } });
    expect(p.matches).toMatchObject({ total: 6, finished: 1, scheduled: 1, postponed: 2, pendingSchedule: 1, suspended: 1, cancelled: 1, pending: 4 });
    expect(codes(p.warnings)).toEqual(['SCHEDULED_MATCHES', 'POSTPONED_MATCHES', 'UNSCHEDULED_MATCHES', 'SUSPENDED_MATCHES', 'INCOMPLETE_ROUNDS', 'NO_CHAMPION']);
    expect(p.rounds.incomplete.map((r: { round: number; pending: number }) => [r.round, r.pending])).toEqual([[1, 1], [2, 2], [3, 1]]);
    expect(p.champion).toBeNull();
    // Solo lectura: nada cambió.
    expect((await as(O).get(`/api/tournaments/${t}`).expect(200)).body.status).toBe('ACTIVE');
  });

  it('un partido en juego bloquea (también con confirmación); al terminarlo se puede cerrar', async () => {
    const { t, teams: [a, b] } = await league(2);
    const m = await match(t, 1, a, b);
    await db().collection('matches').updateOne({ _id: oid(m) }, { $set: { status: 'LIVE', homeScore: 1, awayScore: 0 } });
    const p = await preview(t);
    expect(p.canFinish).toBe(false);
    expect(codes(p.blockers)).toEqual(['LIVE_MATCHES']);
    const res = await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(409);
    expect(res.body.message).toMatch(/partido en juego/);
    await result(m, 1, 0);
    await as(O).post(`/api/tournaments/${t}/finish`).send({}).expect(200);
  });

  it('eliminatoria sin final: bloqueante de la competición (regla previa, la misma del cierre)', async () => {
    const { t } = await league(2, { settings: { system: 'KNOCKOUT' } });
    const p = await preview(t);
    expect(p.canFinish).toBe(false);
    expect(codes(p.blockers)).toEqual(['COMPETITION_INCOMPLETE']);
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(409);
  });

  it('borrador: no iniciado; sanciones sin cumplir y adeudos son advertencias (no bloquean)', async () => {
    const draft = await league(2, { status: 'DRAFT' });
    expect(codes((await preview(draft.t)).blockers)).toEqual(['NOT_STARTED']);
    const { t, teams: [a, b, c], players: [pa, pb] } = await league(3);
    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ enabled: true }).expect(200);
    const m1 = await match(t, 1, a, b);
    await match(t, 2, a, c);
    await result(m1, 0, 0, [
      { playerId: pa, teamId: a, goals: 0, assists: 0, yellowCards: 0, redCards: 1, sendOff: 'DIRECT' },
      { playerId: pb, teamId: b, goals: 0, assists: 0, yellowCards: 0, redCards: 0, sendOff: null },
    ]);
    await as(O).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), teamId: a, kind: 'CHARGE', category: 'ENROLLMENT', amount: 50_000, concept: 'Inscripción', date: '2026-01-10' }).expect(201);
    const p = await preview(t);
    expect(p.canFinish).toBe(true);
    expect(codes(p.warnings)).toEqual(expect.arrayContaining(['UNSERVED_SANCTIONS', 'OUTSTANDING_BALANCES']));
    expect(p.warnings.find((w: { code: string }) => w.code === 'OUTSTANDING_BALANCES').message).toContain('500.00 MXN');
  });

  it('permisos: propietario y administrador; coordinador, anotador y ajenos no', async () => {
    const { t } = await league(2);
    await as(O).get(`/api/tournaments/${t}/closure`).expect(200);
    await as(ADM).get(`/api/tournaments/${t}/closure`).expect(200);
    await as(COO).get(`/api/tournaments/${t}/closure`).expect(403);
    await as(SCO).get(`/api/tournaments/${t}/closure`).expect(403);
    await as(OUT).get(`/api/tournaments/${t}/closure`).expect(403);
    await as(O).get(`/api/tournaments/${new Types.ObjectId().toHexString()}/closure`).expect(404);
    await as(O).get('/api/tournaments/no-es-id/closure').expect(400);
    // Coordinador y anotador tampoco pueden finalizar.
    await as(COO).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(403);
    await as(SCO).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(403);
  });
});

describe('10A — cierre oficial', () => {
  it('listo: sin confirmación, con campeón y goleadores; deja auditoría; la vista previa del cerrado lo muestra', async () => {
    const { t, teams: [a, b], players: [pa] } = await league(2);
    const m = await match(t, 1, a, b);
    await result(m, 3, 1, [{ playerId: pa, teamId: a, goals: 3, assists: 0, yellowCards: 0, redCards: 0, sendOff: null }]);
    const before = await preview(t);
    expect(before).toMatchObject({ canFinish: true, requiresConfirmation: false, blockers: [], warnings: [] });
    expect(before.champion.teamId).toBe(a);
    expect(before.topScorers[0]).toMatchObject({ playerId: pa, goals: 3, position: 1 });
    const fin = (await as(ADM).post(`/api/tournaments/${t}/finish`).send({}).expect(200)).body;
    expect(fin.tournament.status).toBe('FINISHED');
    const doc = await db().collection('tournaments').findOne({ _id: oid(t) });
    expect(doc).toMatchObject({ finishedRole: 'ADMIN', pendingAtFinish: 0 });
    expect(String(doc!.finishedBy)).toBe(ADM.id);
    expect(doc!.finishedAt).toBeInstanceOf(Date);
    const after = await preview(t);
    expect(codes(after.blockers)).toEqual(['ALREADY_FINISHED']);
    expect(after.finished).toMatchObject({ by: ADM.id, role: 'ADMIN', pendingAtFinish: 0 });
    expect(after.champion.teamId).toBe(a);
  });

  it('con pendientes: exige confirmación y registra cuántos quedaban', async () => {
    const { t, teams: [a, b, c] } = await league(3);
    await result(await match(t, 1, a, b), 1, 0);
    await match(t, 2, a, c);
    await match(t, 3, b, c);
    const res = await as(O).post(`/api/tournaments/${t}/finish`).send({}).expect(409);
    expect(res.body.message).toMatch(/Quedan 2 partidos/);
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    expect((await db().collection('tournaments').findOne({ _id: oid(t) }))!.pendingAtFinish).toBe(2);
  });

  it('cierres simultáneos: exactamente uno gana; repetirlo es 409; la auditoría no cambia', async () => {
    const { t, teams: [a, b] } = await league(2);
    await result(await match(t, 1, a, b), 1, 1);
    const results = await Promise.all([O, ADM, O, ADM, O].map((u) => as(u).post(`/api/tournaments/${t}/finish`).send({})));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    const first = await db().collection('tournaments').findOne({ _id: oid(t) });
    const again = await as(O).post(`/api/tournaments/${t}/finish`).send({}).expect(409);
    expect(again.body.message).toBe('El torneo ya está finalizado');
    const second = await db().collection('tournaments').findOne({ _id: oid(t) });
    expect(second!.finishedAt).toEqual(first!.finishedAt);
    expect(String(second!.finishedBy)).toBe(String(first!.finishedBy));
  });
});

describe('10A — torneo finalizado: protección, historial y reportes', () => {
  it('no admite cambios deportivos; los cobros siguen; historial, tabla y reportes intactos', async () => {
    const { t, teams: [a, b], players: [pa] } = await league(2);
    const m = await match(t, 1, a, b);
    await result(m, 2, 0, [{ playerId: pa, teamId: a, goals: 2, assists: 0, yellowCards: 0, redCards: 0, sendOff: null }]);
    const tableBefore = (await as(O).get(`/api/tournaments/${t}/standings`).expect(200)).body;
    await as(O).post(`/api/tournaments/${t}/finish`).send({}).expect(200);
    // Inmutable: partidos, resultados, equipos, configuración e inicio.
    await as(O).post('/api/matches').send({ tournamentId: t, round: 2, homeTeamId: a, awayTeamId: b, date: '2027-03-01', time: '10:00' }).expect(409);
    await as(O).put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 0, playerStats: [] }).expect(409);
    const extra = (await as(O).post('/api/teams').send({ name: `Tarde ${seq}` }).expect(201)).body.id;
    await as(O).post(`/api/tournaments/${t}/teams/${extra}`).expect(409);
    await as(O).patch(`/api/tournaments/${t}`).send({ settings: { pointsForWin: 2 } }).expect(409);
    await as(O).post(`/api/tournaments/${t}/start`).expect(409);
    // Los cobros pueden registrarse después del cierre (4C).
    await as(O).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), teamId: a, kind: 'CHARGE', category: 'OTHER', amount: 10_000, concept: 'Multa tardía', date: '2026-01-10' }).expect(201);
    // Historial: tabla igual, listado de finalizados, campeón en la historia de la liga.
    expect((await as(O).get(`/api/tournaments/${t}/standings`).expect(200)).body).toEqual(tableBefore);
    const listed = (await as(O).get('/api/admin/tournaments').query({ status: 'FINISHED', limit: 100 }).expect(200)).body.data.map((x: { id: string }) => x.id);
    expect(listed).toContain(t);
    const leagueId = (await as(O).get(`/api/tournaments/${t}`).expect(200)).body.leagueId;
    const history = (await as(O).get(`/api/leagues/${leagueId}/history`).expect(200)).body;
    expect(JSON.stringify(history.champions)).toContain(a);
    // Reportes del módulo 8: los 7 siguen exportándose.
    for (const r of ['standings', 'matches', 'players', 'rosters', 'discipline', 'finance', 'summary']) await as(O).get(`/api/tournaments/${t}/reports/${r}`).query({ format: 'csv' }).expect(200);
    const summary = (await as(O).get(`/api/tournaments/${t}/reports/summary`).query({ format: 'csv' }).buffer(true).expect(200)).text;
    expect(summary).toContain('Campeón');
  });
});

describe('10A — nueva temporada', () => {
  it('copia la configuración y los equipos; nada deportivo, disciplinario, de jugadores ni de dinero; nace en DRAFT', async () => {
    const { t, teams: [a, b, c], players: [pa, pb] } = await league(3, { settings: { pointsForWin: 2, roundRobinLegs: 2 }, information: { season: 'Apertura 2026', enrollment: { opensOn: '2025-12-01' } }, registration: { deadline: '2026-01-31' } });
    await db().collection('tournaments').updateOne({ _id: oid(t) }, { $set: { 'registration.maxPlayers': 18, 'registration.transferDeadline': '2026-02-15' } });
    await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ enabled: true }).expect(200);
    await result(await match(t, 1, a, b), 1, 0, [
      { playerId: pa, teamId: a, goals: 1, assists: 0, yellowCards: 0, redCards: 1, sendOff: 'DIRECT' },
      { playerId: pb, teamId: b, goals: 0, assists: 0, yellowCards: 0, redCards: 0, sendOff: null },
    ]);
    await as(O).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), teamId: a, kind: 'CHARGE', category: 'ENROLLMENT', amount: 30_000, concept: 'Inscripción', date: '2026-01-10' }).expect(201);
    await match(t, 2, b, c);
    await as(O).post(`/api/tournaments/${t}/teams/${c}/withdraw`).send({ reason: 'Abandonó la liga' }).expect(200);
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    const counts = async (id: string) => ({
      matches: await db().collection('matches').countDocuments({ tournamentId: oid(id) }),
      rounds: await db().collection('rounds').countDocuments({ tournamentId: oid(id) }),
      memberships: await db().collection('team_memberships').countDocuments({ tournamentId: oid(id) }),
      finance: await db().collection('finance_entries').countDocuments({ tournamentId: oid(id) }),
      sanctions: await db().collection('sanctions').countDocuments({ tournamentId: oid(id) }),
      members: await db().collection('tournament_members').countDocuments({ tournamentId: oid(id) }),
    });
    const sourceBefore = await counts(t);

    const res = (await as(O).post(`/api/tournaments/${t}/next-season`).send({ name: 'Clausura 2026', startDate: '2026-08-01', season: 'Clausura 2026' }).expect(201)).body;
    const n = res.tournament;
    expect(n).toMatchObject({ name: 'Clausura 2026', status: 'DRAFT', startDate: '2026-08-01', format: 'FOOTBALL_7', category: 'Libre', previousTournamentId: t, logoUrl: null });
    expect(n.settings).toMatchObject({ pointsForWin: 2, roundRobinLegs: 2 });
    expect(n.information.season).toBe('Clausura 2026');
    expect(n.information.enrollment.opensOn).toBeNull();
    expect(n.registration).toMatchObject({ enabled: false, deadline: null, transferDeadline: null, maxPlayers: 18 });
    expect(n.discipline).toBeUndefined();
    expect(n.writeSeq).toBeUndefined();
    expect((await as(O).get(`/api/tournaments/${n.id}/discipline`).expect(200)).body.rules.enabled).toBe(true);
    const copied = await db().collection('tournaments').findOne({ _id: oid(n.id) });
    expect(copied!.registration.transferDeadline).toBeNull();
    expect(n.finishedAt ?? null).toBeNull();
    expect(n.leagueId).toBe((await as(O).get(`/api/tournaments/${t}`).expect(200)).body.leagueId);
    expect(res.teams).toEqual({ enrolled: 2, notEnrolled: 1, missing: 0 });
    const enrolled = (await as(O).get(`/api/tournaments/${n.id}/teams`).expect(200)).body.map((x: { teamId?: string; team?: { id: string }; id?: string }) => x.teamId ?? x.team?.id ?? x.id);
    expect(JSON.stringify(enrolled)).toContain(a);
    expect(JSON.stringify(enrolled)).toContain(b);
    expect(JSON.stringify(enrolled)).not.toContain(c);
    // Nada deportivo, disciplinario, de jugadores, colaboradores ni dinero.
    expect(await counts(n.id)).toEqual({ matches: 0, rounds: 0, memberships: 0, finance: 0, sanctions: 0, members: 0 });
    expect((await as(O).get(`/api/tournaments/${n.id}/finance/accounts`).expect(200)).body.totals).toMatchObject({ charged: 0, due: 0 });
    expect((await as(O).get(`/api/tournaments/${n.id}/discipline`).expect(200)).body.sanctions).toEqual([]);
    expect((await as(O).get(`/api/tournaments/${n.id}/standings`).expect(200)).body.every((r: { points: number; played: number }) => r.points === 0 && r.played === 0)).toBe(true);
    // El torneo de origen no cambió.
    expect(await counts(t)).toEqual(sourceBefore);
    expect((await as(O).get(`/api/tournaments/${t}`).expect(200)).body.status).toBe('FINISHED');
    // Elegir equipos: solo de los que participaron (el retirado sí, si se pide).
    const pick = (await as(O).post(`/api/tournaments/${t}/next-season`).send({ name: 'Copa', startDate: '2026-09-01', teamIds: [c] }).expect(201)).body;
    expect(pick.teams.enrolled).toBe(1);
    const stranger = (await as(OUT).post('/api/teams').send({ name: 'Ajeno 10A' }).expect(201)).body.id;
    await as(O).post(`/api/tournaments/${t}/next-season`).send({ name: 'X', startDate: '2026-09-01', teamIds: [stranger] }).expect(400);
  });

  it('solo el propietario; validación; un ajeno no puede usar torneos de otros', async () => {
    const { t } = await league(2);
    await as(ADM).post(`/api/tournaments/${t}/next-season`).send({ name: 'X', startDate: '2026-09-01' }).expect(403);
    await as(COO).post(`/api/tournaments/${t}/next-season`).send({ name: 'X', startDate: '2026-09-01' }).expect(403);
    await as(OUT).post(`/api/tournaments/${t}/next-season`).send({ name: 'X', startDate: '2026-09-01' }).expect(403);
    await as(O).post(`/api/tournaments/${new Types.ObjectId().toHexString()}/next-season`).send({ name: 'X', startDate: '2026-09-01' }).expect(404);
    await as(O).post(`/api/tournaments/${t}/next-season`).send({ startDate: '2026-09-01' }).expect(400);
    await as(O).post(`/api/tournaments/${t}/next-season`).send({ name: 'X', startDate: '2026-09-01', endDate: '2026-08-01' }).expect(400);
    await as(O).post(`/api/tournaments/${t}/next-season`).send({ name: 'X', startDate: '2026-09-01', status: 'ACTIVE' }).expect(400);
    await as(O).post(`/api/tournaments/${t}/next-season`).send({ name: 'X', startDate: '2026-09-01', teamIds: ['abc'] }).expect(400);
    // Una nueva temporada desde un torneo en curso también es válida (preparar la siguiente).
    await as(O).post(`/api/tournaments/${t}/next-season`).send({ name: 'Siguiente', startDate: '2026-09-01' }).expect(201);
  });
});
