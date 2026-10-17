/**
 * Módulo 3D (2026-10-16): bajas, bloqueos y restricciones.
 * - D1/D8: una baja intermedia no evita las reglas de transferencia de 3C (organizador, equipo y enlace).
 * - D2–D4: bloqueo administrativo por torneo (no es una sanción).
 * - D5–D7: equipo retirado después de jugar: conserva resultados, no recibe jugadores ni partidos,
 *   sus pendientes se cancelan y no clasifica. Reincorporación con validación de integridad.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, type Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { todayISODate } from '../src/common/utils/dates.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, TM: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const oid = (id: string) => new Types.ObjectId(id);
let seq = 0;

async function tournament(names: string[], settings: Record<string, unknown> = {}) {
  seq++;
  const t = (await as(O).post('/api/tournaments').send({ name: `Restr ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE', settings }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (const [i, name] of names.entries()) {
    const id = (await as(O).post('/api/teams').send({ name: `E${i + 1} ${name} R${seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
async function player(t: string, team: string, name: string) {
  const id = (await as(O).post('/api/players').send({ firstName: name, lastName: `R${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
  await as(O).put(`/api/tournaments/${t}/players/${id}`).send({ teamId: team, startDate: '2026-01-01', retroactiveReason: 'Inscrito desde el inicio' }).expect(200);
  return id;
}
const register = (t: string, p: string, body: Record<string, unknown>, who = O) => as(who).put(`/api/tournaments/${t}/players/${p}`).send(body);
const drop = (t: string, p: string, who = O) => as(who).delete(`/api/tournaments/${t}/players/${p}`).send({ reason: 'Dejó de venir' });
const block = (t: string, p: string, body: Record<string, unknown> = { reason: 'Falta la ficha médica' }, who = O) => as(who).post(`/api/tournaments/${t}/players/${p}/block`).send(body);
const unblock = (t: string, p: string, body: Record<string, unknown> = { reason: 'Entregó la ficha médica' }, who = O) => as(who).post(`/api/tournaments/${t}/players/${p}/unblock`).send(body);
const withdraw = (t: string, team: string, body: Record<string, unknown> = { reason: 'Abandonó el torneo' }, who = O) => as(who).post(`/api/tournaments/${t}/teams/${team}/withdraw`).send(body);
const reinstate = (t: string, team: string, body: Record<string, unknown> = { reason: 'Volvió a presentarse' }, who = O) => as(who).post(`/api/tournaments/${t}/teams/${team}/reinstate`).send(body);
const row = (playerId: string, teamId: string) => ({ playerId, teamId, goals: 0, assists: 0, yellowCards: 0, redCards: 0, sendOff: null });
const result = (m: string, playerStats: unknown[], home = 0, away = 0) => as(O).put(`/api/matches/${m}/result`).send({ homeScore: home, awayScore: away, status: 'FINISHED', playerStats });
const match = async (t: string, round: number, home: string, away: string, date = '2027-02-07') =>
  (await as(O).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date, time: '18:00' }).expect(201)).body.id as string;
const memberships = (t: string, p: string) => db().collection('team_memberships').find({ tournamentId: oid(t), playerId: oid(p) }).sort({ _id: 1 }).toArray();
const matchDoc = (m: string) => db().collection('matches').findOne({ _id: oid(m) });
const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);
async function join(t: string, u: U, role: string) {
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}
/** Equipo propio de TM (OWNER) inscrito en el torneo, con un jugador en su plantilla global. */
async function teamOfTM(t: string) {
  const team = (await as(TM).post('/api/me/teams').send({ name: `Club TM ${++seq}` }).expect(201)).body.id as string;
  await as(O).post(`/api/tournaments/${t}/teams/${team}`).expect(201);
  return team;
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, TM] = [await registerOrganizer(http, 'DueñoRestr'), await registerOrganizer(http, 'AdminRestr'), await registerOrganizer(http, 'CoordRestr'), await registerOrganizer(http, 'ClubRestr')];
});
afterAll(async () => ctx?.close());

describe('D1/D8 — una baja intermedia no evita las reglas de transferencia', () => {
  it('organizador: baja en A y alta en B = cambio de equipo (motivo, plazo); volver a A es un alta normal', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo');
    await drop(t, p).expect(204);
    const res = await register(t, p, { teamId: b }).expect(409);
    expect(res.body).toMatchObject({ error: 'TRANSFER_REASON_REQUIRED', previousTeamId: a });
    await as(O).patch(`/api/tournaments/${t}/registration`).send({ transferDeadline: yesterday() }).expect(200);
    expect((await register(t, p, { teamId: b, transferReason: 'Se pasó a Búhos' }).expect(409)).body.error).toBe('TRANSFER_DEADLINE_PASSED');
    // Volver al MISMO equipo no es una transferencia: ni motivo ni plazo.
    await register(t, p, { teamId: a }).expect(200);
    await drop(t, p).expect(204);
    await as(O).patch(`/api/tournaments/${t}/registration`).send({ transferDeadline: null }).expect(200);
    await register(t, p, { teamId: b, transferReason: 'Se pasó a Búhos' }).expect(200);
    const docs = await memberships(t, p);
    expect(docs.at(-1)!.audit[0]).toMatchObject({ action: 'REGISTERED', reason: 'Se pasó a Búhos', details: { previousTeamId: a } });
    // No es un cambio directo: no se "anula" (reabriría una baja explícita).
    expect((await as(O).post(`/api/tournaments/${t}/players/${p}/annul-transfer`).send({ reason: 'Error de carga' }).expect(409)).body.error).toBe('NOT_A_TRANSFER');
  });

  it('bloqueo de eliminatoria también tras una baja (con excepción del organizador)', async () => {
    const { t, teams: [a, b, c, d] } = await tournament(['Águilas', 'Búhos', 'Cóndores', 'Delfines'], { system: 'KNOCKOUT' });
    await as(O).patch(`/api/tournaments/${t}/registration`).send({ lockTransfersOnKnockout: true }).expect(200);
    await as(O).post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 4 }).expect(201);
    await as(O).post(`/api/tournaments/${t}/phases/0/ties`).send({ round: 0, homeTeamId: a, awayTeamId: b, legs: [{ date: '2026-05-01', time: '18:00' }] }).expect(201);
    void c;
    void d;
    const p = await player(t, c, 'Pablo');
    await drop(t, p).expect(204);
    const reason = { transferReason: 'Se fue a Delfines' };
    expect((await register(t, p, { teamId: d, ...reason }).expect(409)).body.error).toBe('TRANSFERS_LOCKED_KNOCKOUT');
    await register(t, p, { teamId: d, ...reason, knockoutReason: 'Autorizado por la junta' }).expect(200);
  });

  it('equipo: A lo da de baja y B no puede inscribirlo por su cuenta (solo el organizador)', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const team = await teamOfTM(t);
    const p = await player(t, a, 'Pablo');
    await drop(t, p).expect(204);
    await as(TM).post(`/api/teams/${team}/global-roster`).send({ playerId: p }).expect(201);
    expect((await as(TM).put(`/api/teams/${team}/tournaments/${t}/players/${p}`).send({}).expect(409)).body.error).toBe('TRANSFER_REQUIRES_ORGANIZER');
    // Un jugador nuevo del equipo sí se inscribe normalmente, y su baja/reincorporación al mismo equipo también.
    const fresh = (await as(TM).post(`/api/teams/${team}/global-roster/players`).send({ firstName: 'Nuevo', lastName: `R${++seq}`, position: 'FORWARD', requestId: randomUUID(), confirmNew: true }).expect(201)).body.player.id;
    await as(TM).put(`/api/teams/${team}/tournaments/${t}/players/${fresh}`).send({}).expect(200);
    await as(TM).delete(`/api/teams/${team}/tournaments/${t}/players/${fresh}`).send({ reason: 'Se lesionó' }).expect(204);
    await as(TM).put(`/api/teams/${team}/tournaments/${t}/players/${fresh}`).send({}).expect(200);
  });
});

describe('D1 — inscripción por enlace', () => {
  it('quien ya jugó con otro equipo del torneo (PREVIOUS_TEAM) o está bloqueado (BLOCKED) no entra con la solicitud', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const [p, b] = [await player(t, a, 'Pablo'), await player(t, a, 'Bruno')];
    await drop(t, p).expect(204);
    await drop(t, b).expect(204);
    await block(t, b).expect(200);
    await as(O).patch(`/api/tournaments/${t}/registration`).send({ enabled: true }).expect(200);
    const token = (await as(O).post(`/api/tournaments/${t}/registration-link`).expect(200)).body.link.token as string;
    const team = (await as(TM).post('/api/me/teams').send({ name: `Club Enlace ${++seq}` }).expect(201)).body.id as string;
    for (const id of [p, b]) await as(TM).post(`/api/teams/${team}/global-roster`).send({ playerId: id }).expect(201);
    const res = await as(TM).post(`/api/tournament-registration/${token}/requests`).send({ teamId: team, playerIds: [p, b] }).expect(409);
    const codes = Object.fromEntries((res.body.problems as { code: string; playerIds?: string[] }[]).map((x) => [x.code, x.playerIds]));
    expect(codes).toMatchObject({ PREVIOUS_TEAM: [p, b], BLOCKED: [b] });
  });
});

describe('D2–D4 — bloqueo administrativo', () => {
  it('permisos, motivo y fechas: COO no bloquea; motivo obligatorio; sin fechas futuras; uno vigente a la vez', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const p = await player(t, a, 'Pablo');
    await join(t, COO, 'COORDINATOR');
    await join(t, ADM, 'ADMIN');
    await block(t, p, { reason: 'Falta la ficha' }, COO).expect(403);
    await block(t, p, {}).expect(400);
    await block(t, p, { reason: 'Falta la ficha', since: '2099-01-01' }).expect(400);
    await block(t, p, { reason: 'Falta la ficha médica', since: yesterday() }, ADM).expect(200); // retroactivo: ADMIN tiene la excepción
    expect((await block(t, p).expect(409)).body.error).toBe('PLAYER_ALREADY_BLOCKED');
    await unblock(t, p, { reason: 'Entregó', until: '2020-01-01' }).expect(400); // antes de su inicio
    await unblock(t, p, { reason: 'x' }).expect(400);
    await unblock(t, p, undefined, COO).expect(403);
    await unblock(t, p).expect(200);
    await unblock(t, p).expect(404);
    // El nuevo periodo no puede empezar antes del levantamiento del anterior.
    await block(t, p, { reason: 'Otra vez', since: yesterday() }).expect(400);

    const full = (await as(O).get(`/api/tournaments/${t}/player-blocks`).expect(200)).body;
    expect(full[0]).toMatchObject({ playerId: p, active: false, reason: 'Falta la ficha médica', liftReason: 'Entregó la ficha médica', blockedRole: 'ADMIN', liftedRole: 'OWNER', since: yesterday(), until: todayISODate() });
    const limited = (await as(COO).get(`/api/tournaments/${t}/player-blocks`).expect(200)).body;
    expect(limited[0]).not.toHaveProperty('reason');
    expect(limited[0]).not.toHaveProperty('blockedBy');
  });

  it('vigente: impide altas, transferencias, ficha y estadísticas desde su fecha; lo anterior y lo ya registrado no cambian', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const [p, v] = [await player(t, a, 'Pablo'), await player(t, b, 'Visita')];
    const past = await match(t, 1, a, b, '2026-03-01');
    const regd = await match(t, 2, a, b, '2026-03-08');
    await result(regd, [row(p, a), row(v, b)]).expect(200); // ya registrado antes del bloqueo
    const next = await match(t, 3, a, b, '2027-03-15');
    await block(t, p, { reason: 'Falta la ficha médica', since: '2026-03-05' }).expect(200);

    expect((await register(t, p, { teamId: b, fromTeamId: a, transferReason: 'Cambio' }).expect(409)).body.error).toBe('PLAYER_BLOCKED');
    const capture = await result(next, [row(p, a), row(v, b)]).expect(409);
    expect(capture.body).toMatchObject({ error: 'PLAYER_BLOCKED', playerIds: [p] });
    expect((await as(O).put(`/api/matches/${next}/sheet/teams/${a}`).send({ players: [{ playerId: p, starter: true }], substitutions: [] }).expect(409)).body.error).toBe('PLAYER_BLOCKED');
    // Partido anterior al bloqueo: se captura; el ya registrado se corrige sin revalidar.
    await result(past, [row(p, a), row(v, b)]).expect(200);
    await result(regd, [row(p, a), row(v, b)], 1, 0).expect(200);
    // Reprogramar un partido registrado hacia el periodo bloqueado → 409 (3B, causa nueva).
    const moved = await as(O).patch(`/api/matches/${past}`).send({ date: '2026-03-06', reason: 'Se jugó otro día' }).expect(409);
    expect(moved.body).toMatchObject({ error: 'RESCHEDULE_AFFECTS_ELIGIBILITY', players: [expect.objectContaining({ playerId: p, cause: 'BLOCKED' })] });

    await unblock(t, p).expect(200); // vigente desde hoy: el partido de 2027 ya se puede capturar
    await result(next, [row(p, a), row(v, b)]).expect(200);
    // No es una sanción: Disciplina no lo registra.
    expect(await db().collection('sanctions').countDocuments({ tournamentId: oid(t) })).toBe(0);
  });

  it('el equipo ve el estado de bloqueo de sus jugadores, sin motivo; el público no ve nada', async () => {
    const { t } = await tournament([]);
    const team = await teamOfTM(t);
    const p = (await as(TM).post(`/api/teams/${team}/global-roster/players`).send({ firstName: 'Bloq', lastName: `R${++seq}`, position: 'FORWARD', requestId: randomUUID(), confirmNew: true }).expect(201)).body.player.id;
    await as(TM).put(`/api/teams/${team}/tournaments/${t}/players/${p}`).send({}).expect(200);
    await block(t, p).expect(200);
    const view = (await as(TM).get(`/api/teams/${team}/tournaments`).expect(200)).body.tournaments.find((x: { tournament: { id: string } }) => x.tournament.id === t);
    expect(view.players[0]).toMatchObject({ blocked: true });
    expect(JSON.stringify(view)).not.toMatch(/ficha médica/);
    await as(TM).get(`/api/tournaments/${t}/player-blocks`).expect(403);
    const pub = await authed(http, '').get(`/api/tournaments/${t}/players`).expect(200);
    expect(JSON.stringify(pub.body)).not.toMatch(/blocked|ficha médica/);
    // Una baja y reincorporación desde el equipo tampoco lo evade.
    await as(TM).delete(`/api/teams/${team}/tournaments/${t}/players/${p}`).send({ reason: 'Baja' }).expect(204);
    expect((await as(TM).put(`/api/teams/${team}/tournaments/${t}/players/${p}`).send({}).expect(409)).body.error).toBe('PLAYER_BLOCKED');
  });
});

describe('D5–D7 — equipo retirado', () => {
  it('validaciones: sin partidos se quita (no se retira); permisos; motivo; en vivo → 409', async () => {
    const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
    expect((await withdraw(t, c).expect(409)).body.error).toBe('TEAM_HAS_NO_MATCHES');
    const m = await match(t, 1, a, b);
    await as(O).delete(`/api/tournaments/${t}/teams/${a}`).expect(409); // con partidos sigue sin poder quitarse
    await join(t, COO, 'COORDINATOR');
    await withdraw(t, a, undefined, COO).expect(403);
    await withdraw(t, a, { reason: 'x' }).expect(400);
    await as(O).patch(`/api/matches/${m}`).send({ status: 'LIVE' }).expect(200);
    expect((await withdraw(t, a).expect(409)).body.error).toBe('WITHDRAW_LIVE_MATCH');
  });

  it('conserva resultados y tabla; cancela pendientes con motivo; cierra participaciones; no recibe jugadores ni partidos', async () => {
    const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
    const [p, q, v] = [await player(t, a, 'Pablo'), await player(t, a, 'Quique'), await player(t, b, 'Visita')];
    const played = await match(t, 1, a, b, '2026-03-01');
    await result(played, [row(p, a), row(v, b)], 2, 0).expect(200);
    const pending = await match(t, 2, a, c, '2027-03-08');
    const postponed = await match(t, 3, c, a, '2027-03-15');
    await as(O).patch(`/api/matches/${postponed}`).send({ status: 'POSTPONED', reason: 'Lluvia' }).expect(200);
    const others = await match(t, 4, b, c, '2027-03-22');

    const teams = (await withdraw(t, a).expect(200)).body as { teamId: string; withdrawnAt: string | null }[];
    expect(teams.find((x) => x.teamId === a)!.withdrawnAt).toBe(todayISODate());
    expect(JSON.stringify(teams)).not.toMatch(/Abandonó/); // el motivo no es público
    expect((await withdraw(t, a).expect(409)).body.error).toBe('TEAM_ALREADY_WITHDRAWN');

    expect((await matchDoc(played))!.status).toBe('FINISHED');
    expect((await matchDoc(pending))!.status).toBe('CANCELLED');
    expect((await matchDoc(postponed))!).toMatchObject({ status: 'CANCELLED', homeScore: null, awayScore: null });
    expect((await matchDoc(others))!.status).toBe('SCHEDULED');
    const log = (await as(O).get(`/api/matches/${pending}/log`).expect(200)).body.entries as { reason: string | null }[];
    expect(log.at(-1)!.reason).toBe('Equipo retirado del torneo: Abandonó el torneo');
    expect(await db().collection('player_match_stats').countDocuments({ matchId: oid(played) })).toBe(2);

    const standings = (await authed(http, '').get(`/api/tournaments/${t}/standings`).expect(200)).body as { teamId: string; points: number; withdrawn: boolean }[];
    expect(standings.find((r) => r.teamId === a)).toMatchObject({ points: 3, withdrawn: true });
    expect(standings.find((r) => r.teamId === b)).toMatchObject({ withdrawn: false });

    const docs = await memberships(t, p);
    expect(docs[0]).toMatchObject({ active: false, endDate: todayISODate() });
    expect(docs[0].audit.at(-1)).toMatchObject({ action: 'UNREGISTERED', details: { teamWithdrawn: true } });

    // No recibe jugadores (organizador ni equipo), ni partidos; sus cancelados no se reactivan.
    const n = (await as(O).post('/api/players').send({ firstName: 'Nuevo', lastName: `R${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id;
    expect((await register(t, n, { teamId: a }).expect(409)).body.error).toBe('TEAM_WITHDRAWN');
    expect((await as(O).post('/api/matches').send({ tournamentId: t, round: 9, homeTeamId: a, awayTeamId: b, date: '2027-05-01', time: '18:00' }).expect(409)).body.error).toBe('TEAM_WITHDRAWN');
    expect((await as(O).patch(`/api/matches/${pending}`).send({ status: 'SCHEDULED', reason: 'Volver a programar' }).expect(409)).body.error).toBe('TEAM_WITHDRAWN');
    // Sus jugadores quedan libres: moverlos es un cambio de equipo con las reglas de 3C.
    expect((await register(t, q, { teamId: c }).expect(409)).body.error).toBe('TRANSFER_REASON_REQUIRED');
    await register(t, q, { teamId: c, transferReason: 'Su equipo se retiró' }).expect(200);
    // Corregir un resultado histórico del retirado sigue permitido.
    await result(played, [row(p, a), row(v, b)], 3, 0).expect(200);
  });

  it('desde el equipo retirado: no inscribe jugadores', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const team = await teamOfTM(t);
    const p = (await as(TM).post(`/api/teams/${team}/global-roster/players`).send({ firstName: 'Club', lastName: `R${++seq}`, position: 'FORWARD', requestId: randomUUID(), confirmNew: true }).expect(201)).body.player.id;
    await match(t, 1, team, a);
    await withdraw(t, team).expect(200);
    expect((await as(TM).put(`/api/teams/${team}/tournaments/${t}/players/${p}`).send({}).expect(409)).body.error).toBe('TEAM_WITHDRAWN');
    const view = (await as(TM).get(`/api/teams/${team}/tournaments`).expect(200)).body.tournaments[0];
    expect(view).toMatchObject({ withdrawnAt: todayISODate(), editable: false });
  });

  it('eliminatoria: vivo en el cuadro → 409; eliminado → se retira', async () => {
    const { t, teams: [a, b, c, d] } = await tournament(['Águilas', 'Búhos', 'Cóndores', 'Delfines'], { system: 'KNOCKOUT' });
    const semis = (await as(O).post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201)).body.matches as { id: string; homeTeamId: string; awayTeamId: string }[];
    const first = semis[0];
    expect((await withdraw(t, first.homeTeamId).expect(409)).body.error).toBe('WITHDRAW_PENDING_KNOCKOUT');
    await result(first.id, [], 1, 0).expect(200); // gana el local; el visitante queda eliminado
    // El ganador espera rival (la final aún no existe): sigue vivo.
    expect((await withdraw(t, first.homeTeamId).expect(409)).body.error).toBe('WITHDRAW_PENDING_KNOCKOUT');
    await withdraw(t, first.awayTeamId).expect(200);
    void [a, b, c, d];
  });

  it('clasificación: el retirado no clasifica (entra el siguiente); tabla intacta; reincorporar tras generar la eliminatoria → 409', async () => {
    const { t, teams } = await tournament(['Uno', 'Dos', 'Tres', 'Cuatro'], { system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 });
    await as(O).post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const all = (await as(O).get(`/api/tournaments/${t}/matches`).expect(200)).body as { id: string; homeTeamId: string; awayTeamId: string; round: number }[];
    const rank = (id: string) => teams.indexOf(id);
    // Primera jornada: gana el de mejor "rango" (Uno > Dos > …). Uno queda líder y se retira.
    const firstRound = Math.min(...all.map((m) => m.round));
    for (const m of all.filter((x) => x.round === firstRound)) await result(m.id, [], rank(m.homeTeamId) < rank(m.awayTeamId) ? 1 : 0, rank(m.homeTeamId) < rank(m.awayTeamId) ? 0 : 1).expect(200);
    await withdraw(t, teams[0]).expect(200);
    for (const m of (await as(O).get(`/api/tournaments/${t}/matches`).expect(200)).body as { id: string; homeTeamId: string; awayTeamId: string; status: string }[]) {
      if (m.status !== 'SCHEDULED') continue;
      await result(m.id, [], rank(m.homeTeamId) < rank(m.awayTeamId) ? 1 : 0, rank(m.homeTeamId) < rank(m.awayTeamId) ? 0 : 1).expect(200);
    }
    const s = (await authed(http, '').get(`/api/tournaments/${t}/structure`).expect(200)).body;
    expect(s.withdrawnTeamIds).toEqual([teams[0]]);
    expect(s.phases[0].complete).toBe(true); // los cancelados no traban la fase
    expect(s.phases[0].table.some((r: { teamId: string }) => r.teamId === teams[0])).toBe(true);
    expect(s.phases[0].qualification.teamIds).toEqual([teams[1], teams[2]]);
    expect(s.next).toMatchObject({ ready: true });
    await as(O).post(`/api/tournaments/${t}/phases/advance`).send({ startDate: '2027-06-01' }).expect(200);
    const after = (await authed(http, '').get(`/api/tournaments/${t}/structure`).expect(200)).body;
    expect(after.phases[1].seeds.map((x: { teamId: string }) => x.teamId)).toEqual([teams[1], teams[2]]);
    expect(after.phases[0].qualification.teamIds).toEqual([teams[1], teams[2]]); // la clasificación ya usada no se reescribe
    expect((await reinstate(t, teams[0]).expect(409)).body.error).toBe('REINSTATE_PHASE_ADVANCED');
  });

  it('reincorporar: con motivo; no restaura partidos ni participaciones; luego el organizador reprograma', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo');
    const pending = await match(t, 1, a, b, '2027-03-08');
    await withdraw(t, a).expect(200);
    await reinstate(t, b).expect(409); // no estaba retirado
    await reinstate(t, a, { reason: 'x' }).expect(400);
    const teams = (await reinstate(t, a).expect(200)).body as { teamId: string; withdrawnAt: string | null }[];
    expect(teams.find((x) => x.teamId === a)!.withdrawnAt).toBeNull();
    expect((await matchDoc(pending))!.status).toBe('CANCELLED');
    expect((await memberships(t, p)).every((d) => !d.active)).toBe(true);
    await as(O).patch(`/api/matches/${pending}`).send({ status: 'SCHEDULED', reason: 'Volvió el equipo' }).expect(200);
    await register(t, p, { teamId: a }).expect(200); // vuelve a su mismo equipo: alta normal
    const enrollment = await db().collection('tournament_teams').findOne({ tournamentId: oid(t), teamId: oid(a) });
    expect(enrollment!.audit.map((e: { action: string; reason: string }) => [e.action, e.reason])).toEqual([
      ['WITHDRAWN', 'Abandonó el torneo'],
      ['REINSTATED', 'Volvió a presentarse'],
    ]);
  });

  it('inscripciones anteriores a 3D (sin los campos nuevos) se leen como activas', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    await db().collection('tournament_teams').updateMany({ tournamentId: oid(t) }, { $unset: { withdrawnAt: '', audit: '' } });
    const list = (await authed(http, '').get(`/api/tournaments/${t}/teams`).expect(200)).body as { withdrawnAt: string | null }[];
    expect(list.map((x) => x.withdrawnAt)).toEqual([null, null]);
    await match(t, 1, a, b);
    await player(t, a, 'Pablo');
    await withdraw(t, a).expect(200);
  });
});

describe('concurrencia (carreras reales)', () => {
  it('retirar mientras se inscribe un jugador en ese equipo → nunca queda una participación activa en el retirado', async () => {
    for (let run = 0; run < 6; run++) {
      const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
      await match(t, 1, a, b);
      const n = (await as(O).post('/api/players').send({ firstName: 'Carrera', lastName: `R${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id;
      const [w, r] = await Promise.all([withdraw(t, a), register(t, n, { teamId: a })]);
      expect(w.status).toBe(200);
      expect([200, 409]).toContain(r.status);
      expect(await db().collection('team_memberships').countDocuments({ tournamentId: oid(t), teamId: oid(a), active: true })).toBe(0);
    }
  });

  it('retirar mientras se programa un partido suyo → nunca queda un partido vigente del retirado', async () => {
    for (let run = 0; run < 6; run++) {
      const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
      await match(t, 1, a, b);
      const [w, m] = await Promise.all([
        withdraw(t, a),
        as(O).post('/api/matches').send({ tournamentId: t, round: 2, homeTeamId: a, awayTeamId: c, date: '2027-04-01', time: '18:00' }),
      ]);
      expect(w.status).toBe(200);
      expect([201, 409]).toContain(m.status);
      expect(await db().collection('matches').countDocuments({ tournamentId: oid(t), status: { $ne: 'CANCELLED' }, $or: [{ homeTeamId: oid(a) }, { awayTeamId: oid(a) }] })).toBe(0);
    }
  });

  it('dos retiros simultáneos → uno pasa y el otro 409; dos bloqueos simultáneos → uno vigente', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    await match(t, 1, a, b);
    const p = await player(t, b, 'Pablo');
    const ws = await Promise.all([withdraw(t, a), withdraw(t, a)]);
    expect(ws.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await db().collection('tournament_teams').findOne({ tournamentId: oid(t), teamId: oid(a) }))!.audit).toHaveLength(1);
    const bs = await Promise.all([block(t, p), block(t, p)]);
    expect(bs.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await db().collection('player_blocks').countDocuments({ tournamentId: oid(t), playerId: oid(p), until: null })).toBe(1);
  });
});
