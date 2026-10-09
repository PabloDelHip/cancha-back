/**
 * Árbitros (Módulo 2B, 2026-10-09): CRUD del organizador, roles, conflictos entre torneos con la
 * ocupación de 2A, revalidaciones, ausencias y sustitutos, historial, privacidad y concurrencia.
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
  token = (await registerOrganizer(http, 'Arbitros')).token;
  otherToken = (await registerOrganizer(http, 'OtroArbitros')).token;
});
afterAll(async () => ctx?.close());

let seq = 0;
async function tournament(durationMinutes?: number) {
  seq++;
  const body: Record<string, unknown> = { name: `Torneo Árbitros ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' };
  if (durationMinutes) body.information = { schedule: { durationMinutes } };
  const t = (await as().post('/api/tournaments').send(body).expect(201)).body.id as string;
  const home = (await as().post('/api/teams').send({ name: `Local A${seq}` }).expect(201)).body.id as string;
  const away = (await as().post('/api/teams').send({ name: `Visita A${seq}` }).expect(201)).body.id as string;
  for (const id of [home, away]) await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  return { t, home, away };
}
let round = 0;
const match = async (x: { t: string; home: string; away: string }, date: string, time: string, extra: Record<string, unknown> = {}) =>
  (await as().post('/api/matches').send({ tournamentId: x.t, round: ++round, homeTeamId: x.home, awayTeamId: x.away, date, time, ...extra }).expect(201)).body.id as string;
const referee = async (firstName: string, extra: Record<string, unknown> = {}) =>
  (await as().post('/api/referees').send({ firstName, lastName: `Silbato${++seq}`, phone: '998 123 4567', email: `${firstName.toLowerCase()}${seq}@example.com`, ...extra }).expect(201)).body as { id: string; name: string };
const assign = (m: string, refereeId: string, role = 'CENTRAL') => as().post(`/api/matches/${m}/referees`).send({ refereeId, role });

it('CRUD y privacidad: el organizador ve el contacto; el público solo el nombre del central', async () => {
  const r = await referee('Mario');
  expect((await as().get('/api/referees').expect(200)).body.find((x: { id: string }) => x.id === r.id)).toMatchObject({ phone: '998 123 4567', matches: 0 });
  expect((await authed(http, otherToken).get('/api/referees').expect(200)).body).toEqual([]);
  await authed(http, otherToken).patch(`/api/referees/${r.id}`).send({ firstName: 'X' }).expect(403);

  const x = await tournament();
  const m = await match(x, '2027-01-09', '10:00');
  const assistant = await referee('Ana');
  await assign(m, r.id).expect(201);
  await assign(m, assistant.id, 'ASSISTANT_1').expect(201);
  const pub = (await request(http).get(`/api/matches/${m}`).expect(200)).body;
  expect(pub.centralReferee).toBe(r.name);
  expect(JSON.stringify(pub)).not.toMatch(/998 123 4567|@example\.com/);
  // Renombrar actualiza el nombre público.
  await as().patch(`/api/referees/${r.id}`).send({ firstName: 'Mariano' }).expect(200);
  expect((await request(http).get(`/api/matches/${m}`).expect(200)).body.centralReferee).toMatch(/^Mariano /);
  // Árbitro de otro organizador: no se puede asignar.
  const foreign = (await authed(http, otherToken).post('/api/referees').send({ firstName: 'Ajeno', lastName: 'Z' }).expect(201)).body;
  await assign(m, foreign.id, 'FOURTH').expect(400);
});

it('roles: uno por rol y un rol por árbitro en el partido', async () => {
  const x = await tournament();
  const m = await match(x, '2027-01-16', '10:00');
  const [a, b] = [await referee('Uno'), await referee('Dos')];
  await assign(m, a.id).expect(201);
  expect((await assign(m, b.id).expect(409)).body.message).toMatch(/rol ya tiene/);
  expect((await assign(m, a.id, 'ASSISTANT_1').expect(409)).body.message).toMatch(/otro rol/);
  const view = (await assign(m, b.id, 'SCOREKEEPER').expect(201)).body;
  expect(view.referees.map((r: { role: string; name: string }) => r.role)).toEqual(['CENTRAL', 'SCOREKEEPER']);
});

it('conflictos entre torneos (duración + margen) y revalidación al cambiar horario, estado o duración', async () => {
  const r = await referee('Pedro');
  const a = await tournament(); // 60 + 15
  const b = await tournament();
  const mA = await match(a, '2027-02-06', '18:00');
  const mB = await match(b, '2027-02-06', '19:00');
  await assign(mA, r.id).expect(201);
  const clash = await assign(mB, r.id).expect(409);
  expect(clash.body).toMatchObject({ error: 'REFEREE_CONFLICT', conflicts: [{ matchId: mA, time: '18:00', endTime: '19:00' }] });
  await as().patch(`/api/matches/${mB}`).send({ reason: 'Motivo de prueba', time: '19:15' }).expect(200);
  await assign(mB, r.id).expect(201);

  // Cambiar la hora a una que choca: rechazado sin modificar el partido.
  await as().patch(`/api/matches/${mB}`).send({ reason: 'Motivo de prueba', time: '18:30' }).expect(409);
  expect((await request(http).get(`/api/matches/${mB}`).expect(200)).body.time).toBe('19:15');
  // Pospuesto o cancelado no choca; al reprogramarlo se valida de nuevo.
  await as().patch(`/api/matches/${mA}`).send({ reason: 'Motivo de prueba', status: 'POSTPONED' }).expect(200);
  await as().patch(`/api/matches/${mB}`).send({ reason: 'Motivo de prueba', time: '18:30' }).expect(200);
  await as().patch(`/api/matches/${mA}`).send({ reason: 'Motivo de prueba', status: 'SCHEDULED' }).expect(409);
  await as().patch(`/api/matches/${mA}`).send({ reason: 'Motivo de prueba', status: 'SCHEDULED', date: '2027-02-13' }).expect(200);
  // Más duración en un torneo que haría chocar a su árbitro: rechazada.
  await as().patch(`/api/matches/${mA}`).send({ reason: 'Motivo de prueba', date: '2027-02-06', time: '17:00' }).expect(200);
  await as().patch(`/api/tournaments/${a.t}`).send({ information: { schedule: { durationMinutes: 90 } } }).expect(409);
});

it('el margen es el de la sede del partido: aumentarlo revalida a los árbitros', async () => {
  const r = await referee('Luis');
  const v1 = (await as().post('/api/venues').send({ name: `Sede R${++seq}`, bufferMinutes: 0, fields: [{ name: 'C1' }] }).expect(201)).body;
  const v2 = (await as().post('/api/venues').send({ name: `Sede R${++seq}`, bufferMinutes: 0, fields: [{ name: 'C1' }] }).expect(201)).body;
  const x = await tournament();
  const m1 = await match(x, '2027-03-06', '10:00', { fieldId: v1.fields[0].id });
  const m2 = await match(x, '2027-03-06', '11:00', { fieldId: v2.fields[0].id });
  await assign(m1, r.id).expect(201);
  await assign(m2, r.id, 'ASSISTANT_1').expect(201); // 10:00 + 60 + 0 = 11:00: no choca
  const r2 = await as().patch(`/api/venues/${v1.id}`).send({ bufferMinutes: 10 }).expect(409);
  expect(r2.body.error).toBe('REFEREE_CONFLICT');
});

it('ausencia y sustituto: se conserva la asignación original y el historial', async () => {
  const x = await tournament();
  const m = await match(x, '2027-04-03', '10:00');
  const [titular, suplente] = [await referee('Titular'), await referee('Suplente')];
  const assigned = (await assign(m, titular.id).expect(201)).body.referees[0];
  const after = (await as().post(`/api/matches/${m}/referees/${assigned.id}/absence`).send({ substituteId: suplente.id, note: 'No llegó' }).expect(200)).body;
  expect(after.referees).toMatchObject([
    { refereeId: titular.id, status: 'ABSENT', absenceNote: 'No llegó' },
    { refereeId: suplente.id, status: 'ASSIGNED', role: 'CENTRAL', substituteFor: assigned.id },
  ]);
  expect(after.centralReferee).toBe(suplente.name);
  // La historia no se borra.
  await as().delete(`/api/matches/${m}/referees/${assigned.id}`).expect(409);
  await as().delete(`/api/matches/${m}/referees/${after.referees[1].id}`).expect(409);
  const history = (await as().get(`/api/referees/${titular.id}/matches`).expect(200)).body;
  expect(history).toEqual([expect.objectContaining({ role: 'CENTRAL', status: 'ABSENT', replacedBy: suplente.name, match: expect.objectContaining({ id: m }) })]);
  expect((await as().get(`/api/referees/${suplente.id}/matches`).expect(200)).body[0]).toMatchObject({ substituteFor: titular.name });
});

it('desactivar o eliminar con partidos: bloqueado si hay pendientes; con historia se archiva', async () => {
  const x = await tournament();
  const m = await match(x, '2027-05-01', '10:00');
  const r = await referee('Archivable');
  await assign(m, r.id).expect(201);
  await as().patch(`/api/referees/${r.id}`).send({ active: false }).expect(409);
  await as().delete(`/api/referees/${r.id}`).expect(409);
  await as().put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 0, playerStats: [] }).expect(200);
  expect((await as().delete(`/api/referees/${r.id}`).expect(200)).body.archived).toBe(true);
  expect((await request(http).get(`/api/matches/${m}`).expect(200)).body.centralReferee).toBe(r.name);
  const free = await referee('Libre');
  expect((await as().delete(`/api/referees/${free.id}`).expect(200)).body.archived).toBe(false);
  // Desactivado: no se ofrece ni se asigna.
  const off = await referee('Apagado');
  await as().patch(`/api/referees/${off.id}`).send({ active: false }).expect(200);
  await assign(await match(x, '2027-05-08', '10:00'), off.id).expect(409);
});

it('disponibilidad: avisa sin bloquear; regenerar el calendario pide confirmar', async () => {
  const r = await referee('Sabatino', { availability: { weekly: [{ day: 6, from: '08:00', to: '12:00' }], closedDates: [] } });
  const x = await tournament();
  const m = await match(x, '2027-06-05', '18:00'); // sábado, fuera de horario
  const res = (await assign(m, r.id).expect(201)).body;
  // El aviso habla del horario del árbitro, no de la cancha.
  expect(res.warnings).toEqual(['El partido (18:00–19:00) queda fuera del horario configurado del árbitro para ese día']);
  const options = (await as().get(`/api/matches/${m}/referee-options`).expect(200)).body;
  expect(options.find((o: { id: string }) => o.id === r.id)).toMatchObject({ conflicts: [], warnings: [expect.any(String)] });
  const regen = await as().post(`/api/tournaments/${x.t}/schedule`).send({ startDate: '2027-06-12', replaceExisting: true }).expect(409);
  // El partido solo tiene árbitro (sin cancha): igual hay que confirmarlo.
  expect(regen.body).toMatchObject({ error: 'ASSIGNMENTS_TO_RELEASE', assigned: 1 });
  await as().post(`/api/tournaments/${x.t}/schedule`).send({ startDate: '2027-06-12', replaceExisting: true, releaseAssignments: true }).expect(201);
});

it('carrera: dos torneos asignan al mismo árbitro a la misma hora a la vez; solo uno lo logra', async () => {
  const r = await referee('Concurrente');
  const [a, b] = [await tournament(), await tournament()];
  const [mA, mB] = [await match(a, '2027-07-03', '10:00'), await match(b, '2027-07-03', '10:30')];
  const responses = await Promise.all([assign(mA, r.id), assign(mB, r.id)]);
  expect(responses.map((x) => x.status).sort()).toEqual([201, 409]);
  expect((await as().get('/api/referees').expect(200)).body.find((x: { id: string }) => x.id === r.id).matches).toBe(1);
});
