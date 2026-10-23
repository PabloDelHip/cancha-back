/**
 * 6B (2026-10-22) — generación inteligente contra la API real (`docs/scheduling-6b.md`): propuesta
 * sin escrituras, confirmación atómica y revalidada, restricciones obligatorias y preferencias,
 * canchas y conflictos entre torneos, casos sin solución, eliminatorias (vista previa con horarios y
 * partidos automáticos sin horario válido), RBAC, finalizados y concurrencia.
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
let O: U, C: U, S: U, X: U, O2: U;
const as = (u: U = O) => authed(http, u.token);

// 2027-03-05 es viernes; 06 sábado; 07 domingo.
const FRI = '2027-03-05';
const SAT = '2027-03-06';
const SUN = '2027-03-07';

let seq = 0;
async function tournament(owner: U = O, n = 4, extra: Record<string, unknown> = {}) {
  const t = (await as(owner).post('/api/tournaments').send({ name: `Calendario 6B ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', ...extra }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = (await as(owner).post('/api/teams').send({ name: `Equipo 6B ${seq}-${String.fromCharCode(65 + i)}` }).expect(201)).body.id as string;
    await as(owner).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
async function addMember(t: string, u: U, role: string) {
  const inv = await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201);
  await as(u).post(`/api/invitations/${inv.body.token}/accept`).expect(200);
}
const rules = (t: string, body: Record<string, unknown>, u: U = O) => as(u).put(`/api/tournaments/${t}/scheduling`).send(body);
const teamRules = (t: string, team: string, body: Record<string, unknown>) => as().put(`/api/tournaments/${t}/scheduling/teams/${team}`).send(body);
const propose = (t: string, body: Record<string, unknown>, u: U = O) => as(u).post(`/api/tournaments/${t}/schedule/proposal`).send(body);
const confirm = (t: string, body: Record<string, unknown>, proposal: { matches: Assigned[] }, u: U = O) =>
  as(u)
    .post(`/api/tournaments/${t}/schedule`)
    .send({ ...body, assignments: proposal.matches.map(({ round, homeTeamId, awayTeamId, date, time, fieldId }) => ({ round, homeTeamId, awayTeamId, date, time, fieldId })) });
type Assigned = { round: number; homeTeamId: string; awayTeamId: string; date: string; time: string; fieldId: string | null; warnings: { code: string }[] };
const matchCount = (t: string) => db.collection('matches').countDocuments({ tournamentId: new Types.ObjectId(t) });
const matchesOf = async (t: string) => (await as().get(`/api/tournaments/${t}/matches`).expect(200)).body as { id: string; round: number; date: string; time: string; status: string; fieldId: string | null; venue: string | null; homeTeamId: string; awayTeamId: string; stage: { tie: { round: number } | null } | null }[];
const venue = async (name: string, fields: string[], owner: U = O, bufferMinutes = 15) =>
  (await as(owner).post('/api/venues').send({ name, bufferMinutes, fields: fields.map((f) => ({ name: f })) }).expect(201)).body as { id: string; fields: { id: string }[] };

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  db = ctx.app.get<Connection>(getConnectionToken());
  [O, C, S, X, O2] = [
    await registerOrganizer(http, 'Dueño'),
    await registerOrganizer(http, 'Coordinador'),
    await registerOrganizer(http, 'Anotador'),
    await registerOrganizer(http, 'Ajeno'),
    await registerOrganizer(http, 'Otro dueño'),
  ];
});
afterAll(async () => ctx?.close());

describe('6B — propuesta y confirmación', () => {
  it('sin restricciones: propone el calendario de siempre, no escribe nada y se confirma igual', async () => {
    const { t } = await tournament();
    const body = { startDate: SAT, firstKickoff: '18:00', minutesBetweenMatches: 90 };
    const res = await propose(t, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const p = res.body;
    expect(p.matches).toHaveLength(6);
    expect(p.unscheduled).toEqual([]);
    expect(p.metrics).toMatchObject({ placed: 6, unplaced: 0, lateRounds: 0, withWarnings: 0, truncated: false });
    expect([...new Set((p.matches as Assigned[]).map((m) => m.date))]).toEqual([SAT, addDays(SAT, 7), addDays(SAT, 14)]);
    expect(p.rounds.map((r: { number: number }) => r.number)).toEqual([1, 2, 3]);
    // Vista previa = cero escrituras.
    expect(await matchCount(t)).toBe(0);
    expect(await db.collection('rounds').countDocuments({ tournamentId: new Types.ObjectId(t) })).toBe(0);

    const saved = await confirm(t, body, p);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const ms = await matchesOf(t);
    expect(ms.map((m) => `${m.round} ${m.date} ${m.time}`).sort()).toEqual((p.matches as Assigned[]).map((m) => `${m.round} ${m.date} ${m.time}`).sort());
    // Regresión: el generador de siempre (sin assignments) da exactamente lo mismo.
    const { t: t2 } = await tournament();
    await as().post(`/api/tournaments/${t2}/schedule`).send(body).expect(201);
    expect((await matchesOf(t2)).map((m) => `${m.round} ${m.date} ${m.time}`).sort()).toEqual(ms.map((m) => `${m.round} ${m.date} ${m.time}`).sort());
  });

  it('restricciones obligatorias y preferencias: donde el generador de siempre falla, la propuesta encuentra horario', async () => {
    const { t, teams } = await tournament(O, 6);
    await rules(t, { days: [0, 6], startTime: '08:00', endTime: '22:00' }).expect(200);
    await teamRules(t, teams[0], { unavailableDays: [6] }).expect(200); // A no juega sábados (obligatoria)
    await teamRules(t, teams[1], { unavailableTimes: [{ day: null, from: '08:00', to: '12:00' }], strict: false }).expect(200); // B prefiere tarde
    await teamRules(t, teams[2], { minRestHours: 120 }).expect(200); // C: 5 días de descanso
    const body = { startDate: SAT, firstKickoff: '09:00', minutesBetweenMatches: 90 };
    expect((await as().post(`/api/tournaments/${t}/schedule`).send(body)).body.error).toBe('SCHEDULE_CONSTRAINTS');

    const p = (await propose(t, body).expect(200)).body;
    expect(p.unscheduled).toEqual([]);
    expect(p.matches).toHaveLength(15);
    const ms = p.matches as Assigned[];
    const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
    expect(ms.every((m) => [0, 6].includes(weekday(m.date)))).toBe(true);
    expect(ms.filter((m) => m.homeTeamId === teams[0] || m.awayTeamId === teams[0]).every((m) => weekday(m.date) === 0)).toBe(true);
    // B evita la mañana mientras haya otra opción (sin avisos).
    expect(ms.filter((m) => m.homeTeamId === teams[1] || m.awayTeamId === teams[1]).every((m) => m.time >= '12:00' && !m.warnings.length)).toBe(true);
    const saved = await confirm(t, body, p);
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(await matchCount(t)).toBe(15);
  });

  it('confirmar revalida: un horario manipulado o una propuesta que ya no coincide no se guardan', async () => {
    const { t, teams } = await tournament();
    await rules(t, { days: [6] }).expect(200);
    const body = { startDate: SAT };
    const p = (await propose(t, body).expect(200)).body;
    // Saltarse las restricciones por API: un partido movido a domingo.
    const tampered = { matches: (p.matches as Assigned[]).map((m, i) => (i === 0 ? { ...m, date: SUN } : m)) };
    const r1 = await confirm(t, body, tampered);
    expect(r1.status).toBe(409);
    expect(r1.body.error).toBe('SCHEDULE_CONSTRAINTS');
    // Le falta un partido.
    // 6C: si le falta un partido sin confirmarlo como «por programar», tampoco.
    const r2 = await confirm(t, body, { matches: (p.matches as Assigned[]).slice(1) });
    expect(r2.body.error).toBe('PENDING_NOT_CONFIRMED');
    // Los inscritos cambiaron después de la vista previa.
    const extra = (await as().post('/api/teams').send({ name: `Nuevo 6B ${seq}` }).expect(201)).body.id;
    await as().post(`/api/tournaments/${t}/teams/${extra}`).expect(201);
    const r3 = await confirm(t, body, p);
    expect(r3.body.error).toBe('PROPOSAL_STALE');
    expect(await matchCount(t)).toBe(0);
    expect(teams).toHaveLength(4);
  });

  it('casos sin solución: explica qué lo impide y no se puede guardar incompleta', async () => {
    const { t, teams } = await tournament();
    const blocked = Array.from({ length: 21 }, (_, i) => addDays(SAT, i));
    await teamRules(t, teams[0], { unavailableDates: blocked }).expect(200);
    const body = { startDate: SAT, endDate: addDays(SAT, 20) };
    const p = (await propose(t, body).expect(200)).body;
    expect(p.unscheduled.length).toBe(3);
    expect(p.unscheduled.every((u: { homeTeamId: string; awayTeamId: string }) => [u.homeTeamId, u.awayTeamId].includes(teams[0]))).toBe(true);
    expect(p.unscheduled[0].reasons[0]).toMatchObject({ code: 'TEAM_DATE', teamId: teams[0] });
    expect((await confirm(t, body, p)).body.error).toBe('PENDING_NOT_CONFIRMED');
    // 6C: con la confirmación explícita (cuántos quedan) se guarda; los pendientes no reservan nada.
    const partial = await as().post(`/api/tournaments/${t}/schedule`).send({ ...body, allowPending: 3, assignments: (p.matches as Assigned[]).map(({ round, homeTeamId, awayTeamId, date, time, fieldId }) => ({ round, homeTeamId, awayTeamId, date, time, fieldId })) });
    expect(partial.status, JSON.stringify(partial.body)).toBe(201);
    const saved = await matchesOf(t);
    expect(saved).toHaveLength(6);
    expect(saved.filter((m) => m.status === 'POSTPONED' && (m as { pendingSchedule?: boolean }).pendingSchedule)).toHaveLength(3);
    await as().post(`/api/tournaments/${t}/schedule`).send({ ...body, allowPending: 3, replaceExisting: true, assignments: [] }).expect(409);
    // Ampliar el periodo lo resuelve.
    const wider = (await propose(t, { ...body, endDate: addDays(SAT, 60) }).expect(200)).body;
    expect(wider.unscheduled).toEqual([]);
    // Límites: periodo inválido o demasiado largo.
    await propose(t, { startDate: SAT, endDate: FRI }).expect(400);
    await propose(t, { startDate: SAT, endDate: addDays(SAT, 400) }).expect(400);
  });

  it('preferencias en las reglas generales (softRules): avisan; las de recursos no se aceptan', async () => {
    const { t, teams } = await tournament();
    await rules(t, { days: [6], softRules: ['DAYS'] }).expect(200);
    const created = await as().post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: teams[0], awayTeamId: teams[1], date: SUN, time: '10:00' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await rules(t, { softRules: ['SIMULTANEOUS'] }).expect(400);
    await rules(t, { softRules: ['FIELD_GAP'] }).expect(400);
    const view = (await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body;
    expect(view.rules.softRules).toEqual(['DAYS']);
    expect(view.conflicts.matches[0].warnings[0].code).toBe('DAY_NOT_ALLOWED');
  });
});

describe('6B — canchas y conflictos entre torneos', () => {
  it('reparte en varias canchas, evita lo ocupado por otro torneo y asigna la cancha al confirmar', async () => {
    const v = await venue('Unidad 6B', ['Cancha 1', 'Cancha 2']);
    const [F1, F2] = v.fields.map((f) => f.id);
    const other = await tournament();
    await as().post('/api/matches').send({ tournamentId: other.t, round: 1, homeTeamId: other.teams[0], awayTeamId: other.teams[1], date: SAT, time: '18:00', fieldId: F1 }).expect(201);

    const { t } = await tournament(O, 8);
    const body = { startDate: SAT, endDate: SAT, firstKickoff: '18:00', lastKickoff: '20:30', minutesBetweenMatches: 75, fieldIds: [F1, F2], legs: 1 };
    const p = (await propose(t, body).expect(200)).body;
    const round1 = (p.matches as Assigned[]).filter((m) => m.round === 1);
    expect(round1).toHaveLength(4);
    // F1 a las 18:00 la ocupa el otro torneo (con margen, hasta 19:15).
    expect(round1.some((m) => m.fieldId === F1 && m.time < '19:15')).toBe(false);
    expect(p.unscheduled.length).toBeGreaterThan(0); // el resto de jornadas no cabe en un solo día
    // Solo la jornada 1 en un torneo nuevo de una jornada: confirmar con la cancha.
    const one = await tournament(O, 2);
    const p1 = (await propose(one.t, { startDate: SAT, firstKickoff: '18:00', fieldIds: [F1] }).expect(200)).body;
    expect(p1.matches[0]).toMatchObject({ fieldId: F1, time: '19:30', field: 'Unidad 6B · Cancha 1' });
    await confirm(one.t, { startDate: SAT, firstKickoff: '18:00', fieldIds: [F1] }, p1).expect(201);
    const [m] = await matchesOf(one.t);
    expect(m).toMatchObject({ fieldId: F1, venue: 'Unidad 6B · Cancha 1', time: '19:30' });
  });

  it('la cancha se ocupó mientras se revisaba la propuesta: 409 FIELD_CONFLICT y no se guarda nada', async () => {
    const v = await venue('Sede carrera 6B', ['Única']);
    const F = v.fields[0].id;
    const { t } = await tournament(O, 2);
    const previous = await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: SUN }).expect(201);
    const body = { startDate: SAT, firstKickoff: '18:00', fieldIds: [F], replaceExisting: true };
    const p = (await propose(t, body).expect(200)).body;
    const other = await tournament(O, 2);
    await as().post('/api/matches').send({ tournamentId: other.t, round: 1, homeTeamId: other.teams[0], awayTeamId: other.teams[1], date: SAT, time: '18:30', fieldId: F }).expect(201);
    const r = await confirm(t, body, p);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('FIELD_CONFLICT');
    // Atómico: sigue el calendario anterior, intacto.
    expect((await matchesOf(t)).map((m) => m.id)).toEqual(previous.body.matches.map((m: { id: string }) => m.id));
  });

  it('canchas ajenas o desactivadas no se pueden pedir', async () => {
    const { t } = await tournament();
    const foreign = (await venue('Ajena 6B', ['X'], O2)).fields[0].id;
    await propose(t, { startDate: SAT, fieldIds: [foreign] }).expect(404);
    const v = await venue('Cerrada 6B', ['Y']);
    await as().patch(`/api/venues/${v.id}`).send({ active: false }).expect(200);
    await propose(t, { startDate: SAT, fieldIds: [v.fields[0].id] }).expect(409);
  });
});

describe('6B — eliminatorias', () => {
  async function knockout(n = 4) {
    const k = await tournament(O, n, { settings: { system: 'KNOCKOUT' } });
    await as().post(`/api/tournaments/${k.t}/schedule`).send({ startDate: SAT, firstKickoff: '18:00', seeding: k.teams }).expect(201);
    return k;
  }
  const playRound = async (t: string, round: number) => {
    for (const m of (await matchesOf(t)).filter((x) => x.stage?.tie?.round === round)) {
      const r = await as().put(`/api/matches/${m.id}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
  };

  it('la final automática busca otro horario si el previsto incumple', async () => {
    const { t } = await knockout();
    await rules(t, { days: [0, 6] }).expect(200);
    // El sábado de la final se cierra para todos los inscritos (fecha prevista: SAT + 7).
    const finalDate = addDays(SAT, 7);
    for (const team of (await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body.teams) await teamRules(t, team.teamId, { unavailableDates: [finalDate] }).expect(200);
    await playRound(t, 0);
    const final = (await matchesOf(t)).find((m) => m.stage?.tie?.round === 1)!;
    expect(final).toMatchObject({ status: 'SCHEDULED', date: addDays(SAT, 8), time: '18:00' });
  });

  it('sin horario válido: el avance se conserva y la final queda pendiente de programar (pospuesta, con motivo)', async () => {
    const { t, teams } = await knockout();
    const closed = Array.from({ length: 21 }, (_, i) => addDays(SAT, 1 + i));
    for (const team of teams) await teamRules(t, team, { unavailableDates: closed }).expect(200);
    await playRound(t, 0);
    const final = (await matchesOf(t)).find((m) => m.stage?.tie?.round === 1)!;
    expect(final.status).toBe('POSTPONED');
    expect([final.homeTeamId, final.awayTeamId].sort()).toEqual([teams[0], teams[1]].sort());
    const log = (await as().get(`/api/matches/${final.id}/log`).expect(200)).body;
    const created = (log.entries ?? log).find((e: { action: string }) => e.action === 'CREATED');
    expect(created).toMatchObject({ source: 'SYSTEM', cause: 'BRACKET_SYNC' });
    expect(created.reason).toMatch(/Pendiente de programar/);
    // Al reprogramarlo, valen las restricciones de siempre.
    const bad = await as().patch(`/api/matches/${final.id}`).send({ status: 'SCHEDULED', date: addDays(SAT, 7), time: '18:00', reason: 'Nueva fecha' });
    expect(bad.body.error).toBe('SCHEDULE_CONSTRAINTS');
    await as().patch(`/api/matches/${final.id}`).send({ status: 'SCHEDULED', date: addDays(SAT, 30), time: '18:00', reason: 'Nueva fecha' }).expect(200);
  });

  it('playoffs: la vista previa propone horarios válidos y advance los confirma', async () => {
    const league = await tournament(O, 4, { settings: { system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 } });
    await as().post(`/api/tournaments/${league.t}/schedule`).send({ startDate: SAT }).expect(201);
    for (const m of await matchesOf(league.t)) {
      const homeWins = league.teams.indexOf(m.homeTeamId) < league.teams.indexOf(m.awayTeamId);
      await as().put(`/api/matches/${m.id}/result`).send({ homeScore: homeWins ? 1 : 0, awayScore: homeWins ? 0 : 1, playerStats: [] }).expect(200);
    }
    await rules(league.t, { days: [0] }).expect(200);
    const body = { startDate: addDays(SAT, 28), smart: true };
    const preview = (await as().post(`/api/tournaments/${league.t}/phases/advance/preview`).send(body).expect(200)).body;
    expect(preview.constraints[0].errors[0].code).toBe('DAY_NOT_ALLOWED');
    expect(preview.proposal.matches).toEqual([expect.objectContaining({ date: addDays(SAT, 29), warnings: [] })]);
    expect(await matchCount(league.t)).toBe(6);
    const advanced = await as().post(`/api/tournaments/${league.t}/phases/advance`).send({ startDate: body.startDate, assignments: preview.proposal.matches.map(({ round, homeTeamId, awayTeamId, date, time, fieldId }: Assigned) => ({ round, homeTeamId, awayTeamId, date, time, fieldId })) });
    expect(advanced.status, JSON.stringify(advanced.body)).toBe(200);
    const final = (await matchesOf(league.t)).find((m) => m.stage?.tie)!;
    expect(final.date).toBe(addDays(SAT, 29));
  });
});

describe('6B — permisos, finalizados y concurrencia', () => {
  it('RBAC: propietario y coordinador piden y confirman; anotador y ajenos no', async () => {
    const { t } = await tournament();
    await addMember(t, C, 'COORDINATOR');
    await addMember(t, S, 'SCORER');
    const F = (await venue('RBAC 6B', ['1'])).fields[0].id;
    for (const [u, status] of [[O, 200], [C, 200], [S, 403], [X, 403]] as const) expect({ u: u.email, s: (await propose(t, { startDate: SAT, fieldIds: [F] }, u)).status }).toEqual({ u: u.email, s: status });
    const p = (await propose(t, { startDate: SAT }, C).expect(200)).body;
    await confirm(t, { startDate: SAT }, p, S).expect(403);
    await confirm(t, { startDate: SAT }, p, C).expect(201);
  });

  it('torneo finalizado: ni propuesta ni confirmación', async () => {
    const { t } = await tournament();
    const p = (await propose(t, { startDate: SAT }).expect(200)).body;
    await as().post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    await propose(t, { startDate: SAT }).expect(409);
    await confirm(t, { startDate: SAT }, p).expect(409);
  });

  it('dos confirmaciones a la vez de la misma propuesta: solo una guarda', async () => {
    const { t } = await tournament();
    const p = (await propose(t, { startDate: SAT }).expect(200)).body;
    const results = await Promise.all([confirm(t, { startDate: SAT }, p), confirm(t, { startDate: SAT }, p)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await matchCount(t)).toBe(6);
  });

  it('dos torneos confirman a la vez la misma cancha y hora: solo uno la obtiene', async () => {
    const F = (await venue('Carrera 6B', ['Única'], O, 0)).fields[0].id;
    const [a, b] = [await tournament(O, 2), await tournament(O, 2)];
    const body = { startDate: SAT, firstKickoff: '18:00', fieldIds: [F] };
    const [pa, pb] = [(await propose(a.t, body).expect(200)).body, (await propose(b.t, body).expect(200)).body];
    expect(pa.matches[0].time).toBe(pb.matches[0].time);
    const results = await Promise.all([confirm(a.t, body, pa), confirm(b.t, body, pb)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('FIELD_CONFLICT');
    expect((await matchCount(a.t)) + (await matchCount(b.t))).toBe(1);
  });
});
