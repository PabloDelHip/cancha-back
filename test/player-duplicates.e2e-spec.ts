/**
 * Alta de jugadores con revisión de posibles duplicados y apodo (nickname).
 * POST /players y POST /teams/:id/global-roster/players: si hay jugadores con nombre y apellidos
 * iguales o parecidos → 409 PLAYER_POSSIBLE_DUPLICATES con candidatos y NO se crea nada;
 * `confirmNew: true` crea igualmente (puede haber homónimos). El apodo se busca y se muestra, pero
 * no sirve para detectar duplicados. API real.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { TeamAdminsService } from '../src/modules/teams/team-admins.service.js';
import { Player } from '../src/modules/players/schemas/player.schema.js';
import { TeamRoster } from '../src/modules/teams/schemas/team-roster.schema.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type U = Awaited<ReturnType<typeof registerOrganizer>>;
const as = (u: U) => authed(http, u.token);
let players: Model<Player>;
let rosters: Model<TeamRoster>;
let O: U, owner: U, otro: U;
let bigotes: string, dep: string, liga: string;

const create = (body: Record<string, unknown>, by: U = O) => as(by).post('/api/players').send({ position: 'FORWARD', ...body });
const count = () => players.countDocuments();
type Candidate = { player: { id: string; firstName: string; lastName: string; nickname: string | null; age: number | null }; teams: { name: string }[]; tournaments: { name: string }[]; appearances: number; match: string };

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  players = ctx.app.get(getModelToken(Player.name));
  rosters = ctx.app.get(getModelToken(TeamRoster.name));
  [O, owner, otro] = [await registerOrganizer(http, 'Organizador'), await registerOrganizer(http, 'Owner'), await registerOrganizer(http, 'Otro')];
  // José Luis Hernández "Bigotes": en la plantilla de Deportivo y en la Liga, con un partido jugado.
  bigotes = (await create({ firstName: 'José Luis', lastName: 'Hernández López', nickname: 'Bigotes', birthDate: '1995-03-10' }).expect(201)).body.id;
  dep = (await as(O).post('/api/teams').send({ name: 'Deportivo Duplicados' }).expect(201)).body.id;
  const rival = (await as(O).post('/api/teams').send({ name: 'Rival Duplicados' }).expect(201)).body.id;
  await ctx.app.get(TeamAdminsService).assignOwner(dep, owner.id);
  await as(owner).post(`/api/teams/${dep}/global-roster`).send({ playerId: bigotes }).expect(201);
  liga = (await as(O).post('/api/tournaments').send({ name: 'Liga Duplicados', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id;
  for (const t of [dep, rival]) await as(O).post(`/api/tournaments/${liga}/teams/${t}`).expect(201);
  await as(O).put(`/api/tournaments/${liga}/players/${bigotes}`).send({ teamId: dep, startDate: '2027-01-01' }).expect(200);
  const m = (await as(O).post('/api/matches').send({ tournamentId: liga, round: 1, homeTeamId: dep, awayTeamId: rival, date: '2027-01-10', time: '18:00' }).expect(201)).body.id;
  await as(O).put(`/api/matches/${m}/result`).send({ homeScore: 1, awayScore: 0, playerStats: [{ playerId: bigotes, teamId: dep, played: true, goals: 1, assists: 0, yellowCards: 0, redCards: 0 }] }).expect(200);
});
afterAll(async () => ctx?.close());

describe('POST /players con revisión de duplicados', () => {
  it('sin parecidos: se crea a la primera (201)', async () => {
    await create({ firstName: 'Ulises', lastName: 'Zamarripa' }).expect(201);
  });

  it('nombre parecido: 409 con candidatos identificables y NO se crea nada', async () => {
    const before = await count();
    const res = await create({ firstName: 'Jose', lastName: 'Hernandez' }).expect(409);
    expect(res.body).toMatchObject({ code: 'PLAYER_POSSIBLE_DUPLICATES', message: expect.stringMatching(/podrían ser la misma persona/) });
    const [c] = res.body.candidates as Candidate[];
    expect(c.player).toMatchObject({ id: bigotes, firstName: 'José Luis', lastName: 'Hernández López', nickname: 'Bigotes', age: expect.any(Number) });
    expect(c.teams.map((t) => t.name)).toEqual(['Deportivo Duplicados']);
    expect(c.tournaments.map((t) => t.name)).toEqual(['Liga Duplicados']);
    expect(c).toMatchObject({ appearances: 1, match: 'SIMILAR' });
    expect(await count()).toBe(before);
  });

  it('mismo nombre exacto → match EXACT; "ninguno es él" (confirmNew) crea al homónimo', async () => {
    const res = await create({ firstName: 'José Luis', lastName: 'Hernández López' }).expect(409);
    expect(res.body.candidates[0]).toMatchObject({ player: { id: bigotes }, match: 'EXACT' });
    const created = await create({ firstName: 'José Luis', lastName: 'Hernández López', confirmNew: true }).expect(201);
    expect(created.body.id).not.toBe(bigotes);
  });

  it('el apodo NO detecta duplicados por sí solo; una fecha de nacimiento distinta tampoco descarta', async () => {
    await create({ firstName: 'Ramiro', lastName: 'Quintanilla', nickname: 'Bigotes' }).expect(201);
    const res = await create({ firstName: 'José', lastName: 'Hernández', birthDate: '2008-12-12' }).expect(409);
    expect(res.body.candidates.map((c: Candidate) => c.player.id)).toContain(bigotes);
  });

  it('personas distintas no generan aviso (otro apellido aunque difiera en una letra)', async () => {
    await create({ firstName: 'José Luis', lastName: 'Fernández' }).expect(201);
  });

  it('privacidad: los candidatos solo llevan datos públicos (edad, nunca fecha ni creador)', async () => {
    const res = await create({ firstName: 'José', lastName: 'Hernández' }).expect(409);
    const json = JSON.stringify(res.body);
    for (const k of ['birthDate', 'createdBy', 'searchName', 'photoPublicId', 'email', '1995-03-10']) expect(json).not.toContain(k);
  });

  it('validación: sin sesión 401; apodo de más de 40 letras 400; apodo vacío = sin apodo', async () => {
    await api().post('/api/players').send({ firstName: 'Sin', lastName: 'Sesión', position: 'FORWARD' }).expect(401);
    await create({ firstName: 'Largo', lastName: 'Apodo', nickname: 'x'.repeat(41) }).expect(400);
    const r = await create({ firstName: 'Vacío', lastName: 'Apodo', nickname: '   ' }).expect(201);
    expect(r.body.nickname).toBeNull();
  });
});

describe('Alta desde la plantilla del equipo (POST /teams/:id/global-roster/players)', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ firstName: 'José', lastName: 'Hernández', position: 'DEFENDER', requestId: randomUUID(), ...extra });

  it('posible duplicado: 409 con candidatos, sin crear jugador ni plantilla; elegir el existente usa el alta de siempre', async () => {
    const [pBefore, rBefore] = [await count(), await rosters.countDocuments()];
    const res = await as(owner).post(`/api/teams/${dep}/global-roster/players`).send(body()).expect(409);
    expect(res.body.code).toBe('PLAYER_POSSIBLE_DUPLICATES');
    expect(res.body.candidates.map((c: Candidate) => c.player.id)).toContain(bigotes); // también el homónimo creado antes
    expect([await count(), await rosters.countDocuments()]).toEqual([pBefore, rBefore]);
    // "Es este jugador": el ya existente se agrega con POST /global-roster (ya estaba → 200 idempotente).
    await as(owner).post(`/api/teams/${dep}/global-roster`).send({ playerId: bigotes }).expect(200);
  });

  it('confirmNew crea y lo deja en la plantilla; reintentar con el mismo requestId no vuelve a avisar', async () => {
    const b = body({ confirmNew: true });
    const first = await as(owner).post(`/api/teams/${dep}/global-roster/players`).send(b).expect(201);
    expect(first.body).toMatchObject({ status: 'ACTIVE', player: { firstName: 'José', lastName: 'Hernández' } });
    // El reintento (doble clic) devuelve el mismo jugador aunque ahora "se parezca a sí mismo".
    const again = await as(owner).post(`/api/teams/${dep}/global-roster/players`).send({ ...b, confirmNew: undefined }).expect(200);
    expect(again.body.player.id).toBe(first.body.player.id);
  });

  it('quien no administra el equipo recibe 403 antes de ver candidatos', async () => {
    const res = await as(otro).post(`/api/teams/${dep}/global-roster/players`).send(body()).expect(403);
    expect(res.body.candidates).toBeUndefined();
  });
});

describe('Apodo: búsqueda, edición y perfil', () => {
  it('se encuentra por el apodo, con o sin comillas, y combinado con el apellido', async () => {
    for (const q of ['Bigotes', '"Bigotes"', 'bigotes hernandez', '“Bigotes”']) {
      const found = (await api().get('/api/players').query({ search: q, limit: 100 }).expect(200)).body.data as { id: string }[];
      expect(found.map((p) => p.id)).toContain(bigotes);
    }
  });

  it('se edita con PATCH (y deja de encontrarse por el anterior); el perfil público lo muestra', async () => {
    await as(O).patch(`/api/players/${bigotes}`).send({ nickname: 'El Bigotón' }).expect(200);
    const search = async (q: string) => ((await api().get('/api/players').query({ search: q }).expect(200)).body.data as { id: string }[]).map((p) => p.id);
    expect(await search('bigoton')).toContain(bigotes);
    const profile = (await api().get(`/api/players/${bigotes}/profile`).expect(200)).body;
    expect(profile.player).toMatchObject({ firstName: 'José Luis', nickname: 'El Bigotón' });
    expect((await api().get(`/api/players/${bigotes}`).expect(200)).body.nickname).toBe('El Bigotón');
    await as(O).patch(`/api/players/${bigotes}`).send({ nickname: null }).expect(200);
    expect(await search('bigoton')).not.toContain(bigotes);
    await as(O).patch(`/api/players/${bigotes}`).send({ nickname: 'Bigotes' }).expect(200);
  });

  it('solo el custodio edita el apodo (regla de siempre de la ficha)', async () => {
    await as(otro).patch(`/api/players/${bigotes}`).send({ nickname: 'Hackeado' }).expect(403);
  });
});
