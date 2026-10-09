/**
 * Historial de partidos (Módulo 2C-1, 2026-10-09): entradas en todas las rutas que escriben
 * partidos, motivos obligatorios con el torneo en curso, sin duplicados, atomicidad, partidos
 * eliminados con lo liberado (también por el cuadro automático), aislamiento y concurrencia.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let token: string;
let otherToken: string;
const as = () => authed(http, token);

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  token = (await registerOrganizer(http, 'Historial')).token;
  otherToken = (await registerOrganizer(http, 'OtroHistorial')).token;
});
afterAll(async () => ctx?.close());

type Entry = { action: string; source: string; cause: string | null; reason: string | null; changes: Record<string, { from: unknown; to: unknown }> | null; snapshot: Record<string, unknown> | null; released: { fieldId: string | null; referees: { refereeId: string; role: string }[] }[] | null; deleted?: unknown[] };
const log = async (matchId: string) => (await as().get(`/api/matches/${matchId}/log`).expect(200)).body as { entries: Entry[]; refs: { teams: Record<string, string>; referees: Record<string, string>; users: Record<string, string> } };
const tournamentLog = async (t: string, deleted = false) => (await as().get(`/api/tournaments/${t}/match-log${deleted ? '?deleted=true' : ''}`).expect(200)).body as { entries: Entry[] };

let seq = 0;
async function tournament(status: 'ACTIVE' | 'DRAFT' = 'ACTIVE', settings?: Record<string, unknown>, teamsCount = 2) {
  seq++;
  const t = (await as().post('/api/tournaments').send({ name: `Historial ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status, ...(settings ? { settings } : {}) }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (let i = 0; i < teamsCount; i++) {
    const id = (await as().post('/api/teams').send({ name: `H${seq}-${i + 1}` }).expect(201)).body.id as string;
    await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
let round = 0;
const match = async (x: { t: string; teams: string[] }, date = '2027-01-10', time = '18:00', extra: Record<string, unknown> = {}) =>
  (await as().post('/api/matches').send({ tournamentId: x.t, round: ++round, homeTeamId: x.teams[0], awayTeamId: x.teams[1], date, time, ...extra }).expect(201)).body.id as string;

it('crear a mano se registra; un calendario generado no crea entradas por partido', async () => {
  const x = await tournament();
  const m = await match(x);
  expect((await log(m)).entries).toEqual([expect.objectContaining({ action: 'CREATED', source: 'USER', snapshot: expect.objectContaining({ date: '2027-01-10', time: '18:00' }) })]);
  const y = await tournament('ACTIVE', undefined, 4);
  await as().post(`/api/tournaments/${y.t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
  expect((await tournamentLog(y.t)).entries).toEqual([]);
});

it('motivo obligatorio con el torneo en curso (reprogramar, posponer, cancelar); en borrador opcional', async () => {
  const x = await tournament();
  const m = await match(x);
  expect((await as().patch(`/api/matches/${m}`).send({ time: '20:00' }).expect(400)).body.message).toMatch(/motivo de la reprogramación/);
  expect((await as().patch(`/api/matches/${m}`).send({ status: 'POSTPONED' }).expect(400)).body.message).toMatch(/posponer/);
  expect((await as().patch(`/api/matches/${m}`).send({ status: 'CANCELLED' }).expect(400)).body.message).toMatch(/cancelar/);
  await as().patch(`/api/matches/${m}`).send({ time: '20:00', reason: 'Lluvia' }).expect(200);
  // Sin cambio de fecha/hora/estado no hace falta motivo.
  await as().patch(`/api/matches/${m}`).send({ venue: 'Campo 2' }).expect(200);
  const entries = (await log(m)).entries;
  expect(entries.map((e) => e.action)).toEqual(['CREATED', 'RESCHEDULED', 'FIELD_CHANGED']);
  expect(entries[1]).toMatchObject({ reason: 'Lluvia', changes: { time: { from: '18:00', to: '20:00' } } });

  const draft = await tournament('DRAFT');
  const d = await match(draft);
  await as().patch(`/api/matches/${d}`).send({ date: '2027-01-11' }).expect(200);
  expect((await log(d)).entries.map((e) => e.action)).toEqual(['CREATED', 'RESCHEDULED']);
});

it('sin duplicados: reenviar el formulario completo sin cambios no registra nada', async () => {
  const x = await tournament();
  const m = await match(x);
  const full = { tournamentId: x.t, round, homeTeamId: x.teams[0], awayTeamId: x.teams[1], date: '2027-01-10', time: '18:00', venue: '', status: 'SCHEDULED', fieldId: null };
  await as().patch(`/api/matches/${m}`).send(full).expect(200);
  await as().patch(`/api/matches/${m}`).send(full).expect(200);
  expect((await log(m)).entries.map((e) => e.action)).toEqual(['CREATED']);
});

it('resultado: captura y corrección del marcador; volver a guardar igual o solo estadísticas no registra', async () => {
  const x = await tournament();
  const m = await match(x);
  const result = (h: number, a: number) => as().put(`/api/matches/${m}/result`).send({ homeScore: h, awayScore: a, playerStats: [] }).expect(200);
  await result(1, 0);
  await result(1, 0);
  await result(2, 0);
  const entries = (await log(m)).entries;
  expect(entries.map((e) => e.action)).toEqual(['CREATED', 'RESULT_CAPTURED', 'RESULT_CORRECTED']);
  expect(entries[2].changes).toEqual({ homeScore: { from: 1, to: 2 } });
});

it('árbitros y cancha: asignar, quitar, ausencia con sustituto y cambio de cancha', async () => {
  const x = await tournament();
  const m = await match(x);
  const ref = async (f: string) => (await as().post('/api/referees').send({ firstName: f, lastName: `H${++seq}` }).expect(201)).body as { id: string; name: string };
  const [a, b, c] = [await ref('Uno'), await ref('Dos'), await ref('Tres')];
  const assigned = (await as().post(`/api/matches/${m}/referees`).send({ refereeId: a.id, role: 'CENTRAL' }).expect(201)).body.referees[0];
  const extra = (await as().post(`/api/matches/${m}/referees`).send({ refereeId: b.id, role: 'FOURTH' }).expect(201)).body.referees[1];
  await as().delete(`/api/matches/${m}/referees/${extra.id}`).expect(200);
  await as().post(`/api/matches/${m}/referees/${assigned.id}/absence`).send({ substituteId: c.id, note: 'Se lesionó' }).expect(200);
  const v = (await as().post('/api/venues').send({ name: `Sede H${++seq}`, fields: [{ name: 'C1' }] }).expect(201)).body;
  await as().patch(`/api/matches/${m}`).send({ fieldId: v.fields[0].id }).expect(200);
  const { entries, refs } = await log(m);
  expect(entries.map((e) => e.action)).toEqual(['CREATED', 'REFEREE_ASSIGNED', 'REFEREE_ASSIGNED', 'REFEREE_REMOVED', 'REFEREE_ABSENT', 'FIELD_CHANGED']);
  expect(entries[4]).toMatchObject({ reason: 'Se lesionó', changes: { substitute: { from: null, to: { refereeId: c.id } } } });
  expect(refs.referees).toMatchObject({ [a.id]: a.name, [c.id]: c.name });
});

it('eliminar a mano: copia del partido y lo liberado; su historial sigue consultable', async () => {
  const x = await tournament();
  const v = (await as().post('/api/venues').send({ name: `Sede E${++seq}`, fields: [{ name: 'C1' }] }).expect(201)).body;
  const r = (await as().post('/api/referees').send({ firstName: 'Borrable', lastName: `E${seq}` }).expect(201)).body;
  const m = await match(x, '2027-03-06', '10:00', { fieldId: v.fields[0].id });
  await as().post(`/api/matches/${m}/referees`).send({ refereeId: r.id, role: 'CENTRAL' }).expect(201);
  await as().delete(`/api/matches/${m}`).expect(204);
  const entries = (await log(m)).entries;
  expect(entries.at(-1)).toMatchObject({
    action: 'DELETED',
    cause: 'MANUAL',
    snapshot: expect.objectContaining({ date: '2027-03-06', fieldId: v.fields[0].id }),
    released: [{ fieldId: v.fields[0].id, referees: [{ refereeId: r.id, role: 'CENTRAL' }] }],
  });
  expect((await tournamentLog(x.t, true)).entries.map((e) => e.action)).toEqual(['DELETED']);
});

it('reemplazar el calendario o cambiar el formato: una entrada con todos los eliminados y lo liberado', async () => {
  const x = await tournament('ACTIVE', undefined, 4);
  await as().post(`/api/tournaments/${x.t}/schedule`).send({ startDate: '2027-04-03' }).expect(201);
  const matches = (await request(http).get(`/api/tournaments/${x.t}/matches`).expect(200)).body as { id: string }[];
  const r = (await as().post('/api/referees').send({ firstName: 'Liberado', lastName: `R${++seq}` }).expect(201)).body;
  await as().post(`/api/matches/${matches[0].id}/referees`).send({ refereeId: r.id, role: 'CENTRAL' }).expect(201);
  await as().post(`/api/tournaments/${x.t}/schedule`).send({ startDate: '2027-04-10', replaceExisting: true, releaseAssignments: true }).expect(201);
  const [replaced] = (await tournamentLog(x.t, true)).entries;
  expect(replaced).toMatchObject({ action: 'SCHEDULE_REPLACED', cause: 'SCHEDULE_REGENERATED', released: [{ referees: [{ refereeId: r.id }] }] });
  expect(replaced.deleted).toHaveLength(matches.length);
  // Consultable desde cualquiera de los partidos eliminados.
  expect((await log(matches[1].id)).entries.map((e) => e.action)).toEqual(['SCHEDULE_REPLACED']);

  await as().patch(`/api/tournaments/${x.t}`).send({ settings: { system: 'KNOCKOUT' }, resetSchedule: true }).expect(200);
  expect((await tournamentLog(x.t, true)).entries[0]).toMatchObject({ action: 'SCHEDULE_REPLACED', cause: 'FORMAT_CHANGED' });
});

it('cruces a mano: crear y quitar quedan registrados', async () => {
  const x = await tournament('ACTIVE', { system: 'KNOCKOUT' }, 4);
  await as().post(`/api/tournaments/${x.t}/schedule`).send({ manual: true, bracketSize: 4 }).expect(201);
  await as().post(`/api/tournaments/${x.t}/phases/0/ties`).send({ round: 0, homeTeamId: x.teams[0], awayTeamId: x.teams[1], legs: [{ date: '2027-05-01', time: '18:00' }] }).expect(201);
  const [tie] = (await request(http).get(`/api/tournaments/${x.t}/matches`).expect(200)).body as { id: string }[];
  expect((await log(tie.id)).entries.map((e) => e.action)).toEqual(['CREATED']);
  await as().delete(`/api/tournaments/${x.t}/phases/0/ties/0/0`).expect(200);
  expect((await log(tie.id)).entries.at(-1)).toMatchObject({ action: 'DELETED', cause: 'TIE_REMOVED', source: 'USER' });
});

it('cuadro automático: lo que el sistema reasigna o elimina queda registrado con su causa', async () => {
  const x = await tournament('ACTIVE', { system: 'KNOCKOUT' }, 4);
  await as().post(`/api/tournaments/${x.t}/schedule`).send({ startDate: '2027-06-05' }).expect(201);
  const semis = (await request(http).get(`/api/tournaments/${x.t}/matches`).expect(200)).body as { id: string; homeTeamId: string }[];
  const win = (id: string, h: number, a: number) => as().put(`/api/matches/${id}/result`).send({ homeScore: h, awayScore: a, playerStats: [] }).expect(200);
  await win(semis[0].id, 1, 0);
  await win(semis[1].id, 1, 0);
  const final = ((await request(http).get(`/api/tournaments/${x.t}/matches`).expect(200)).body as { id: string; stage: { tie: { round: number } } }[]).find((m) => m.stage.tie.round === 1)!;
  // Corregir una semifinal cambia quién juega la final: el sistema reasigna los equipos.
  await win(semis[0].id, 0, 1);
  expect((await log(final.id)).entries.at(-1)).toMatchObject({ action: 'TEAMS_CHANGED', source: 'SYSTEM', cause: 'BRACKET_SYNC' });
  // Una semifinal sin ganador (vuelve a "en juego"): la final sobra y el sistema la elimina.
  await as().put(`/api/matches/${semis[0].id}/result`).send({ homeScore: 0, awayScore: 0, status: 'LIVE', playerStats: [] }).expect(200);
  expect((await log(final.id)).entries.at(-1)).toMatchObject({ action: 'DELETED', source: 'SYSTEM', cause: 'BRACKET_SYNC' });
});

it('atomicidad: un cambio rechazado no deja entrada', async () => {
  const x = await tournament();
  const v = (await as().post('/api/venues').send({ name: `Sede A${++seq}`, fields: [{ name: 'C1' }] }).expect(201)).body;
  await match(x, '2027-07-03', '10:00', { fieldId: v.fields[0].id });
  const m = await match(x, '2027-07-03', '12:00', { fieldId: v.fields[0].id });
  await as().patch(`/api/matches/${m}`).send({ time: '10:30', reason: 'Choca' }).expect(409);
  expect((await log(m)).entries.map((e) => e.action)).toEqual(['CREATED']);
});

it('aislamiento y torneos finalizados: solo el organizador lo consulta, también ya finalizado', async () => {
  const x = await tournament();
  const m = await match(x);
  await request(http).get(`/api/matches/${m}/log`).expect(401);
  await authed(http, otherToken).get(`/api/matches/${m}/log`).expect(403);
  await authed(http, otherToken).get(`/api/tournaments/${x.t}/match-log`).expect(403);
  await as().post(`/api/tournaments/${x.t}/finish`).send({ allowPendingMatches: true }).expect(200);
  expect((await log(m)).entries).toHaveLength(1);
  await as().patch(`/api/matches/${m}`).send({ time: '21:00', reason: 'Tarde' }).expect(409);
});

it('concurrencia: dos reprogramaciones simultáneas quedan encadenadas (el "antes" de una es el "después" de la otra)', async () => {
  const x = await tournament();
  const m = await match(x);
  const responses = await Promise.all([
    as().patch(`/api/matches/${m}`).send({ time: '19:00', reason: 'Primera' }),
    as().patch(`/api/matches/${m}`).send({ time: '20:00', reason: 'Segunda' }),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const moves = (await log(m)).entries.filter((e) => e.action === 'RESCHEDULED');
  expect(moves).toHaveLength(2);
  expect(moves[0].changes!.time.from).toBe('18:00');
  expect(moves[1].changes!.time.from).toBe(moves[0].changes!.time.to);
});
