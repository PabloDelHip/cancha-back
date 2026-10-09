import request from 'supertest';
import { getModelToken } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { Tournament } from '../src/modules/tournaments/schemas/tournament.schema.js';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let owner: Awaited<ReturnType<typeof registerOrganizer>>;
let tournaments: Model<Tournament>;
const input = { name: 'Liga completa', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01' };

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  owner = await registerOrganizer(http, 'Cobertura');
  tournaments = ctx.app.get(getModelToken(Tournament.name));
});
afterAll(async () => { if (ctx) await ctx.close(); });

it('rechaza crear o activar cobertura parcial y seleccionar equipos seguidos', async () => {
  const client = authed(http, owner.token);
  await client.post('/api/tournaments').send({ ...input, dataCoverage: 'PARTIAL' }).expect(400);
  const { body: tournament } = await client.post('/api/tournaments').send(input).expect(201);
  expect(tournament).toMatchObject({ dataCoverage: 'FULL', trackedTeamIds: [] });
  await client.patch(`/api/tournaments/${tournament.id}`).send({ dataCoverage: 'PARTIAL' }).expect(400);
  await client.patch(`/api/tournaments/${tournament.id}`).send({ trackedTeamIds: [new Types.ObjectId().toHexString()] }).expect(400);
  await request(http).get(`/api/tournaments/${tournament.id}/tracked-summary`).expect(404);
});

it('los documentos antiguos se leen completos y conservan sus datos al editar', async () => {
  const client = authed(http, owner.token);
  const { body: tournament } = await client.post('/api/tournaments').send(input).expect(201);
  const id = new Types.ObjectId(tournament.id);
  await tournaments.collection.updateOne({ _id: id }, { $set: { dataCoverage: 'PARTIAL', trackedTeamIds: [new Types.ObjectId()] } });
  const { body: loaded } = await request(http).get(`/api/tournaments/${tournament.id}`).expect(200);
  expect(loaded).toMatchObject({ name: input.name, dataCoverage: 'FULL', trackedTeamIds: [] });
  for (const view of ['standings', 'top-scorers', 'structure']) {
    await request(http).get(`/api/tournaments/${tournament.id}/${view}`).expect(200);
  }
  await client.patch(`/api/tournaments/${tournament.id}`).send({ name: 'Liga actualizada' }).expect(200);
  expect(await tournaments.findById(id).lean()).toMatchObject({ name: 'Liga actualizada', dataCoverage: 'FULL', trackedTeamIds: [] });
});
