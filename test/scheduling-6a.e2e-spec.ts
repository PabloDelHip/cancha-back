/**
 * 6A (2026-10-19) — restricciones de calendario contra la API real (`docs/scheduling-6a.md`):
 * configuración y validación, días/horario, límites, cancha (separación y disponibilidad), equipos
 * (obligatorias y preferencias), programación manual, reprogramación, generador y cruces, calendarios
 * existentes, zona horaria, RBAC, torneos ajenos y finalizados, auditoría y concurrencia.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { todayISODate } from '../src/common/utils/dates.js';
import { addDays } from '../src/modules/venues/occupancy.js';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let db: Connection;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, A: U, C: U, S: U, X: U, O2: U;
const as = (u: U = O) => authed(http, u.token);

// Sábados y domingos de 2027.
const SAT = '2027-02-06';
const SUN = '2027-02-07';
const SAT2 = '2027-02-13';

let seq = 0;
let round = 0;
async function tournament(owner: U = O, n = 4, extra: Record<string, unknown> = {}) {
  const t = (await as(owner).post('/api/tournaments').send({ name: `Calendario 6A ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', ...extra }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = (await as(owner).post('/api/teams').send({ name: `Equipo 6A ${seq}-${i}` }).expect(201)).body.id as string;
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
const teamRules = (t: string, team: string, body: Record<string, unknown>, u: U = O) => as(u).put(`/api/tournaments/${t}/scheduling/teams/${team}`).send(body);
const match = (t: string, home: string, away: string, date: string, time: string, extra: Record<string, unknown> = {}, u: U = O) =>
  as(u).post('/api/matches').send({ tournamentId: t, round: ++round, homeTeamId: home, awayTeamId: away, date, time, ...extra });
const codesOf = (body: { matches?: { errors: { code: string }[] }[] }) => (body.matches ?? []).flatMap((m) => m.errors.map((e) => e.code));
const matchCount = (t: string) => db.collection('matches').countDocuments({ tournamentId: new Types.ObjectId(t) });

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  db = ctx.app.get<Connection>(getConnectionToken());
  [O, A, C, S, X, O2] = [
    await registerOrganizer(http, 'Dueño'),
    await registerOrganizer(http, 'Admin'),
    await registerOrganizer(http, 'Coordinador'),
    await registerOrganizer(http, 'Anotador'),
    await registerOrganizer(http, 'Ajeno'),
    await registerOrganizer(http, 'Otro dueño'),
  ];
});
afterAll(async () => ctx?.close());

describe('6A — torneos sin restricciones y existentes', () => {
  it('sin configurar: valores por defecto, cualquier horario y sin conflictos', async () => {
    const { t, teams } = await tournament();
    const view = (await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body;
    expect(view.rules).toEqual({ timeZone: null, days: [], startTime: null, endTime: null, fieldGapMinutes: null, maxMatchesPerDay: null, maxSimultaneous: null, fieldAvailability: 'WARN', softRules: [] });
    expect(view).toMatchObject({ durationMinutes: 60, effectiveTimeZone: 'America/Cancun', conflicts: { checked: 0, matches: [] } });
    expect(view.teams).toHaveLength(4);
    await match(t, teams[0], teams[1], SUN, '03:00').expect(201);
    // Las restricciones no se publican.
    const pub = (await authed(http, '').get(`/api/tournaments/${t}`).expect(200)).body;
    expect(pub.scheduling).toBeUndefined();
  });

  it('un documento anterior a 6A (sin el campo) se lee y programa igual', async () => {
    const { t, teams } = await tournament();
    await db.collection('tournaments').updateOne({ _id: new Types.ObjectId(t) }, { $unset: { scheduling: '' } });
    await db.collection('tournament_teams').updateMany({ tournamentId: new Types.ObjectId(t) }, { $unset: { scheduling: '' } });
    await as().get(`/api/tournaments/${t}/scheduling`).expect(200);
    await match(t, teams[0], teams[1], SAT, '10:00').expect(201);
  });

  it('configurar con calendario previo: informa conflictos y no toca partidos ni historia', async () => {
    const { t, teams } = await tournament();
    const sunday = (await match(t, teams[0], teams[1], SUN, '10:00').expect(201)).body.id;
    const saturday = (await match(t, teams[2], teams[3], SAT, '10:00').expect(201)).body.id;
    // Jugado en domingo (historia): no se revisa.
    const played = (await match(t, teams[0], teams[2], '2027-01-31', '10:00').expect(201)).body.id;
    await as().put(`/api/matches/${played}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [] }).expect(200);
    const before = await db.collection('matches').find({ tournamentId: new Types.ObjectId(t) }).sort({ _id: 1 }).toArray();

    // Vista previa: no guarda.
    const preview = (await as().post(`/api/tournaments/${t}/scheduling/preview`).send({ tournament: { days: [6] } }).expect(200)).body;
    expect(preview.conflicts.matches.map((m: { matchId: string }) => m.matchId)).toEqual([sunday]);
    expect((await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body.rules.days).toEqual([]);

    const saved = (await rules(t, { days: [6] }).expect(200)).body;
    expect(saved.rules.days).toEqual([6]);
    expect(saved.conflicts.checked).toBe(2);
    expect(saved.conflicts.matches).toEqual([expect.objectContaining({ matchId: sunday, errors: [expect.objectContaining({ code: 'DAY_NOT_ALLOWED' })] })]);
    const after = await db.collection('matches').find({ tournamentId: new Types.ObjectId(t) }).sort({ _id: 1 }).toArray();
    expect(after).toEqual(before);

    // Lo que no cambia de horario se sigue editando (texto de sede, jornada); moverlo a otro domingo, no.
    await as().patch(`/api/matches/${sunday}`).send({ venue: 'Campo 2', reason: 'Ajuste' }).expect(200);
    const moved = await as().patch(`/api/matches/${sunday}`).send({ date: '2027-02-14', reason: 'Lluvia' });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe('SCHEDULE_CONSTRAINTS');
    await as().patch(`/api/matches/${sunday}`).send({ date: SAT2, reason: 'Lluvia' }).expect(200);
    expect(saturday).toBeDefined();
  });
});

describe('6A — configuración inválida', () => {
  it('rechaza rangos incoherentes, duraciones que no caben y zonas desconocidas', async () => {
    const { t } = await tournament();
    for (const body of [
      { startTime: '20:00', endTime: '18:00' },
      { startTime: '18:00', endTime: '18:45' },
      { days: [7] },
      { days: [6, 6] },
      { timeZone: 'Marte/Olympus' },
      { maxMatchesPerDay: 0 },
      { endTime: '25:00' },
      { durationMinutes: 5 },
      { startTime: '20:00', endTime: '22:00', durationMinutes: 150 },
    ]) {
      const res = await rules(t, body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    expect((await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body.updatedAt).toBeNull();
  });
});

describe('6A — días, horarios y duración', () => {
  it('días y horario obligatorios al programar, con mensaje claro', async () => {
    const { t, teams } = await tournament();
    await rules(t, { days: [6], startTime: '08:00', endTime: '22:00' }).expect(200);
    const sunday = await match(t, teams[0], teams[1], SUN, '10:00');
    expect(sunday.status).toBe(409);
    expect(sunday.body).toMatchObject({ error: 'SCHEDULE_CONSTRAINTS' });
    expect(sunday.body.message).toContain('domingo');
    expect(codesOf(sunday.body)).toEqual(['DAY_NOT_ALLOWED']);
    expect(codesOf((await match(t, teams[0], teams[1], SAT, '21:30')).body)).toEqual(['OUTSIDE_HOURS']);
    expect(codesOf((await match(t, teams[0], teams[1], SAT, '07:30')).body)).toEqual(['OUTSIDE_HOURS']);
    await match(t, teams[0], teams[1], SAT, '21:00').expect(201);
    // CANCELLED no ocupa horario: no se evalúa.
    await match(t, teams[2], teams[3], SUN, '10:00', { status: 'CANCELLED' }).expect(201);
  });

  it('la duración se edita aquí (misma fuente que Información) y cuenta para el horario', async () => {
    const { t, teams } = await tournament();
    await rules(t, { endTime: '22:00', durationMinutes: 90 }).expect(200);
    expect((await as().get(`/api/admin/tournaments/${t}`).expect(200)).body.information.schedule.durationMinutes).toBe(90);
    expect(codesOf((await match(t, teams[0], teams[1], SAT, '21:00')).body)).toEqual(['OUTSIDE_HOURS']);
    await match(t, teams[0], teams[1], SAT, '20:30').expect(201);
  });

  it('cruce de medianoche y zona horaria del torneo', async () => {
    const { t, teams } = await tournament();
    await rules(t, { endTime: '24:00', timeZone: 'America/Mazatlan' }).expect(200);
    const view = (await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body;
    expect(view.effectiveTimeZone).toBe('America/Mazatlan');
    expect(view.conflicts.today).toBe(todayISODate(new Date(), 'America/Mazatlan'));
    const late = await match(t, teams[0], teams[1], SAT, '23:30');
    expect(codesOf(late.body)).toEqual(['OUTSIDE_HOURS']);
    expect(late.body.matches[0].errors[0].message).toContain('del día siguiente');
    await match(t, teams[0], teams[1], SAT, '23:00').expect(201);
    await rules(t, { timeZone: null }).expect(200);
    expect((await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body.effectiveTimeZone).toBe('America/Cancun');
  });

  it('los conflictos se revisan desde HOY en la zona del torneo (lo pasado es historia)', async () => {
    const { t, teams } = await tournament();
    const tz = 'America/Mazatlan';
    const today = todayISODate(new Date(), tz);
    const yesterday = addDays(today, -1);
    const todays = (await match(t, teams[0], teams[1], today, '23:00').expect(201)).body.id;
    await match(t, teams[2], teams[3], yesterday, '23:00').expect(201);
    await teamRules(t, teams[0], { unavailableDates: [today, yesterday] }).expect(200);
    await teamRules(t, teams[2], { unavailableDates: [today, yesterday] }).expect(200);
    const saved = (await rules(t, { timeZone: tz }).expect(200)).body;
    expect(saved.conflicts.matches.map((m: { matchId: string }) => m.matchId)).toEqual([todays]);
  });
});

describe('6A — límites del torneo y canchas', () => {
  it('máximo por día y simultáneos', async () => {
    const { t, teams } = await tournament(O, 6);
    await rules(t, { maxMatchesPerDay: 2, maxSimultaneous: 1 }).expect(200);
    await match(t, teams[0], teams[1], SAT, '10:00').expect(201);
    expect(codesOf((await match(t, teams[2], teams[3], SAT, '10:30')).body)).toEqual(['SIMULTANEOUS_LIMIT']);
    await match(t, teams[2], teams[3], SAT, '11:00').expect(201);
    expect(codesOf((await match(t, teams[4], teams[5], SAT, '14:00')).body)).toEqual(['TOURNAMENT_DAILY_LIMIT']);
    await match(t, teams[4], teams[5], SUN, '14:00').expect(201);
  });

  it('separación en la misma cancha (con partidos de otro torneo) y disponibilidad obligatoria', async () => {
    const venue = (await as().post('/api/venues').send({ name: 'Deportiva 6A', bufferMinutes: 0, fields: [{ name: 'Cancha 1', availability: { weekly: [{ day: 6, from: '08:00', to: '14:00' }], closedDates: [] } }] }).expect(201)).body;
    const fieldId = venue.fields[0].id as string;
    const other = await tournament();
    await match(other.t, other.teams[0], other.teams[1], SAT, '10:00', { fieldId }).expect(201);
    const { t, teams } = await tournament();
    await rules(t, { fieldGapMinutes: 30 }).expect(200);
    // La validación de siempre se conserva: encima del otro partido → FIELD_CONFLICT.
    expect((await match(t, teams[0], teams[1], SAT, '10:30', { fieldId })).body.error).toBe('FIELD_CONFLICT');
    const gap = await match(t, teams[0], teams[1], SAT, '11:15', { fieldId });
    expect(codesOf(gap.body)).toEqual(['FIELD_GAP']);
    expect(gap.body.matches[0].errors[0]).toMatchObject({ scope: 'FIELD', fieldId });
    await match(t, teams[0], teams[1], SAT, '11:30', { fieldId }).expect(201);
    // Fuera del horario de la cancha: aviso por defecto…
    const warned = (await match(t, teams[2], teams[3], SAT, '13:30', { fieldId }).expect(201)).body;
    expect(warned.warnings).toEqual([expect.stringContaining('fuera del horario configurado de la cancha')]);
    // …obligatoria si el torneo lo elige.
    await rules(t, { fieldAvailability: 'BLOCK' }).expect(200);
    const blocked = await as().patch(`/api/matches/${warned.id}`).send({ time: '13:45', reason: 'Ajuste' });
    expect(codesOf(blocked.body)).toEqual(['FIELD_UNAVAILABLE']);
  });
});

describe('6A — restricciones por equipo', () => {
  it('obligatorias, preferencias y aisladas del resto de torneos', async () => {
    const { t, teams } = await tournament();
    const [a, b, c, d] = teams;
    const view = (await teamRules(t, a, { unavailableDays: [6], unavailableTimes: [{ day: 0, from: '14:00', to: '18:00' }], notes: 'Juegan en otra liga los sábados' }).expect(200)).body;
    expect(view.teams.find((x: { teamId: string }) => x.teamId === a)).toMatchObject({ configured: true, rules: { unavailableDays: [6], strict: true } });
    expect(codesOf((await match(t, a, b, SAT, '10:00')).body)).toEqual(['TEAM_DAY']);
    expect(codesOf((await match(t, b, a, SUN, '15:00')).body)).toEqual(['TEAM_TIME']);
    await match(t, c, d, SAT, '10:00').expect(201);
    // Preferencia: se programa con aviso.
    await teamRules(t, b, { unavailableDays: [0], strict: false }).expect(200);
    const pref = (await match(t, a, b, SUN, '10:00').expect(201)).body;
    expect(pref.warnings).toEqual([expect.stringContaining('(preferencia)')]);
    // El mismo equipo en otro torneo no hereda nada.
    const other = (await as().post('/api/tournaments').send({ name: 'Otro torneo 6A', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id;
    await as().post(`/api/tournaments/${other}/teams/${a}`).expect(201);
    await as().post(`/api/tournaments/${other}/teams/${c}`).expect(201);
    await match(other, a, c, SAT, '10:00').expect(201);
    // Quitar las restricciones (reemplazo completo vacío).
    expect((await teamRules(t, a, {}).expect(200)).body.teams.find((x: { teamId: string }) => x.teamId === a).configured).toBe(false);
    await match(t, a, d, SAT2, '10:00').expect(201);
  });

  it('descanso mínimo y máximo de partidos por día', async () => {
    const { t, teams } = await tournament();
    const [a, b, c, d] = teams;
    await teamRules(t, a, { minRestHours: 48, maxMatchesPerDay: 1 }).expect(200);
    await match(t, a, b, SAT, '10:00').expect(201);
    const sameDay = await match(t, a, c, SAT, '18:00');
    expect(codesOf(sameDay.body).sort()).toEqual(['TEAM_DAILY_LIMIT', 'TEAM_REST']);
    expect(codesOf((await match(t, c, a, '2027-02-08', '10:00')).body)).toEqual(['TEAM_REST']); // lunes 10:00 < 48 h
    await match(t, c, a, '2027-02-08', '11:00').expect(201);
    await match(t, c, d, SAT, '18:00').expect(201);
  });

  it('validación: equipo no inscrito, sin días posibles, rangos inválidos', async () => {
    const { t, teams } = await tournament();
    await rules(t, { days: [6, 0] }).expect(200);
    const outsider = (await as().post('/api/teams').send({ name: 'No inscrito 6A' }).expect(201)).body.id;
    await teamRules(t, outsider, { unavailableDays: [1] }).expect(404);
    const impossible = await teamRules(t, teams[0], { unavailableDays: [6, 0] });
    expect(impossible.status).toBe(400);
    expect(impossible.body.message).toContain('no podría jugar');
    await teamRules(t, teams[0], { unavailableDays: [6, 0], strict: false }).expect(200);
    await teamRules(t, teams[1], { unavailableTimes: [{ day: 1, from: '18:00', to: '17:00' }] }).expect(400);
    // Y el torneo no puede dejar a un equipo obligado sin días.
    await teamRules(t, teams[1], { unavailableDays: [0] }).expect(200);
    expect((await rules(t, { days: [0] })).status).toBe(400);
  });
});

describe('6A — sin rutas alternativas', () => {
  it('reprogramar, reactivar un pospuesto y crear en juego también se validan', async () => {
    const { t, teams } = await tournament();
    const m = (await match(t, teams[0], teams[1], SUN, '10:00').expect(201)).body.id;
    await as().patch(`/api/matches/${m}`).send({ status: 'POSTPONED', reason: 'Lluvia' }).expect(200);
    await rules(t, { days: [6] }).expect(200);
    // Volver a programarlo en domingo (misma fecha) no se cuela.
    const back = await as().patch(`/api/matches/${m}`).send({ status: 'SCHEDULED', date: '2027-02-14', reason: 'Nueva fecha' });
    expect(codesOf(back.body)).toEqual(['DAY_NOT_ALLOWED']);
    await as().patch(`/api/matches/${m}`).send({ status: 'SCHEDULED', date: SAT2, reason: 'Nueva fecha' }).expect(200);
    expect(codesOf((await match(t, teams[2], teams[3], SUN, '10:00', { status: 'LIVE' })).body)).toEqual(['DAY_NOT_ALLOWED']);
    // Cambiar equipos también revalida (el rival tiene restricciones).
    await teamRules(t, teams[2], { unavailableDates: [SAT2] }).expect(200);
    expect(codesOf((await as().patch(`/api/matches/${m}`).send({ awayTeamId: teams[2] })).body)).toEqual(['TEAM_DATE']);
  });

  it('el generador no crea un calendario que incumple; con preferencias, avisa', async () => {
    const { t, teams } = await tournament();
    await rules(t, { days: [6] }).expect(200);
    // Domingo de inicio: todas las jornadas en domingo.
    const bad = await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: SUN });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('SCHEDULE_CONSTRAINTS');
    expect(bad.body.message).toMatch(/^6 de 6 partidos incumplen/);
    expect(await matchCount(t)).toBe(0);
    await teamRules(t, teams[0], { unavailableTimes: [{ day: 6, from: '18:00', to: '19:00' }] }).expect(200);
    expect((await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: SAT, firstKickoff: '18:00' })).body.error).toBe('SCHEDULE_CONSTRAINTS');
    await teamRules(t, teams[0], { unavailableTimes: [{ day: 6, from: '18:00', to: '19:00' }], strict: false }).expect(200);
    const ok = (await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: SAT, firstKickoff: '18:00' }).expect(201)).body;
    expect(ok.matches).toHaveLength(6);
    expect(ok.warnings.length).toBeGreaterThan(0);
    // Reemplazarlo vuelve a evaluarse (sin contar el calendario que se reemplaza).
    await rules(t, { maxMatchesPerDay: 2 }).expect(200);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: SAT, firstKickoff: '10:00', replaceExisting: true }).expect(201);
  });

  it('cruces de eliminatoria a mano y vista previa de la fase siguiente', async () => {
    const { t, teams } = await tournament(O, 4, { settings: { system: 'KNOCKOUT' } });
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 4 }).expect(201);
    await rules(t, { days: [6] }).expect(200);
    const tie = await as().post(`/api/tournaments/${t}/phases/0/ties`).send({ round: 0, homeTeamId: teams[0], awayTeamId: teams[1], legs: [{ date: SUN, time: '18:00' }] });
    expect(tie.status).toBe(409);
    expect(tie.body.error).toBe('SCHEDULE_CONSTRAINTS');
    await as().post(`/api/tournaments/${t}/phases/0/ties`).send({ round: 0, homeTeamId: teams[0], awayTeamId: teams[1], legs: [{ date: SAT, time: '18:00' }] }).expect(201);

    const league = await tournament(O, 4, { settings: { system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 } });
    await as().post(`/api/tournaments/${league.t}/schedule`).send({ startDate: SAT }).expect(201);
    for (const m of (await as().get(`/api/tournaments/${league.t}/matches`).expect(200)).body) {
      // Gana siempre el de menor índice: tabla sin empates (3, 2, 1 y 0 victorias).
      const homeWins = league.teams.indexOf(m.homeTeamId) < league.teams.indexOf(m.awayTeamId);
      const r = await as().put(`/api/matches/${m.id}/result`).send({ homeScore: homeWins ? 1 : 0, awayScore: homeWins ? 0 : 1, playerStats: [] });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    await rules(league.t, { days: [0] }).expect(200);
    const previewRes = await as().post(`/api/tournaments/${league.t}/phases/advance/preview`).send({ startDate: SAT2 });
    expect(previewRes.status, JSON.stringify(previewRes.body)).toBe(200);
    const preview = previewRes.body;
    expect(preview.constraints[0].errors[0].code).toBe('DAY_NOT_ALLOWED');
    expect((await as().post(`/api/tournaments/${league.t}/phases/advance`).send({ startDate: SAT2 })).body.error).toBe('SCHEDULE_CONSTRAINTS');
    const advanced = await as().post(`/api/tournaments/${league.t}/phases/advance`).send({ startDate: '2027-02-14' });
    expect(advanced.status, JSON.stringify(advanced.body)).toBe(200);
  });

  it('revisión en vivo para el formulario (excluye el partido que se mueve)', async () => {
    const { t, teams } = await tournament();
    await rules(t, { maxMatchesPerDay: 1 }).expect(200);
    const m = (await match(t, teams[0], teams[1], SAT, '10:00').expect(201)).body.id;
    const check = (body: Record<string, unknown>) => as().post(`/api/tournaments/${t}/scheduling/check`).send({ homeTeamId: teams[2], awayTeamId: teams[3], date: SAT, time: '12:00', ...body });
    expect((await check({}).expect(200)).body).toMatchObject({ valid: false, errors: [expect.objectContaining({ code: 'TOURNAMENT_DAILY_LIMIT' })] });
    expect((await check({ matchId: m }).expect(200)).body.valid).toBe(true);
  });
});

describe('6A — permisos, torneos ajenos y finalizados', () => {
  it('RBAC: propietario, administrador y coordinador configuran; anotador y ajenos no', async () => {
    const { t, teams } = await tournament();
    await addMember(t, A, 'ADMIN');
    await addMember(t, C, 'COORDINATOR');
    await addMember(t, S, 'SCORER');
    const expectMatrix = async (call: (u: U) => PromiseLike<{ status: number }>, expected: [U, number][]) => {
      for (const [u, status] of expected) expect({ u: u.email, status: (await call(u)).status }).toEqual({ u: u.email, status });
    };
    await expectMatrix((u) => as(u).get(`/api/tournaments/${t}/scheduling`), [[O, 200], [A, 200], [C, 200], [S, 200], [X, 403]]);
    let n = 0;
    await expectMatrix((u) => rules(t, { maxMatchesPerDay: 5 + ++n }, u), [[O, 200], [A, 200], [C, 200], [S, 403], [X, 403]]);
    await expectMatrix((u) => teamRules(t, teams[0], { unavailableDays: [1], minRestHours: ++n }, u), [[O, 200], [S, 403], [X, 403]]);
    await expectMatrix((u) => as(u).post(`/api/tournaments/${t}/scheduling/preview`).send({}), [[O, 200], [C, 200], [S, 403], [X, 403]]);
    await expectMatrix((u) => as(u).post(`/api/tournaments/${t}/scheduling/check`).send({ homeTeamId: teams[0], awayTeamId: teams[1], date: SAT, time: '10:00' }), [[C, 200], [S, 403], [X, 403]]);
    // Auditoría: cada cambio en el historial del torneo, con su rol.
    const log = (await as().get(`/api/tournaments/${t}/match-log`).expect(200)).body.entries as { action: string; actorRole: string; matchId: string | null; changes: Record<string, unknown> }[];
    const entries = log.filter((e) => e.action === 'SCHEDULING_RULES_UPDATED');
    expect(entries.map((e) => e.actorRole).sort()).toEqual(['ADMIN', 'COORDINATOR', 'OWNER', 'OWNER']);
    expect(entries.every((e) => e.matchId === null)).toBe(true);
    expect(entries.find((e) => e.changes.teamRules)).toBeDefined();
  });

  it('torneos ajenos: ni configurar ni sondear partidos o canchas de otros por id', async () => {
    const mine = await tournament();
    const theirs = await tournament(O2);
    await rules(theirs.t, { days: [6] }, O).expect(403);
    await teamRules(mine.t, theirs.teams[0], { unavailableDays: [1] }).expect(404);
    const foreignMatch = (await match(theirs.t, theirs.teams[0], theirs.teams[1], SAT, '10:00', {}, O2).expect(201)).body.id;
    await as().post(`/api/tournaments/${mine.t}/scheduling/check`).send({ matchId: foreignMatch, homeTeamId: mine.teams[0], awayTeamId: mine.teams[1], date: SAT, time: '10:00' }).expect(404);
    const foreignField = (await as(O2).post('/api/venues').send({ name: 'Ajena 6A', fields: [{ name: 'X' }] }).expect(201)).body.fields[0].id;
    await as().post(`/api/tournaments/${mine.t}/scheduling/check`).send({ fieldId: foreignField, homeTeamId: mine.teams[0], awayTeamId: mine.teams[1], date: SAT, time: '10:00' }).expect(404);
  });

  it('torneo finalizado: se consulta, no se modifica', async () => {
    const { t, teams } = await tournament();
    await rules(t, { days: [6] }).expect(200);
    await as().post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    const view = (await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body;
    expect(view.rules.days).toEqual([6]);
    await rules(t, { days: [0] }).expect(409);
    await teamRules(t, teams[0], { unavailableDays: [1] }).expect(409);
    await as().post(`/api/tournaments/${t}/scheduling/preview`).send({}).expect(409);
  });
});

describe('6A — concurrencia', () => {
  it('dos partidos a la vez con cupo para uno: solo entra uno', async () => {
    const { t, teams } = await tournament();
    await rules(t, { maxMatchesPerDay: 1 }).expect(200);
    const results = await Promise.all([match(t, teams[0], teams[1], SAT, '10:00'), match(t, teams[2], teams[3], SAT, '16:00')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(codesOf(results.find((r) => r.status === 409)!.body)).toEqual(['TOURNAMENT_DAILY_LIMIT']);
    expect(await matchCount(t)).toBe(1);
  });

  it('configurar mientras se programa: el partido ve la regla o la regla ve el partido', async () => {
    const { t, teams } = await tournament();
    const [saved, created] = await Promise.all([rules(t, { days: [6] }), match(t, teams[0], teams[1], SUN, '10:00')]);
    expect(saved.status).toBe(200);
    if (created.status === 201) {
      // Entró antes: la configuración lo reporta como conflicto (no se pierde en silencio).
      const view = (await as().get(`/api/tournaments/${t}/scheduling`).expect(200)).body;
      expect(view.conflicts.matches.map((m: { matchId: string }) => m.matchId)).toEqual([created.body.id]);
    } else expect(codesOf(created.body)).toEqual(['DAY_NOT_ALLOWED']);
  });
});
