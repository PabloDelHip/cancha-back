import request from 'supertest';
import { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { Tournament } from '../src/modules/tournaments/schemas/tournament.schema.js';
import { CloudinaryService } from '../src/modules/media/cloudinary.service.js';

let ctx: TestApp, http: Server;
let owner: Awaited<ReturnType<typeof registerOrganizer>>, other: typeof owner;
let tournaments: Model<Tournament>;
let cloudinary: CloudinaryService;
let richId: string;
const api = () => request(http);
const as = () => authed(http, owner.token);
const input = { name: 'Copa Kikovo', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-04-01', endDate: '2027-06-30' };
const information = {
  season: 'Apertura 2027', description: 'Fútbol y convivencia', state: 'Quintana Roo',
  schedule: { days: [6, 7], startTime: '08:00', endTime: '22:00', durationMinutes: 50, variable: true, notes: 'Puede haber cambios' },
  enrollment: { opensOn: '2027-01-01', paymentMode: 'paid', teamFee: 1500.50, playerFee: 0, instructions: 'Solicita el enlace al organizador' },
  costs: { currency: 'MXN', refereeFee: 300, refereeBilling: 'team', venueFee: 0, adminFee: 50, adminDescription: 'Credenciales', paymentNotes: 'Consultar al organizador' },
  rules: { text: 'Uniforme obligatorio', notes: 'Diez minutos de tolerancia' },
  awards: { champion: '$10,000 y trofeo', runnerUp: 'Trofeo', topScorer: 'Medalla', other: 'Fair play', description: 'Entrega en la final' },
  contact: { name: 'Responsable', phone: '+52 9981234567', email: 'privado@example.com', facebook: 'https://www.facebook.com/kikovo', instagram: 'https://www.instagram.com/kikovo', notes: 'Dato privado', publicFields: ['name', 'phone', 'facebook'] },
};

beforeAll(async () => {
  ctx = await createTestApp(); http = ctx.app.getHttpServer();
  owner = await registerOrganizer(http, 'Condiciones'); other = await registerOrganizer(http, 'Intruso');
  tournaments = ctx.app.get(getModelToken(Tournament.name)); cloudinary = ctx.app.get(CloudinaryService);
});
afterAll(async () => { if (ctx) await ctx.close(); });
afterEach(() => vi.restoreAllMocks());

it('crea información completa junto a grupos y puntuación, sin activar inscripciones', async () => {
  const league = (await as().post('/api/leagues').send({ name: 'Liga Cancún', city: 'Cancún' }).expect(201)).body;
  const res = await as().post('/api/tournaments').send({ ...input, leagueId: league.id, information, registration: { deadline: '2027-03-30', maxTeams: 32 }, settings: { system: 'GROUPS_KNOCKOUT', groupCount: 2, qualifiersPerGroup: 2, pointsForWin: 4, pointsForDraw: 2, pointsForLoss: 0, knockoutLegs: 2, knockoutTiebreak: 'EXTRA_TIME' } }).expect(201);
  richId = res.body.id;
  expect(res.body).toMatchObject({ leagueId: league.id, information, registration: { deadline: '2027-03-30', maxTeams: 32, enabled: false }, settings: { system: 'GROUPS_KNOCKOUT', pointsForWin: 4, knockoutLegs: 2 } });
  expect(res.body.information.city).toBeNull(); // No copia ni duplica la ciudad de la liga.
  const stored = await tournaments.findById(richId).lean();
  expect(typeof stored!.information.enrollment.teamFee).toBe('number');
});

it('solo publica contactos seleccionados; el organizador conserva los demás al editar', async () => {
  const publicDoc = (await api().get(`/api/tournaments/${richId}`).expect(200)).body;
  for (const field of ['email', 'instagram', 'notes']) expect(publicDoc.information.contact).not.toHaveProperty(field);
  expect(publicDoc.information.contact).toMatchObject({ name: 'Responsable', phone: '+52 9981234567' });
  expect(JSON.stringify((await api().get('/api/tournaments?limit=100').expect(200)).body)).not.toContain('privado@example.com');
  expect((await as().get(`/api/admin/tournaments/${richId}`).expect(200)).body.information.contact.email).toBe('privado@example.com');
  expect(JSON.stringify((await as().get('/api/admin/tournaments?limit=100').expect(200)).body)).toContain('privado@example.com');
  await api().get(`/api/admin/tournaments/${richId}`).expect(401);
  await authed(http, other.token).get(`/api/admin/tournaments/${richId}`).expect(403);
  const res = await as().patch(`/api/tournaments/${richId}`).send({ information: { awards: { champion: 'Trofeo nuevo' }, contact: { publicFields: [] } } }).expect(200);
  expect(res.body.information.contact.email).toBe('privado@example.com');
  expect(res.body.information.awards).toMatchObject({ champion: 'Trofeo nuevo', runnerUp: 'Trofeo' });
  expect(res.body.information.schedule.days).toEqual([6, 7]);
  expect(res.body.settings.system).toBe('GROUPS_KNOCKOUT');
  expect((await api().get(`/api/tournaments/${richId}`).expect(200)).body.information.contact).not.toHaveProperty('name');
});

it('valida fechas y horarios contra los valores vigentes en ambas pantallas de inscripción', async () => {
  await as().patch(`/api/tournaments/${richId}`).send({ information: { schedule: { endTime: '07:00' } } }).expect(400);
  await as().patch(`/api/tournaments/${richId}`).send({ information: { enrollment: { opensOn: '2027-04-01' } } }).expect(400);
  await as().patch(`/api/tournaments/${richId}/registration`).send({ deadline: '2026-12-01' }).expect(400);
  await as().patch(`/api/tournaments/${richId}/registration`).send({ enabled: true, minPlayers: 5, maxPlayers: 20 }).expect(200);
  await as().patch(`/api/tournaments/${richId}`).send({ registration: { maxTeams: 20 } }).expect(200);
  expect((await as().get(`/api/tournaments/${richId}/registration`).expect(200)).body.registration).toMatchObject({ enabled: true, minPlayers: 5, maxPlayers: 20, maxTeams: 20, deadline: '2027-03-30' });
});

it.each([
  { costs: { refereeFee: -1 } }, { enrollment: { teamFee: '100' } }, { costs: { venueFee: 1.234 } },
  { costs: { adminFee: 1000000001 } }, { costs: { currency: 'pesos' } }, { costs: { currency: null } },
  { schedule: { days: [6, 6] } }, { schedule: { days: [8] } }, { schedule: { days: null } },
  { schedule: { startTime: '25:00' } }, { schedule: { durationMinutes: 0 } }, { schedule: { variable: null } },
  { enrollment: { opensOn: '2027-02-30' } }, { enrollment: { paymentMode: 'free', teamFee: 10 } },
  { contact: { instagram: 'javascript:alert(1)' } }, { contact: { email: 'incorrecto' } },
  { contact: { publicFields: ['email', 'unknown'] } }, { contact: null },
])('rechaza datos inválidos: %j', async (information) => {
  await as().post('/api/tournaments').send({ ...input, information }).expect(400);
});

it('los horarios informativos no restringen partidos ni el generador; conserva inicio y finalización', async () => {
  const t = (await as().post('/api/tournaments').send({ ...input, information: { schedule: { days: [6, 7], startTime: '08:00', endTime: '22:00', durationMinutes: 50 } } }).expect(201)).body;
  for (const name of ['Equipo uno', 'Equipo dos']) {
    const team = (await as().post('/api/teams').send({ name }).expect(201)).body;
    await as().post(`/api/tournaments/${t.id}/teams/${team.id}`).expect(201);
  }
  await as().post(`/api/tournaments/${t.id}/schedule`).send({ startDate: '2027-04-05', firstKickoff: '23:00' }).expect(201);
  const matches = (await api().get(`/api/tournaments/${t.id}/matches`).expect(200)).body;
  expect(matches).toHaveLength(1); expect(matches[0]).toMatchObject({ date: '2027-04-05', time: '23:00' });
  await as().post(`/api/tournaments/${t.id}/start`).expect(200);
  await as().post(`/api/tournaments/${t.id}/finish`).send({ allowPendingMatches: true }).expect(200);
  await as().patch(`/api/tournaments/${t.id}`).send({ information: { season: 'Cambio' } }).expect(409);
  await as().delete(`/api/tournaments/${t.id}/logo`).expect(409);
});

it('lee y edita documentos antiguos sin los nuevos campos', async () => {
  const t = (await as().post('/api/tournaments').send(input).expect(201)).body;
  await tournaments.collection.updateOne({ _id: new Types.ObjectId(t.id) }, { $unset: { information: '', logoUrl: '' } });
  await api().get(`/api/tournaments/${t.id}`).expect(200);
  await as().patch(`/api/tournaments/${t.id}`).send({ information: { rules: { text: 'Reglamento' } } }).expect(200);
  expect((await as().get(`/api/admin/tournaments/${t.id}`).expect(200)).body.information).toMatchObject({ rules: { text: 'Reglamento' }, costs: { currency: 'MXN' } });
});

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
it('reutiliza Cloudinary para el logo, valida contenido y protege propiedad e identificadores internos', async () => {
  const t = (await as().post('/api/tournaments').send(input).expect(201)).body;
  const upload = vi.spyOn(cloudinary, 'upload').mockResolvedValue({ url: 'https://res.cloudinary.com/test/image/upload/logo.png', publicId: 'kikovo/tournaments/logo1' });
  const destroy = vi.spyOn(cloudinary, 'destroy').mockResolvedValue();
  await authed(http, other.token).put(`/api/tournaments/${t.id}/logo`).attach('file', png, 'logo.png').expect(403);
  await as().put(`/api/tournaments/${t.id}/logo`).attach('file', Buffer.from('<script/>'), { filename: 'fake.png', contentType: 'image/png' }).expect(415);
  await as().put(`/api/tournaments/${t.id}/logo`).attach('file', Buffer.from('%PDF-1.7'), { filename: 'reglamento.pdf', contentType: 'application/pdf' }).expect(415);
  expect(upload).not.toHaveBeenCalled();
  const res = await as().put(`/api/tournaments/${t.id}/logo`).attach('file', png, 'logo.png').expect(200);
  expect(res.body.logoUrl).toContain('https://res.cloudinary.com'); expect(res.body).not.toHaveProperty('logoPublicId');
  await as().delete(`/api/tournaments/${t.id}/logo`).expect(200);
  expect(destroy).toHaveBeenCalledWith('kikovo/tournaments/logo1');
  expect((await api().get(`/api/tournaments/${t.id}`).expect(200)).body.logoUrl).toBeNull();
});

it('una subida que termina después de finalizar no cambia el historial y limpia el archivo nuevo', async () => {
  const t = (await as().post('/api/tournaments').send(input).expect(201)).body;
  vi.spyOn(cloudinary, 'upload').mockImplementation(async () => {
    await tournaments.collection.updateOne({ _id: new Types.ObjectId(t.id) }, { $set: { status: 'FINISHED' } });
    return { url: 'https://example.com/logo.png', publicId: 'discarded' };
  });
  const destroy = vi.spyOn(cloudinary, 'destroy').mockResolvedValue();
  await as().put(`/api/tournaments/${t.id}/logo`).attach('file', png, 'logo.png').expect(409);
  expect(destroy).toHaveBeenCalledWith('discarded');
  expect((await api().get(`/api/tournaments/${t.id}`).expect(200)).body.logoUrl).toBeNull();
});
