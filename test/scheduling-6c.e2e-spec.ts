/**
 * 6C (2026-10-23) — reprogramación parcial contra la API real (`docs/scheduling-6c.md`): propuesta
 * sin escrituras, cambios mínimos, partidos ajenos intactos, excluidos (jugados), por programar con
 * confirmación explícita, versiones, saltarse reglas por API, motivo, eliminatoria (orden de rondas),
 * intercambio de canchas, árbitros, RBAC, finalizados y concurrencia.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { addDays } from '../src/modules/venues/occupancy.js';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let db: Connection;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, C: U, S: U, X: U;
const as = (u: U = O) => authed(http, u.token);

// 2027-05-01 es sábado; 02 domingo.
const SAT = '2027-05-01';
const SUN = '2027-05-02';

type Item = { matchId: string; version: string; action: 'KEEP' | 'MOVE' | 'PENDING'; before: { date: string; time: string; fieldId: string | null }; after: { date: string; time: string; fieldId: string | null } | null; reasons: { code: string }[] };
type M = { id: string; round: number; date: string; time: string; status: string; fieldId: string | null; venue: string | null; homeTeamId: string; awayTeamId: string; pendingSchedule?: boolean; postponedFrom?: { date: string } | null; updatedAt: string; stage: { tie: { round: number } | null } | null };

let seq = 0;
async function tournament(owner: U = O, n = 4, extra: Record<string, unknown> = {}) {
  const t = (await as(owner).post('/api/tournaments').send({ name: `Repro 6C ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', ...extra }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = (await as(owner).post('/api/teams').send({ name: `Equipo 6C ${seq}-${String.fromCharCode(65 + i)}` }).expect(201)).body.id as string;
    await as(owner).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
async function addMember(t: string, u: U, role: string) {
  const inv = await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201);
  await as(u).post(`/api/invitations/${inv.body.token}/accept`).expect(200);
}
const venue = async (name: string, fields: string[], bufferMinutes = 0) => (await as().post('/api/venues').send({ name, bufferMinutes, fields: fields.map((f) => ({ name: f })) }).expect(201)).body as { id: string; fields: { id: string }[] };
const matchesOf = async (t: string) => (await as().get(`/api/tournaments/${t}/matches`).expect(200)).body as M[];
const snapshot = async (t: string) => (await matchesOf(t)).map((m) => `${m.id}|${m.date}|${m.time}|${m.fieldId}|${m.status}|${m.updatedAt}`).sort();
const propose = (t: string, selection: Record<string, unknown>, search: Record<string, unknown> = {}, u: U = O) => as(u).post(`/api/tournaments/${t}/reschedule/proposal`).send({ selection, search });
const confirmItems = (items: Item[]) =>
  items.map((i) => ({ matchId: i.matchId, version: i.version, action: i.action, ...(i.after ? { date: i.after.date, time: i.after.time, fieldId: i.after.fieldId } : {}) }));
const confirm = (t: string, items: Item[], extra: Record<string, unknown> = {}, u: U = O) => as(u).post(`/api/tournaments/${t}/reschedule`).send({ reason: 'Sede cerrada', items: confirmItems(items), ...extra });

/** Liga de 4 con jornadas los sábados en dos canchas (F1 18:00, F2 18:00). */
async function league(owner: U = O) {
  const v = await venue(`Unidad 6C ${seq + 1}`, ['1', '2']);
  const [F1, F2] = v.fields.map((f) => f.id);
  const k = await tournament(owner);
  const body = { startDate: SAT, firstKickoff: '18:00', minutesBetweenMatches: 90, fieldIds: [F1, F2], lastKickoff: '19:30' };
  const p = (await as(owner).post(`/api/tournaments/${k.t}/schedule/proposal`).send(body).expect(200)).body;
  await as(owner)
    .post(`/api/tournaments/${k.t}/schedule`)
    .send({ ...body, assignments: p.matches.map(({ round, homeTeamId, awayTeamId, date, time, fieldId }: M & { fieldId: string }) => ({ round, homeTeamId, awayTeamId, date, time, fieldId })) })
    .expect(201);
  return { ...k, F1, F2, venueId: v.id };
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  db = ctx.app.get<Connection>(getConnectionToken());
  [O, C, S, X] = [await registerOrganizer(http, 'Dueño'), await registerOrganizer(http, 'Coordinador'), await registerOrganizer(http, 'Anotador'), await registerOrganizer(http, 'Ajeno')];
});
afterAll(async () => ctx?.close());

describe('6C — propuesta y cambios mínimos', () => {
  it('una cancha cerrada: solo se mueven sus partidos (a la otra cancha, mismo horario); nada se escribe hasta confirmar', async () => {
    const { t, F1, F2 } = await league();
    const before = await snapshot(t);
    const res = await propose(t, { fieldId: F1, from: SAT, to: SAT }, { from: SAT, to: addDays(SAT, 14), avoidFieldIds: [F1], fieldIds: [F1, F2] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body;
    expect(await snapshot(t)).toEqual(before);
    expect(p.summary).toMatchObject({ selected: 1, move: 1, keep: 0, pending: 0 });
    const [item] = p.items as Item[];
    expect(item.after).toMatchObject({ date: SAT, fieldId: F2 });
    expect(item.after!.time).not.toBe('18:00'); // F2 a las 18:00 ya está ocupada por el otro partido de la jornada
    const saved = await confirm(t, p.items);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body).toMatchObject({ moved: 1, kept: 0, pending: 0 });
    const after = await matchesOf(t);
    const moved = after.find((m) => m.id === item.matchId)!;
    expect(moved).toMatchObject({ date: SAT, fieldId: F2, time: item.after!.time });
    // Los no elegidos, intactos (misma versión).
    const untouched = (s: string[]) => s.filter((x) => !x.startsWith(item.matchId));
    expect(untouched(await snapshot(t))).toEqual(untouched(before));
    const log = (await as().get(`/api/matches/${item.matchId}/log`).expect(200)).body;
    expect((log.entries ?? log).some((e: { action: string; reason: string }) => e.reason === 'Sede cerrada')).toBe(true);
  });

  it('una jornada con una regla nueva: se mueve solo el partido que dejó de ser válido', async () => {
    const { t, teams } = await league();
    await as().put(`/api/tournaments/${t}/scheduling`).send({ days: [0, 6] }).expect(200);
    await as().put(`/api/tournaments/${t}/scheduling/teams/${teams[0]}`).send({ unavailableDates: [SAT] }).expect(200);
    const p = (await propose(t, { round: 1 }, { from: SAT, to: addDays(SAT, 13) }).expect(200)).body;
    expect(p.summary).toMatchObject({ selected: 2, move: 1, keep: 1 });
    const move = (p.items as Item[]).find((i) => i.action === 'MOVE')!;
    expect(move.after!.date).toBe(SUN); // el día permitido más cercano
    expect(move.after!.fieldId).toBe(move.before.fieldId); // conserva la cancha
    await confirm(t, p.items).expect(201);
  });

  it('los jugados quedan fuera con su motivo y no se pueden colar en la confirmación', async () => {
    const { t } = await league();
    const ms = await matchesOf(t);
    const played = ms.find((m) => m.round === 1)!;
    await as().put(`/api/matches/${played.id}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [] }).expect(200);
    const p = (await propose(t, { round: 1 }, { from: SAT }).expect(200)).body;
    expect(p.excluded).toEqual([expect.objectContaining({ matchId: played.id, reason: 'Ya tiene resultado' })]);
    const fresh = (await matchesOf(t)).find((m) => m.id === played.id)!;
    const r = await as().post(`/api/tournaments/${t}/reschedule`).send({ reason: 'x', items: [{ matchId: played.id, version: fresh.updatedAt, action: 'MOVE', date: SUN, time: '10:00' }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('MATCH_NOT_RESCHEDULABLE');
    await propose(t, {}).expect(400);
  });
});

describe('6C — por programar', () => {
  it('sin horario: no se inventa; guardarlo exige confirmar cuántos quedan; queda pospuesto (tenía horario)', async () => {
    const { t, teams } = await league();
    await as().put(`/api/tournaments/${t}/scheduling/teams/${teams[0]}`).send({ unavailableDates: Array.from({ length: 15 }, (_, i) => addDays(SAT, i)) }).expect(200);
    const p = (await propose(t, { round: 1 }, { from: SAT, to: addDays(SAT, 14), keepValid: true }).expect(200)).body;
    const pending = (p.items as Item[]).find((i) => i.action === 'PENDING')!;
    expect(pending.after).toBeNull();
    expect(pending.reasons[0].code).toBe('TEAM_DATE');
    expect((await confirm(t, p.items)).body.error).toBe('PENDING_NOT_CONFIRMED');
    const ok = await confirm(t, p.items, { allowPending: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const m = (await matchesOf(t)).find((x) => x.id === pending.matchId)!;
    expect(m).toMatchObject({ status: 'POSTPONED', pendingSchedule: false, postponedFrom: expect.objectContaining({ date: SAT }) });
  });

  it('los por programar de un calendario parcial se programan después con la misma herramienta', async () => {
    const { t, teams } = await tournament();
    await as().put(`/api/tournaments/${t}/scheduling/teams/${teams[0]}`).send({ unavailableDates: Array.from({ length: 21 }, (_, i) => addDays(SAT, i)) }).expect(200);
    const body = { startDate: SAT, endDate: addDays(SAT, 20) };
    const prop = (await as().post(`/api/tournaments/${t}/schedule/proposal`).send(body).expect(200)).body;
    expect(prop.unscheduled).toHaveLength(3);
    await as()
      .post(`/api/tournaments/${t}/schedule`)
      .send({ ...body, allowPending: 3, assignments: prop.matches.map(({ round, homeTeamId, awayTeamId, date, time, fieldId }: M) => ({ round, homeTeamId, awayTeamId, date, time, fieldId })) })
      .expect(201);
    const p = (await propose(t, { pending: true }, { from: addDays(SAT, 21), to: addDays(SAT, 60) }).expect(200)).body;
    expect(p.summary).toMatchObject({ selected: 3, move: 3, pending: 0 });
    expect((p.items as Item[]).every((i) => i.before && i.after!.date >= addDays(SAT, 21))).toBe(true);
    await confirm(t, p.items).expect(201);
    const ms = await matchesOf(t);
    expect(ms.filter((m) => m.status === 'SCHEDULED')).toHaveLength(6);
    expect(ms.some((m) => m.pendingSchedule)).toBe(false);
  });
});

describe('6C — confirmación segura', () => {
  it('versiones: un partido que cambió después de la propuesta invalida la confirmación (todo o nada)', async () => {
    const { t, F1 } = await league();
    const p = (await propose(t, { round: 1 }, { from: SAT, keepValid: false }).expect(200)).body;
    const [first] = p.items as Item[];
    await as().patch(`/api/matches/${first.matchId}`).send({ time: '21:00', reason: 'Otro cambio' }).expect(200);
    const before = await snapshot(t);
    const r = await confirm(t, p.items);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('PROPOSAL_STALE');
    expect(await snapshot(t)).toEqual(before);
    expect(F1).toBeTruthy();
  });

  it('saltarse las reglas por API: un horario manipulado no se guarda y nada cambia', async () => {
    const { t } = await league();
    await as().put(`/api/tournaments/${t}/scheduling`).send({ days: [6] }).expect(200);
    const p = (await propose(t, { round: 2 }, { from: SAT, keepValid: false }).expect(200)).body;
    const before = await snapshot(t);
    const tampered = (p.items as Item[]).map((i, k) => (k === 0 ? { ...i, after: { ...i.after!, date: addDays(i.after!.date, 1) } } : i));
    const r = await confirm(t, tampered);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('SCHEDULE_CONSTRAINTS');
    expect(await snapshot(t)).toEqual(before);
  });

  it('motivo obligatorio con el torneo en curso', async () => {
    const { t } = await league();
    const p = (await propose(t, { round: 1 }, { from: SAT, keepValid: false }).expect(200)).body;
    await as().post(`/api/tournaments/${t}/reschedule`).send({ items: confirmItems(p.items) }).expect(400);
  });

  it('intercambio de horario entre dos partidos de la misma cancha (escritura en dos pasos)', async () => {
    const v = await venue('Swap 6C', ['Única']);
    const F = v.fields[0].id;
    const { t, teams } = await tournament();
    const mk = async (h: number, a: number, time: string) => (await as().post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: teams[h], awayTeamId: teams[a], date: SAT, time, fieldId: F }).expect(201)).body as M;
    const m1 = await mk(0, 1, '18:00');
    const m2 = await mk(2, 3, '19:30');
    const r = await as().post(`/api/tournaments/${t}/reschedule`).send({
      reason: 'Intercambio',
      items: [
        { matchId: m1.id, version: m1.updatedAt, action: 'MOVE', date: SAT, time: '19:30', fieldId: F },
        { matchId: m2.id, version: m2.updatedAt, action: 'MOVE', date: SAT, time: '18:00', fieldId: F },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ms = await matchesOf(t);
    expect(ms.find((m) => m.id === m1.id)!.time).toBe('19:30');
    expect(ms.find((m) => m.id === m2.id)!.time).toBe('18:00');
  });

  it('árbitros: si el árbitro está ocupado en el nuevo horario, no se guarda nada', async () => {
    const { t, teams } = await tournament();
    const ref = (await as().post('/api/referees').send({ firstName: 'Juez', lastName: `6C${seq}` }).expect(201)).body;
    const a = (await as().post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: teams[0], awayTeamId: teams[1], date: SAT, time: '10:00' }).expect(201)).body as M;
    const b = (await as().post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: teams[2], awayTeamId: teams[3], date: SAT, time: '18:00' }).expect(201)).body as M;
    await as().post(`/api/matches/${a.id}/referees`).send({ refereeId: ref.id, role: 'CENTRAL' }).expect(201);
    await as().post(`/api/matches/${b.id}/referees`).send({ refereeId: ref.id, role: 'CENTRAL' }).expect(201);
    const fresh = (await matchesOf(t)).find((m) => m.id === a.id)!;
    const before = await snapshot(t);
    const r = await as().post(`/api/tournaments/${t}/reschedule`).send({ reason: 'x', items: [{ matchId: a.id, version: fresh.updatedAt, action: 'MOVE', date: SAT, time: '18:30' }] });
    expect(r.status).toBe(409);
    expect(await snapshot(t)).toEqual(before);
  });
});

describe('6C — eliminatoria', () => {
  async function knockout() {
    const k = await tournament(O, 4, { settings: { system: 'KNOCKOUT' } });
    await as().post(`/api/tournaments/${k.t}/schedule`).send({ startDate: SAT, firstKickoff: '18:00', seeding: k.teams }).expect(201);
    return k;
  }

  it('la final no puede ir antes que las semifinales (ni en la propuesta ni forzándolo)', async () => {
    const { t } = await knockout();
    for (const m of await matchesOf(t)) await as().put(`/api/matches/${m.id}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [] }).expect(200);
    const final = (await matchesOf(t)).find((m) => m.stage?.tie?.round === 1)!;
    const p = (await propose(t, { matchIds: [final.id] }, { from: '2027-04-24', to: addDays(SAT, 20), keepValid: false }).expect(200)).body;
    const item = (p.items as Item[])[0];
    expect(item.after!.date > SAT || (item.after!.date === SAT && item.after!.time >= '19:00')).toBe(true);
    const r = await as().post(`/api/tournaments/${t}/reschedule`).send({ reason: 'x', items: [{ matchId: final.id, version: item.version, action: 'MOVE', date: '2027-04-24', time: '18:00' }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('BRACKET_ORDER');
  });

  it('una final por programar (sin horario válido al avanzar) se programa después; la captura nunca se bloqueó', async () => {
    const { t, teams } = await knockout();
    for (const team of teams) await as().put(`/api/tournaments/${t}/scheduling/teams/${team}`).send({ unavailableDates: Array.from({ length: 21 }, (_, i) => addDays(SAT, 1 + i)) }).expect(200);
    for (const m of await matchesOf(t)) await as().put(`/api/matches/${m.id}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [] }).expect(200);
    const final = (await matchesOf(t)).find((m) => m.stage?.tie?.round === 1)!;
    expect(final).toMatchObject({ status: 'POSTPONED', pendingSchedule: true });
    // Por programar tampoco puede ir antes de las semifinales (regresión: no reservaba y quedaba fuera de la comprobación).
    const early = await as().post(`/api/tournaments/${t}/reschedule`).send({ reason: 'x', items: [{ matchId: final.id, version: final.updatedAt, action: 'MOVE', date: addDays(SAT, -7), time: '18:00' }] });
    expect(early.body.error).toBe('BRACKET_ORDER');
    const p = (await propose(t, { pending: true }, { from: addDays(SAT, 22), to: addDays(SAT, 40) }).expect(200)).body;
    expect(p.summary).toMatchObject({ selected: 1, move: 1 });
    await confirm(t, p.items).expect(201);
    expect((await matchesOf(t)).find((m) => m.id === final.id)).toMatchObject({ status: 'SCHEDULED', pendingSchedule: false });
  });
});

describe('6C — permisos, finalizados y concurrencia', () => {
  it('RBAC: coordinador sí; anotador y ajenos no; torneo finalizado 409', async () => {
    const { t } = await league();
    await addMember(t, C, 'COORDINATOR');
    await addMember(t, S, 'SCORER');
    for (const [u, s] of [[C, 200], [S, 403], [X, 403]] as const) expect({ u: u.email, s: (await propose(t, { round: 1 }, { from: SAT }, u)).status }).toEqual({ u: u.email, s });
    const p = (await propose(t, { round: 1 }, { from: SAT, keepValid: false }, C).expect(200)).body;
    await confirm(t, p.items, {}, S).expect(403);
    await confirm(t, p.items, {}, C).expect(201);
    await as().post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    await propose(t, { round: 2 }, { from: SAT }).expect(409);
  });

  it('dos confirmaciones a la vez de la misma propuesta: una entra, la otra ve versiones viejas', async () => {
    const { t } = await league();
    const p = (await propose(t, { round: 1 }, { from: SAT, keepValid: false }).expect(200)).body;
    const results = await Promise.all([confirm(t, p.items), confirm(t, p.items)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('PROPOSAL_STALE');
  });

  it('dos torneos reprograman a la vez a la misma cancha y hora: solo uno la obtiene', async () => {
    const v = await venue('Carrera 6C', ['Única']);
    const F = v.fields[0].id;
    const mk = async () => {
      const k = await tournament(O, 2);
      const m = (await as().post('/api/matches').send({ tournamentId: k.t, round: 1, homeTeamId: k.teams[0], awayTeamId: k.teams[1], date: SAT, time: '10:00' }).expect(201)).body as M;
      return { ...k, m };
    };
    const [a, b] = [await mk(), await mk()];
    const item = (k: { m: M }) => [{ matchId: k.m.id, version: k.m.updatedAt, action: 'MOVE', date: SUN, time: '18:00', fieldId: F }];
    const results = await Promise.all([a, b].map((k) => as().post(`/api/tournaments/${k.t}/reschedule`).send({ reason: 'Carrera', items: item(k) })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('FIELD_CONFLICT');
    const onField = await db.collection('matches').countDocuments({ fieldId: new Types.ObjectId(F), date: SUN });
    expect(onField).toBe(1);
  });
});
