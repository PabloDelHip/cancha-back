/**
 * Módulo 3A — inscripción de jugadores en equipos de un torneo (TeamMembership). Ver docs/players-3a.md.
 * Fechas: los partidos de 2027 son FUTUROS (la inscripción de hoy los cubre); los de 2026-0x ya
 * pasaron (exigen elegibilidad retroactiva). El servidor toma "hoy" del reloj real.
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { OwnershipService } from '../src/common/authorization/ownership.service.js';
import { todayISODate } from '../src/common/utils/dates.js';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, OUT: U, SCO: U, ADM: U, MGR: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const oid = (id: string) => new Types.ObjectId(id);
const TODAY = todayISODate();
const PAST = '2026-02-01';
let seq = 0;

type S = { t: string; home: string; away: string; third: string };
async function setup(opts: { status?: string; maxPlayers?: number } = {}): Promise<S> {
  seq++;
  const t = (await as(O).post('/api/tournaments').send({ name: `Inscripciones ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: opts.status ?? 'ACTIVE' }).expect(201)).body.id as string;
  if (opts.maxPlayers) await db().collection('tournaments').updateOne({ _id: oid(t) }, { $set: { 'registration.maxPlayers': opts.maxPlayers } });
  const team = async (name: string) => (await as(O).post('/api/teams').send({ name: `${name} I${seq}` }).expect(201)).body.id as string;
  const [home, away, third] = [await team('Halcones'), await team('Tigres'), await team('Pumas')];
  for (const id of [home, away]) await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  return { t, home, away, third };
}
const newPlayer = async (name = 'Jugador') =>
  (await as(O).post('/api/players').send({ firstName: name, lastName: `I${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
const put = (t: string, p: string, body: Record<string, unknown>, who = O) => as(who).put(`/api/tournaments/${t}/players/${p}`).send(body);
const unregister = (t: string, p: string, reason?: string, who = O) => as(who).delete(`/api/tournaments/${t}/players/${p}`).send(reason === undefined ? {} : { reason });
const memberships = (t: string, p: string, extra: Record<string, unknown> = {}) => db().collection('team_memberships').find({ tournamentId: oid(t), playerId: oid(p), ...extra }).toArray();
const active = (t: string, p: string) => memberships(t, p, { active: true });
const roster = async (t: string, team: string) =>
  (await request(http).get(`/api/tournaments/${t}/players?teamId=${team}`).expect(200)).body as { player: { id: string }; membership: Record<string, unknown> }[];
const newMatch = async (s: S, round: number, date: string, home = s.home, away = s.away) =>
  (await as(O).post('/api/matches').send({ tournamentId: s.t, round, homeTeamId: home, awayTeamId: away, date, time: '18:00' }).expect(201)).body.id as string;
const stat = (playerId: string, teamId: string, goals = 0) => ({ playerId, teamId, goals, assists: 0, yellowCards: 0, redCards: 0, sendOff: null });
const result = (m: string, playerStats: unknown[], extra: Record<string, unknown> = {}, who = O) =>
  as(who).put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 0, status: 'FINISHED', playerStats, ...extra });
const managerPlayer = async (team: string, name: string) =>
  (await as(MGR).post(`/api/teams/${team}/global-roster/players`).send({ firstName: name, lastName: `Eq${seq}`, position: 'MIDFIELDER', requestId: randomUUID(), confirmNew: true }).expect(201)).body.player.id as string;
async function join(t: string, u: U, role: string) {
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, OUT, SCO, ADM, MGR] = [
    await registerOrganizer(http, 'Dueño3A'),
    await registerOrganizer(http, 'Ajeno3A'),
    await registerOrganizer(http, 'Anota3A'),
    await registerOrganizer(http, 'Admin3A'),
    await registerOrganizer(http, 'Delegado3A'),
  ];
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => ctx?.close());

describe('inscribir', () => {
  it('válida: aparece en la plantilla; fecha real y efectiva = hoy; queda quién la hizo (no se expone en público)', async () => {
    const s = await setup();
    const p = await newPlayer();
    await put(s.t, p, { teamId: s.home, jerseyNumber: 9 }).expect(200);
    const [m] = await active(s.t, p);
    expect(m).toMatchObject({ startDate: TODAY, registeredAt: TODAY, jerseyNumber: 9 });
    expect(m.audit).toEqual([expect.objectContaining({ action: 'REGISTERED', by: oid(O.id), role: 'OWNER' })]);
    const r = await roster(s.t, s.home);
    expect(r).toEqual([expect.objectContaining({ player: expect.objectContaining({ id: p }), membership: expect.objectContaining({ jerseyNumber: 9, teamId: s.home }) })]);
    expect(r[0].membership).not.toHaveProperty('audit');
    expect(JSON.stringify((await request(http).get(`/api/players/${p}/memberships`).expect(200)).body)).not.toContain('audit');
  });

  it('duplicada en el mismo equipo: idempotente (una sola participación); solo cambia el dorsal', async () => {
    const s = await setup();
    const p = await newPlayer();
    await put(s.t, p, { teamId: s.home, jerseyNumber: 9 }).expect(200);
    await put(s.t, p, { teamId: s.home, jerseyNumber: 9 }).expect(200);
    await put(s.t, p, { teamId: s.home, jerseyNumber: 10 }).expect(200);
    const rows = await active(s.t, p);
    expect(rows).toHaveLength(1);
    expect(rows[0].jerseyNumber).toBe(10);
  });

  it('en otro equipo del mismo torneo: 409 PLAYER_IN_OTHER_TEAM, no se le mueve', async () => {
    const s = await setup();
    const p = await newPlayer();
    await put(s.t, p, { teamId: s.home }).expect(200);
    const res = await put(s.t, p, { teamId: s.away }).expect(409);
    expect(res.body).toMatchObject({ error: 'PLAYER_IN_OTHER_TEAM', teamId: s.home });
    expect((await active(s.t, p)).map((m) => String(m.teamId))).toEqual([s.home]);
    await put(s.t, p, { teamId: s.away, fromTeamId: s.away, transferReason: 'Cambio de prueba' }).expect(409); // pantalla desactualizada
  });

  it('cambio de equipo explícito: cierra la participación (MOVED) y abre otra', async () => {
    const s = await setup();
    const p = await newPlayer();
    await put(s.t, p, { teamId: s.home }).expect(200);
    await put(s.t, p, { teamId: s.away, fromTeamId: s.home, transferReason: 'Cambio de prueba' }).expect(200);
    const rows = (await memberships(s.t, p)).sort((a, b) => Number(a.active) - Number(b.active));
    expect(rows.map((m) => [String(m.teamId), m.active, m.endDate, m.startDate])).toEqual([
      [s.home, false, TODAY, TODAY],
      [s.away, true, null, TODAY],
    ]);
    expect(rows[0].audit.map((a: { action: string }) => a.action)).toEqual(['REGISTERED', 'MOVED']);
  });

  it('el mismo jugador en torneos diferentes: una participación activa en cada uno', async () => {
    const [a, b] = [await setup(), await setup()];
    const p = await newPlayer();
    await put(a.t, p, { teamId: a.home, jerseyNumber: 7 }).expect(200);
    await put(b.t, p, { teamId: b.away, jerseyNumber: 7 }).expect(200);
    expect(await active(a.t, p)).toHaveLength(1);
    expect(await active(b.t, p)).toHaveLength(1);
  });

  it('dorsal ocupado en el equipo → 409', async () => {
    const s = await setup();
    const [p1, p2] = [await newPlayer('Uno'), await newPlayer('Dos')];
    await put(s.t, p1, { teamId: s.home, jerseyNumber: 5 }).expect(200);
    await put(s.t, p2, { teamId: s.home, jerseyNumber: 5 }).expect(409);
    await put(s.t, p2, { teamId: s.away, jerseyNumber: 5 }).expect(200);
  });
});

describe('6. errores unificados y permisos', () => {
  it('404 si no existe (torneo, jugador, equipo); 409 TEAM_NOT_ENROLLED si el equipo existe pero no juega el torneo', async () => {
    const s = await setup();
    const p = await newPlayer();
    await put('6a0000000000000000000000', p, { teamId: s.home }).expect(404);
    await put(s.t, '6a0000000000000000000000', { teamId: s.home }).expect(404);
    await put(s.t, p, { teamId: '6a0000000000000000000000' }).expect(404);
    expect((await put(s.t, p, { teamId: s.third }).expect(409)).body.error).toBe('TEAM_NOT_ENROLLED');
    expect(await active(s.t, p)).toHaveLength(0);
  });

  it('organizador ajeno: 403 antes que cualquier otro dato (no revela si el equipo está inscrito)', async () => {
    const s = await setup();
    const p = await newPlayer();
    const a = await put(s.t, p, { teamId: s.home }, OUT).expect(403);
    const b = await put(s.t, p, { teamId: s.third }, OUT).expect(403);
    expect(a.body.message).toBe(b.body.message);
    await unregister(s.t, p, 'Motivo', OUT).expect(403);
  });

  it('anotador (sin TEAMS) 403', async () => {
    const s = await setup();
    await join(s.t, SCO, 'SCORER');
    await put(s.t, await newPlayer(), { teamId: s.home }, SCO).expect(403);
  });

  it('lado del equipo: equipo no inscrito → 409 TEAM_NOT_ENROLLED (antes 404)', async () => {
    const s = await setup();
    const team = (await as(MGR).post('/api/me/teams').send({ name: `Propio ${seq}` }).expect(201)).body.id as string;
    const p = await managerPlayer(team, 'Propio');
    expect((await as(MGR).put(`/api/teams/${team}/tournaments/${s.t}/players/${p}`).send({}).expect(409)).body.error).toBe('TEAM_NOT_ENROLLED');
    // La baja responde igual que el alta (antes 404 "no está en la plantilla").
    expect((await as(MGR).delete(`/api/teams/${team}/tournaments/${s.t}/players/${p}`).send({ reason: 'Prueba' }).expect(409)).body.error).toBe('TEAM_NOT_ENROLLED');
  });

  it('torneo FINISHED: 409 al inscribir, mover o dar de baja; DRAFT sí inscribe', async () => {
    const s = await setup();
    const [p, q] = [await newPlayer('Antes'), await newPlayer('Tarde')];
    await put(s.t, p, { teamId: s.home }).expect(200);
    await as(O).post(`/api/tournaments/${s.t}/finish`).send({ allowPendingMatches: true }).expect(200);
    await put(s.t, q, { teamId: s.home }).expect(409);
    await put(s.t, p, { teamId: s.away, fromTeamId: s.home, transferReason: 'Cambio de prueba' }).expect(409);
    await unregister(s.t, p, 'Se fue del club').expect(409);
    const d = await setup({ status: 'DRAFT' });
    await put(d.t, await newPlayer(), { teamId: d.home }).expect(200);
  });
});

describe('1. máximo de jugadores por equipo', () => {
  it('lleno → 409 TEAM_FULL; el organizador lo supera con motivo (OVER_LIMIT auditado)', async () => {
    const s = await setup({ maxPlayers: 2 });
    for (const n of ['A', 'B']) await put(s.t, await newPlayer(n), { teamId: s.home }).expect(200);
    const c = await newPlayer('C');
    expect((await put(s.t, c, { teamId: s.home }).expect(409)).body).toMatchObject({ error: 'TEAM_FULL', max: 2, count: 2 });
    await put(s.t, c, { teamId: s.home, overLimitReason: '  ' }).expect(409); // motivo vacío = sin excepción
    await put(s.t, c, { teamId: s.home, overLimitReason: 'Portero suplente por lesión' }).expect(200);
    const [m] = await active(s.t, c);
    expect(m.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'OVER_LIMIT', reason: 'Portero suplente por lesión', by: oid(O.id), details: { max: 2, count: 2 } })]));
    // Mover a otro equipo también respeta el cupo del destino (Tigres: 1 de 2 → cabe).
    await put(s.t, await newPlayer('D'), { teamId: s.away }).expect(200);
    await put(s.t, c, { teamId: s.away, fromTeamId: s.home, transferReason: 'Cambio de prueba' }).expect(200);
    await put(s.t, c, { teamId: s.home, fromTeamId: s.away, transferReason: 'Cambio de prueba' }).expect(409); // Halcones volvió a 2 de 2
  });

  it('el equipo (dueño/manager) no puede superarlo: TEAM_FULL', async () => {
    const s = await setup({ maxPlayers: 1 });
    const team = (await as(MGR).post('/api/me/teams').send({ name: `Lleno ${seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${s.t}/teams/${team}`).expect(201);
    const [a, b] = [await managerPlayer(team, 'Uno'), await managerPlayer(team, 'Dos')];
    await as(MGR).put(`/api/teams/${team}/tournaments/${s.t}/players/${a}`).send({}).expect(200);
    expect((await as(MGR).put(`/api/teams/${team}/tournaments/${s.t}/players/${b}`).send({}).expect(409)).body.error).toBe('TEAM_FULL');
  });

  it('ráfaga real hacia el último lugar: solo uno entra', async () => {
    const s = await setup({ maxPlayers: 3 });
    for (const n of ['A', 'B']) await put(s.t, await newPlayer(n), { teamId: s.home }).expect(200);
    const players = await Promise.all([1, 2, 3, 4, 5].map((i) => newPlayer(`Cupo${i}`)));
    const results = await Promise.all(players.map((p) => put(s.t, p, { teamId: s.home })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await db().collection('team_memberships').countDocuments({ tournamentId: oid(s.t), teamId: oid(s.home), active: true })).toBe(3);
  });

  it('un administrador del torneo también autoriza la excepción (queda su rol)', async () => {
    const s = await setup({ maxPlayers: 1 });
    await join(s.t, ADM, 'ADMIN');
    await put(s.t, await newPlayer('Uno'), { teamId: s.home }, ADM).expect(200);
    const p = await newPlayer('Dos');
    await put(s.t, p, { teamId: s.home }, ADM).expect(409);
    await put(s.t, p, { teamId: s.home, overLimitReason: 'Acordado en junta' }, ADM).expect(200);
    expect((await active(s.t, p))[0].audit.find((a: { action: string }) => a.action === 'OVER_LIMIT')).toMatchObject({ role: 'ADMIN', by: oid(ADM.id) });
  });
});

describe('2 y 5. inscripción tardía y fechas retroactivas', () => {
  it('inscrito hoy no es elegible para un partido anterior (ni captura ni ficha); sí para los de hoy en adelante', async () => {
    const s = await setup();
    const m = await newMatch(s, 1, PAST);
    const p = await newPlayer('Tardío');
    await put(s.t, p, { teamId: s.home }).expect(200);
    await result(m, [stat(p, s.home)]).expect(400);
    await as(O).put(`/api/matches/${m}/sheet/teams/${s.home}`).send({ players: [{ playerId: p, starter: true }], substitutions: [] }).expect(400);
    const future = await newMatch(s, 2, '2027-03-01');
    await result(future, [stat(p, s.home, 1)], { homeScore: 1 }).expect(200);
  });

  it('retroactiva: exige motivo; separa fecha real y efectiva, y habilita el partido', async () => {
    const s = await setup();
    const m = await newMatch(s, 1, PAST);
    const p = await newPlayer('Retro');
    await put(s.t, p, { teamId: s.home, startDate: PAST }).expect(400);
    await put(s.t, p, { teamId: s.home, startDate: PAST, retroactiveReason: 'Jugó la jornada 1; olvidamos inscribirlo' }).expect(200);
    const [row] = await active(s.t, p);
    expect(row).toMatchObject({ startDate: PAST, registeredAt: TODAY });
    expect(row.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'RETROACTIVE', reason: 'Jugó la jornada 1; olvidamos inscribirlo', details: { from: TODAY, to: PAST } })]));
    await result(m, [stat(p, s.home, 1)], { homeScore: 1 }).expect(200);
  });

  it('adelantar la elegibilidad de una participación vigente (mismo equipo), con motivo; retrasarla no', async () => {
    const s = await setup();
    const m = await newMatch(s, 1, PAST);
    const p = await newPlayer('Adelanta');
    await put(s.t, p, { teamId: s.home }).expect(200);
    await put(s.t, p, { teamId: s.home, startDate: PAST }).expect(400);
    await put(s.t, p, { teamId: s.home, startDate: PAST, retroactiveReason: 'Estaba en la cédula de la J1' }).expect(200);
    expect((await active(s.t, p))[0].startDate).toBe(PAST);
    await result(m, [stat(p, s.home)]).expect(200);
    await put(s.t, p, { teamId: s.home, startDate: '2026-03-01' }).expect(400);
  });

  it('sin REGISTRATION_EXCEPTIONS no se autoriza una fecha retroactiva (403)', async () => {
    const s = await setup();
    await join(s.t, SCO, 'SCORER');
    await put(s.t, await newPlayer(), { teamId: s.home, startDate: PAST, retroactiveReason: 'x x x' }, SCO).expect(403);
  });

  it('cambio de equipo retroactivo que dejaría fuera partidos ya jugados → 409; posterior a ellos, sí', async () => {
    const s = await setup();
    const p = await newPlayer('Movido');
    await put(s.t, p, { teamId: s.home, startDate: '2026-01-01', retroactiveReason: 'Plantilla inicial' }).expect(200);
    const played = await newMatch(s, 1, '2026-03-10');
    await result(played, [stat(p, s.home, 1)], { homeScore: 1 }).expect(200);
    const res = await put(s.t, p, { teamId: s.away, fromTeamId: s.home, transferReason: 'Cambio de prueba', startDate: '2026-03-01', retroactiveReason: 'Se fue en febrero' }).expect(409);
    expect(res.body).toMatchObject({ error: 'MOVE_AFFECTS_PLAYED_MATCHES', matchIds: [played] });
    await put(s.t, p, { teamId: s.away, fromTeamId: s.home, transferReason: 'Cambio de prueba', startDate: '2026-03-10', retroactiveReason: 'Pasó a Tigres tras la J1' }).expect(200);
    const stats = (await request(http).get(`/api/players/${p}/stats`).expect(200)).body;
    expect(stats.byTournament[0]).toMatchObject({ goals: 1, team: expect.objectContaining({ id: s.home }) });
  });

  it('una nueva participación no puede empezar antes de que terminara la anterior (PERIOD_OVERLAP)', async () => {
    const s = await setup();
    const p = await newPlayer('Vuelve');
    await put(s.t, p, { teamId: s.home, startDate: '2026-01-01', retroactiveReason: 'Plantilla inicial' }).expect(200);
    await unregister(s.t, p, 'Baja temporal').expect(204);
    // 3D: volver con OTRO equipo tras una baja es un cambio de equipo (motivo obligatorio).
    expect((await put(s.t, p, { teamId: s.away, startDate: '2026-05-01', retroactiveReason: 'Regresó', transferReason: 'Vuelve con Tigres' }).expect(409)).body.error).toBe('PERIOD_OVERLAP');
    await put(s.t, p, { teamId: s.away, transferReason: 'Vuelve con Tigres' }).expect(200);
  });
});

describe('3. misma fecha deportiva con dos equipos', () => {
  async function moved() {
    const s = await setup();
    const p = await newPlayer('Doble');
    // Juega con Halcones y el 2027-01-10 pasa a Tigres: ese día ambas participaciones son vigentes.
    await put(s.t, p, { teamId: s.home, jerseyNumber: 8 }).expect(200);
    await put(s.t, p, { teamId: s.away, fromTeamId: s.home, transferReason: 'Cambio de prueba', startDate: '2027-01-10' }).expect(200);
    await as(O).post(`/api/tournaments/${s.t}/teams/${s.third}`).expect(201);
    const m1 = await newMatch(s, 1, '2027-01-10', s.home, s.third);
    const m2 = await newMatch(s, 2, '2027-01-10', s.away, s.third);
    return { s, p, m1, m2 };
  }

  it('capturado con un equipo, el otro partido del mismo día lo rechaza (409 SAME_DATE_OTHER_TEAM), en captura y ficha', async () => {
    const { s, p, m1, m2 } = await moved();
    await result(m1, [stat(p, s.home)]).expect(200);
    expect((await result(m2, [stat(p, s.away)]).expect(409)).body).toMatchObject({ error: 'SAME_DATE_OTHER_TEAM', conflicts: [{ playerId: p, teamId: s.home, matchId: m1 }] });
    await as(O).put(`/api/matches/${m2}/sheet/teams/${s.away}`).send({ players: [{ playerId: p, starter: true }], substitutions: [] }).expect(409);
    // Como suplente que no ingresa sí puede figurar (no participa).
    await as(O).put(`/api/matches/${m2}/sheet/teams/${s.away}`).send({ players: [{ playerId: p, starter: false }], substitutions: [] }).expect(200);
  });

  it('la misma jornada en otro día también cuenta (fecha deportiva)', async () => {
    const s = await setup();
    const p = await newPlayer('Jornada');
    await put(s.t, p, { teamId: s.home }).expect(200);
    await as(O).post(`/api/tournaments/${s.t}/teams/${s.third}`).expect(201);
    const fourth = (await as(O).post('/api/teams').send({ name: `Linces I${seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${s.t}/teams/${fourth}`).expect(201);
    const m1 = await newMatch(s, 4, '2027-02-06', s.home, fourth);
    await result(m1, [stat(p, s.home)]).expect(200);
    await put(s.t, p, { teamId: s.third, fromTeamId: s.home, transferReason: 'Cambio de prueba', startDate: '2027-02-07' }).expect(200);
    const m2 = await newMatch(s, 4, '2027-02-13', s.third, s.away); // jornada 4 pospuesta
    await result(m2, [stat(p, s.third)]).expect(409);
    const m3 = await newMatch(s, 5, '2027-02-14', s.third, s.home);
    await result(m3, [stat(p, s.third)]).expect(200);
  });

  it('corrección administrativa: con motivo y permiso se acepta y queda en el historial del partido; el anotador no puede', async () => {
    const { s, p, m1, m2 } = await moved();
    await result(m1, [stat(p, s.home)]).expect(200);
    await join(s.t, SCO, 'SCORER');
    await result(m2, [stat(p, s.away)], { sameDateReason: 'Error de captura' }, SCO).expect(403);
    await result(m2, [stat(p, s.away)], { sameDateReason: 'Autorizado por la junta: jugó ambos (doble cédula)' }).expect(200);
    const log = (await as(O).get(`/api/matches/${m2}/log`).expect(200)).body.entries as { action: string; reason: string }[];
    expect(log).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'ELIGIBILITY_OVERRIDE', reason: 'Autorizado por la junta: jugó ambos (doble cédula)' })]));
  });

  it('carrera real: dos capturas simultáneas de partidos del mismo día con equipos distintos → solo una pasa', async () => {
    const { s, p, m1, m2 } = await moved();
    const [a, b] = await Promise.all([result(m1, [stat(p, s.home)]), result(m2, [stat(p, s.away)])]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db().collection('player_match_stats').countDocuments({ playerId: oid(p) })).toBe(1);
  });
});

describe('4. bajas con motivo', () => {
  it('sin motivo 400; con motivo se cierra, conserva estadísticas, ficha e historial, y queda auditada (motivo no público)', async () => {
    const s = await setup();
    const p = await newPlayer('Histórico');
    await put(s.t, p, { teamId: s.home, jerseyNumber: 8 }).expect(200);
    const m = await newMatch(s, 1, '2027-01-07');
    await as(O).put(`/api/matches/${m}/sheet/teams/${s.home}`).send({ players: [{ playerId: p, starter: true }], substitutions: [] }).expect(200);
    await result(m, [stat(p, s.home, 1)], { homeScore: 1 }).expect(200);

    await unregister(s.t, p).expect(400);
    await unregister(s.t, p, ' ').expect(400);
    await unregister(s.t, p, 'Se mudó de ciudad').expect(204);
    const [row] = await memberships(s.t, p);
    expect(row).toMatchObject({ active: false, endDate: TODAY, endReason: 'Se mudó de ciudad' });
    expect(row.audit.at(-1)).toMatchObject({ action: 'UNREGISTERED', reason: 'Se mudó de ciudad', by: oid(O.id), role: 'OWNER' });

    const sheet = (await as(O).get(`/api/matches/${m}/sheet`).expect(200)).body;
    expect(sheet.teams[0].lineup.players).toEqual([expect.objectContaining({ playerId: p, jerseyNumber: 8 })]);
    expect(sheet.teams[0].consistency.consistent).toBe(true);
    const stats = (await request(http).get(`/api/players/${p}/stats`).expect(200)).body;
    expect(stats.byTournament[0]).toMatchObject({ goals: 1, team: expect.objectContaining({ id: s.home }) });
    const history = (await request(http).get(`/api/players/${p}/memberships`).expect(200)).body;
    expect(history).toEqual([expect.objectContaining({ teamId: s.home, active: false })]);
    expect(JSON.stringify(history)).not.toContain('Se mudó');
  });

  it('lado del equipo: la baja también exige motivo', async () => {
    const s = await setup();
    const team = (await as(MGR).post('/api/me/teams').send({ name: `Baja ${seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${s.t}/teams/${team}`).expect(201);
    const p = await managerPlayer(team, 'Baja');
    await as(MGR).put(`/api/teams/${team}/tournaments/${s.t}/players/${p}`).send({}).expect(200);
    await as(MGR).delete(`/api/teams/${team}/tournaments/${s.t}/players/${p}`).send({}).expect(400);
    await as(MGR).delete(`/api/teams/${team}/tournaments/${s.t}/players/${p}`).send({ reason: 'Ya no viene' }).expect(204);
    expect((await memberships(s.t, p))[0].audit.at(-1)).toMatchObject({ action: 'UNREGISTERED', role: 'TEAM', reason: 'Ya no viene' });
  });
});

describe('concurrencia de inscripciones', () => {
  it('ráfaga real: el mismo jugador a dos equipos a la vez → una sola participación, nadie lo mueve', async () => {
    const s = await setup();
    const p = await newPlayer();
    const results = await Promise.all([s.home, s.away, s.home, s.away, s.home, s.away].map((team) => put(s.t, p, { teamId: team })));
    expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect(await memberships(s.t, p)).toHaveLength(1);
  });

  it('ráfaga real: el mismo dorsal en el mismo equipo → solo uno lo obtiene', async () => {
    const s = await setup();
    const players = await Promise.all([1, 2, 3, 4].map((i) => newPlayer(`Dorsal${i}`)));
    const results = await Promise.all(players.map((p) => put(s.t, p, { teamId: s.home, jerseyNumber: 10 })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await roster(s.t, s.home)).filter((r) => r.membership.jerseyNumber === 10)).toHaveLength(1);
  });

  it('inscribir mientras se retira el equipo del torneo: no queda una participación huérfana', async () => {
    const s = await setup();
    const p = await newPlayer();
    const ownership = ctx.app.get(OwnershipService);
    const original = ownership.inTournament.bind(ownership);
    vi.spyOn(ownership, 'inTournament').mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      await sleep(300);
      return original(...args);
    });
    const registering = put(s.t, p, { teamId: s.home }).then((r) => r);
    await sleep(80);
    await as(O).delete(`/api/tournaments/${s.t}/teams/${s.home}`).expect(204);
    const res = await registering;
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('TEAM_NOT_ENROLLED');
    expect(await db().collection('team_memberships').countDocuments({ tournamentId: oid(s.t), teamId: oid(s.home) })).toBe(0);
  });
});

describe('compatibilidad', () => {
  it('participación anterior a 3A (sin registeredAt) sigue valiendo para partidos anteriores: nada histórico cambia', async () => {
    const s = await setup();
    const m = await newMatch(s, 1, PAST);
    const p = await newPlayer('Legado');
    await db().collection('team_memberships').insertOne({ playerId: oid(p), teamId: oid(s.home), tournamentId: oid(s.t), jerseyNumber: 4, startDate: TODAY, endDate: null, active: true, createdAt: new Date(), updatedAt: new Date() });
    await result(m, [stat(p, s.home)]).expect(200);
    await as(O).put(`/api/matches/${m}/sheet/teams/${s.home}`).send({ players: [{ playerId: p, starter: true }], substitutions: [] }).expect(200);
    await unregister(s.t, p, 'Fin de temporada').expect(204);
  });
});
