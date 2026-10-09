/**
 * Sedes y canchas (Módulo 2A, 2026-10-09): CRUD del organizador, cancha en partidos, conflictos
 * entre torneos (duración + margen, medianoche), concurrencia, disponibilidad y compatibilidad.
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
  token = (await registerOrganizer(http, 'Sedes')).token;
  otherToken = (await registerOrganizer(http, 'OtroSedes')).token;
});
afterAll(async () => ctx?.close());

let seq = 0;
/** Torneo activo con dos equipos inscritos (duración opcional). */
async function tournament(durationMinutes?: number) {
  seq++;
  const body: Record<string, unknown> = { name: `Torneo Sedes ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' };
  if (durationMinutes) body.information = { schedule: { durationMinutes } };
  const t = (await as().post('/api/tournaments').send(body).expect(201)).body.id as string;
  const home = (await as().post('/api/teams').send({ name: `Local S${seq}` }).expect(201)).body.id as string;
  const away = (await as().post('/api/teams').send({ name: `Visita S${seq}` }).expect(201)).body.id as string;
  for (const id of [home, away]) await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  return { t, home, away };
}
let round = 0;
const match = (x: { t: string; home: string; away: string }, date: string, time: string, extra: Record<string, unknown> = {}) =>
  as().post('/api/matches').send({ tournamentId: x.t, round: ++round, homeTeamId: x.home, awayTeamId: x.away, date, time, ...extra });
async function venue(fields = ['Cancha 1'], extra: Record<string, unknown> = {}) {
  const v = (await as().post('/api/venues').send({ name: `Deportivo ${++seq}`, address: 'Av. Siempre Viva 742', fields: fields.map((name) => ({ name })), ...extra }).expect(201)).body;
  return { id: v.id as string, fields: v.fields.map((f: { id: string }) => f.id) as string[], name: v.name as string };
}

it('CRUD: sede con canchas, solo del organizador, y compatibilidad con venue de texto', async () => {
  const v = await venue(['Cancha 1', 'Cancha 2']);
  const list = (await as().get('/api/venues').expect(200)).body;
  expect(list.find((x: { id: string }) => x.id === v.id)).toMatchObject({ address: 'Av. Siempre Viva 742', bufferMinutes: 15, fields: [{ name: 'Cancha 1', matches: 0 }, { name: 'Cancha 2' }] });
  expect((await authed(http, otherToken).get('/api/venues').expect(200)).body).toEqual([]);
  await authed(http, otherToken).patch(`/api/venues/${v.id}`).send({ name: 'Mía' }).expect(403);

  // Un partido sin cancha sigue igual (venue libre).
  const x = await tournament();
  const legacy = (await match(x, '2027-01-10', '10:00', { venue: 'Campo del barrio' }).expect(201)).body;
  expect(legacy).toMatchObject({ venue: 'Campo del barrio', fieldId: null });

  // Con cancha, venue se deriva y sigue al renombrar.
  const withField = (await match(x, '2027-01-10', '12:00', { fieldId: v.fields[0] }).expect(201)).body;
  expect(withField).toMatchObject({ fieldId: v.fields[0], venueId: v.id, venue: `${v.name} · Cancha 1` });
  await as().patch(`/api/venues/${v.id}/fields/${v.fields[0]}`).send({ name: 'Cancha Principal' }).expect(200);
  expect((await request(http).get(`/api/matches/${withField.id}`).expect(200)).body.venue).toBe(`${v.name} · Cancha Principal`);
  // La cancha de otro organizador no se puede asignar.
  const foreign = (await authed(http, otherToken).post('/api/venues').send({ name: 'Ajena', fields: [{ name: 'A' }] }).expect(201)).body;
  await match(x, '2027-01-11', '12:00', { fieldId: foreign.fields[0].id }).expect(400);
});

it('conflictos entre torneos del organizador con duración + margen; cancelados y pospuestos no reservan', async () => {
  const v = await venue();
  const a = await tournament(90);
  const b = await tournament(); // 60 por defecto
  const first = (await match(a, '2027-02-06', '16:00', { fieldId: v.fields[0] }).expect(201)).body;
  // A ocupa 16:00–17:30 + 15 = 17:45. B a las 17:40 choca; a las 17:45 no.
  const clash = await match(b, '2027-02-06', '17:40', { fieldId: v.fields[0] }).expect(409);
  expect(clash.body).toMatchObject({ error: 'FIELD_CONFLICT', conflicts: [{ matchId: first.id, tournamentId: a.t, time: '16:00', endTime: '17:30' }] });
  expect(clash.body.message).toMatch(/Conflicto de horario/);
  const second = (await match(b, '2027-02-06', '17:45', { fieldId: v.fields[0] }).expect(201)).body;

  // Cambiar la hora a una ocupada se rechaza sin modificar el partido.
  await as().patch(`/api/matches/${second.id}`).send({ reason: 'Motivo de prueba', time: '17:00' }).expect(409);
  expect((await request(http).get(`/api/matches/${second.id}`).expect(200)).body.time).toBe('17:45');

  // Cancelado o pospuesto: libera la cancha; al reprogramarlo vuelve a validarse.
  await as().patch(`/api/matches/${first.id}`).send({ reason: 'Motivo de prueba', status: 'CANCELLED' }).expect(200);
  await as().patch(`/api/matches/${second.id}`).send({ reason: 'Motivo de prueba', time: '16:30' }).expect(200);
  await as().patch(`/api/matches/${first.id}`).send({ reason: 'Motivo de prueba', status: 'SCHEDULED' }).expect(409);
  await as().patch(`/api/matches/${second.id}`).send({ reason: 'Motivo de prueba', status: 'POSTPONED' }).expect(200);
  await as().patch(`/api/matches/${first.id}`).send({ reason: 'Motivo de prueba', status: 'SCHEDULED' }).expect(200);

  // Más duración en un torneo que haría chocar sus partidos: rechazada sin cambios.
  await as().patch(`/api/matches/${second.id}`).send({ reason: 'Motivo de prueba', status: 'SCHEDULED', time: '17:45' }).expect(200);
  const longer = await as().patch(`/api/tournaments/${a.t}`).send({ information: { schedule: { durationMinutes: 100 } } }).expect(409);
  expect(longer.body.error).toBe('FIELD_CONFLICT');
  // Más margen en la sede, igual.
  await as().patch(`/api/venues/${v.id}`).send({ bufferMinutes: 20 }).expect(409);
  await as().patch(`/api/venues/${v.id}`).send({ bufferMinutes: 10 }).expect(200);
});

it('medianoche: un partido que cruza el día choca con el del día siguiente', async () => {
  const v = await venue();
  const x = await tournament();
  await match(x, '2027-03-06', '23:30', { fieldId: v.fields[0] }).expect(201);
  await match(x, '2027-03-07', '00:30', { fieldId: v.fields[0] }).expect(409);
  await match(x, '2027-03-07', '00:45', { fieldId: v.fields[0] }).expect(201);
  const check = (await as().get(`/api/venues/check?fieldId=${v.fields[0]}&tournamentId=${x.t}&date=2027-03-07&time=00:00`).expect(200)).body;
  expect(check.conflicts).toHaveLength(2);
});

it('disponibilidad: advierte sin bloquear', async () => {
  const v = await venue();
  await as()
    .patch(`/api/venues/${v.id}/fields/${v.fields[0]}`)
    .send({ availability: { weekly: [{ day: 6, from: '08:00', to: '14:00' }], closedDates: ['2027-04-10'] } })
    .expect(200);
  const x = await tournament();
  const check = (await as().get(`/api/venues/check?fieldId=${v.fields[0]}&tournamentId=${x.t}&date=2027-04-03&time=13:30`).expect(200)).body;
  expect(check).toMatchObject({ conflicts: [], end: '14:30' });
  expect(check.warnings).toHaveLength(1);
  const saved = (await match(x, '2027-04-10', '10:00', { fieldId: v.fields[0] }).expect(201)).body;
  expect(saved.warnings).toEqual(['La cancha no está disponible el 2027-04-10']);
  await as().patch(`/api/venues/${v.id}/fields/${v.fields[0]}`).send({ availability: { weekly: [{ day: 6, from: '14:00', to: '08:00' }], closedDates: [] } }).expect(400);
});

it('desactivar/eliminar con partidos: conserva referencias y evita asignaciones inválidas', async () => {
  const v = await venue(['Uno', 'Dos']);
  const x = await tournament();
  const m = (await match(x, '2027-05-01', '10:00', { fieldId: v.fields[0] }).expect(201)).body;
  // Con un partido pendiente no se desactiva ni elimina.
  await as().patch(`/api/venues/${v.id}/fields/${v.fields[0]}`).send({ active: false }).expect(409);
  await as().delete(`/api/venues/${v.id}/fields/${v.fields[0]}`).expect(409);
  // Jugado: se puede eliminar, pero se archiva (la referencia sigue resolviendo).
  await as().put(`/api/matches/${m.id}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [] }).expect(200);
  const removed = (await as().delete(`/api/venues/${v.id}/fields/${v.fields[0]}`).expect(200)).body;
  expect(removed.archived).toBe(true);
  expect(removed.venue.fields.map((f: { name: string }) => f.name)).toEqual(['Dos']);
  expect((await request(http).get(`/api/matches/${m.id}`).expect(200)).body).toMatchObject({ fieldId: v.fields[0], venue: `${v.name} · Uno` });
  // No se puede asignar a otro partido; el partido jugado sigue editable sin cambiar de cancha.
  await match(x, '2027-05-02', '10:00', { fieldId: v.fields[0] }).expect(409);
  // Sin partidos: se borra de verdad.
  expect((await as().delete(`/api/venues/${v.id}/fields/${v.fields[1]}`).expect(200)).body.archived).toBe(false);
  // Desactivar una cancha libre: deja de poder asignarse.
  await as().post(`/api/venues/${v.id}/fields`).send({ name: 'Tres' }).expect(201);
  const tres = (await as().get('/api/venues').expect(200)).body.find((y: { id: string }) => y.id === v.id).fields[0].id;
  await as().patch(`/api/venues/${v.id}/fields/${tres}`).send({ active: false }).expect(200);
  await match(x, '2027-05-03', '10:00', { fieldId: tres }).expect(409);
});

it('regenerar el calendario no libera canchas en silencio', async () => {
  const v = await venue();
  const x = await tournament();
  await match(x, '2027-06-05', '10:00', { fieldId: v.fields[0] }).expect(201);
  const r = await as().post(`/api/tournaments/${x.t}/schedule`).send({ startDate: '2027-06-12', replaceExisting: true }).expect(409);
  expect(r.body).toMatchObject({ error: 'ASSIGNMENTS_TO_RELEASE', assigned: 1 });
  await as().post(`/api/tournaments/${x.t}/schedule`).send({ startDate: '2027-06-12', replaceExisting: true, releaseAssignments: true }).expect(201);
  expect((await as().get('/api/venues').expect(200)).body.find((y: { id: string }) => y.id === v.id).fields[0].matches).toBe(0);
});

it('carrera: dos torneos asignan la misma cancha y hora a la vez; solo uno lo logra', async () => {
  const v = await venue();
  const a = await tournament();
  const b = await tournament();
  const responses = await Promise.all([
    match(a, '2027-07-03', '10:00', { fieldId: v.fields[0] }),
    match(b, '2027-07-03', '10:30', { fieldId: v.fields[0] }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect((await as().get('/api/venues').expect(200)).body.find((y: { id: string }) => y.id === v.id).fields[0].matches).toBe(1);
});

it('cruce de eliminatoria creado a mano: se crea sin cancha y después se le asigna, con validación de conflictos', async () => {
  seq++;
  const t = (await as().post('/api/tournaments').send({ name: `Copa Sedes ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', settings: { system: 'KNOCKOUT' } }).expect(201)).body.id as string;
  const ids: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const id = (await as().post('/api/teams').send({ name: `Copa ${seq}-${i}` }).expect(201)).body.id as string;
    await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    ids.push(id);
  }
  await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 4 }).expect(201);
  await as().post(`/api/tournaments/${t}/phases/0/ties`).send({ round: 0, homeTeamId: ids[0], awayTeamId: ids[1], legs: [{ date: '2027-08-07', time: '18:00' }] }).expect(201);
  const tieMatch = ((await request(http).get(`/api/tournaments/${t}/matches`).expect(200)).body as { id: string; fieldId: string | null; stage: { tie: unknown } | null }[]).find((m) => m.stage?.tie)!;
  expect(tieMatch.fieldId).toBeNull();

  // Otro torneo ya ocupa la cancha a esa hora: asignarla al cruce choca.
  const v = await venue();
  const other = await tournament();
  await match(other, '2027-08-07', '17:30', { fieldId: v.fields[0] }).expect(201);
  const clash = await as().patch(`/api/matches/${tieMatch.id}`).send({ reason: 'Motivo de prueba', fieldId: v.fields[0] }).expect(409);
  expect(clash.body.error).toBe('FIELD_CONFLICT');
  expect((await request(http).get(`/api/matches/${tieMatch.id}`).expect(200)).body.fieldId).toBeNull();

  // En otro horario sí, y el cruce queda con su cancha.
  const ok = (await as().patch(`/api/matches/${tieMatch.id}`).send({ reason: 'Motivo de prueba', fieldId: v.fields[0], time: '20:00' }).expect(200)).body;
  expect(ok).toMatchObject({ fieldId: v.fields[0], venue: `${v.name} · Cancha 1`, time: '20:00' });
});
