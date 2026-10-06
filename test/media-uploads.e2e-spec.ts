/**
 * Imágenes en Cloudinary: foto de jugador (PUT/DELETE /players/:id/photo) y logo de equipo
 * (PUT/DELETE /teams/:id/logo). MongoDB solo guarda URL + public_id (interno). Permisos: los mismos
 * que editar la ficha. Cloudinary se simula espiando CloudinaryService (sin red); su cliente HTTP
 * se prueba en src/modules/media/cloudinary.service.spec.ts.
 */
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { CloudinaryService } from '../src/modules/media/cloudinary.service.js';
import { MAX_IMAGE_BYTES } from '../src/modules/media/image-upload.js';
import { TeamAdminsService } from '../src/modules/teams/team-admins.service.js';
import { Player } from '../src/modules/players/schemas/player.schema.js';
import { Team } from '../src/modules/teams/schemas/team.schema.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type U = Awaited<ReturnType<typeof registerOrganizer>>;
const as = (u: U) => authed(http, u.token);
let cloudinary: CloudinaryService;
let players: Model<Player>;
let teams: Model<Team>;
let admins: TeamAdminsService;
let A: U, B: U, owner: U, manager: U;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
let uploads = 0;
let upload: MockInstance<CloudinaryService['upload']>;
let destroy: MockInstance<CloudinaryService['destroy']>;
const URL_RE = /^https:\/\/res\.cloudinary\.com\/test-cloud\/image\/upload\/f_auto,q_auto\/v\d+\/kikovo\/(players|teams)\/img\d+$/;

const send = (req: request.Test, buf: Buffer = PNG, type = 'image/png', name = 'foto.png') => req.attach('file', buf, { filename: name, contentType: type });
const newPlayer = async (by: U) =>
  (await as(by).post('/api/players').send({ confirmNew: true, firstName: 'Ana', lastName: `Foto ${Date.now()}${Math.random()}`, position: 'FORWARD', birthDate: '2005-05-05' }).expect(201)).body.id as string;
const newTeam = async (by: U) => (await as(by).post('/api/teams').send({ name: `Equipo Logo ${Date.now()}${Math.random()}` }).expect(201)).body.id as string;
const stored = async (id: string) => (await players.findById(id).lean())!;

beforeAll(async () => {
  ctx = await createTestApp({ CLOUDINARY_CLOUD_NAME: 'test-cloud', CLOUDINARY_API_KEY: 'test-key', CLOUDINARY_API_SECRET: 'test-secret' });
  http = ctx.app.getHttpServer();
  cloudinary = ctx.app.get(CloudinaryService);
  players = ctx.app.get(getModelToken(Player.name));
  teams = ctx.app.get(getModelToken(Team.name));
  admins = ctx.app.get(TeamAdminsService);
  [A, B, owner, manager] = [await registerOrganizer(http, 'Custodio'), await registerOrganizer(http, 'Otro'), await registerOrganizer(http, 'Owner'), await registerOrganizer(http, 'Manager')];
});
beforeEach(() => {
  upload = vi.spyOn(cloudinary, 'upload').mockImplementation(async (_file, preset) => {
    const publicId = `${preset.folder}/img${++uploads}`;
    return { publicId, url: cloudinary.deliveryUrl(publicId, 1700000000 + uploads, preset.delivery) };
  });
  destroy = vi.spyOn(cloudinary, 'destroy').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => ctx?.close());

describe('Foto de jugador', () => {
  it('el custodio sube: URL optimizada en photoUrl, public_id guardado pero nunca expuesto', async () => {
    const id = await newPlayer(A);
    const res = await send(as(A).put(`/api/players/${id}/photo`)).expect(200);
    expect(res.body.photoUrl).toMatch(URL_RE);
    expect(res.body).not.toHaveProperty('photoPublicId');
    expect(upload).toHaveBeenCalledTimes(1);
    const [file, preset] = upload.mock.calls[0];
    expect(preset).toMatchObject({ folder: 'kikovo/players', incoming: 'c_limit,w_800,h_800', delivery: 'f_auto,q_auto' });
    expect((file as { mimetype: string }).mimetype).toBe('image/png');
    expect((await stored(id)).photoPublicId).toMatch(/^kikovo\/players\/img\d+$/);
    // Lecturas públicas: la URL sí, el public_id no.
    for (const path of [`/api/players/${id}`, `/api/players/${id}/profile`, `/api/players?search=ana`]) {
      const body = JSON.stringify((await api().get(path).expect(200)).body);
      expect(body).not.toContain('photoPublicId');
      expect(body).not.toContain('kikovo/players/img"');
    }
  });

  it('reemplazar borra la anterior de Cloudinary; quitar la borra y deja photoUrl en null', async () => {
    const id = await newPlayer(A);
    await send(as(A).put(`/api/players/${id}/photo`)).expect(200);
    const first = (await stored(id)).photoPublicId;
    const res = await send(as(A).put(`/api/players/${id}/photo`), JPG, 'image/jpeg', 'nueva.jpg').expect(200);
    expect(destroy).toHaveBeenCalledWith(first);
    expect((await stored(id)).photoPublicId).not.toBe(first);
    expect(res.body.photoUrl).toMatch(URL_RE);
    const second = (await stored(id)).photoPublicId;
    const del = await as(A).delete(`/api/players/${id}/photo`).expect(200);
    expect(del.body.photoUrl).toBeNull();
    expect(destroy).toHaveBeenLastCalledWith(second);
    expect((await stored(id)).photoPublicId).toBeNull();
  });

  it('primera subida sobre una URL externa antigua (datos previos): no intenta borrar nada que no sea nuestro', async () => {
    const id = await newPlayer(A);
    await players.updateOne({ _id: id }, { $set: { photoUrl: 'https://example.com/a.jpg' } });
    destroy.mockClear();
    await send(as(A).put(`/api/players/${id}/photo`)).expect(200);
    expect(destroy).toHaveBeenCalledWith(null); // destroy(null) no llama a Cloudinary (ver spec unitaria)
  });

  it('la URL nunca la pone el cliente: PATCH/POST con photoUrl → 400; PATCH photoUrl: null quita y borra de Cloudinary', async () => {
    const id = await newPlayer(A);
    await send(as(A).put(`/api/players/${id}/photo`)).expect(200);
    const pid = (await stored(id)).photoPublicId;
    destroy.mockClear(); // la primera subida llamó destroy(null) (no había imagen anterior)
    const bad = await as(A).patch(`/api/players/${id}`).send({ photoUrl: 'https://example.com/b.jpg' }).expect(400);
    expect(JSON.stringify(bad.body.message)).toContain('PUT /players/:id/photo');
    await as(A).post('/api/players').send({ confirmNew: true, firstName: 'X', lastName: 'Y', position: 'FORWARD', photoUrl: 'https://example.com/c.jpg' }).expect(400);
    expect((await stored(id)).photoPublicId).toBe(pid); // nada cambió
    expect(destroy).not.toHaveBeenCalled();
    const res = await as(A).patch(`/api/players/${id}`).send({ photoUrl: null }).expect(200);
    expect(res.body.photoUrl).toBeNull();
    expect(destroy).toHaveBeenCalledWith(pid);
    expect((await stored(id)).photoPublicId).toBeNull();
    // Un PATCH que no toca la foto no borra nada.
    await send(as(A).put(`/api/players/${id}/photo`)).expect(200);
    destroy.mockClear();
    await as(A).patch(`/api/players/${id}`).send({ position: 'DEFENDER' }).expect(200);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('permisos de siempre: otro usuario 403, sin sesión 401, jugador inexistente 404; nunca se sube nada', async () => {
    const id = await newPlayer(A);
    await send(as(B).put(`/api/players/${id}/photo`)).expect(403);
    await as(B).delete(`/api/players/${id}/photo`).expect(403);
    await send(api().put(`/api/players/${id}/photo`)).expect(401);
    await send(as(A).put('/api/players/000000000000000000000000/photo')).expect(404);
    await send(as(A).put('/api/players/no-es-id/photo')).expect(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it('validación: sin archivo 400; tipo declarado no imagen 415; contenido falso 415; SVG 415; > 5 MB 413', async () => {
    const id = await newPlayer(A);
    await as(A).put(`/api/players/${id}/photo`).expect(400);
    await send(as(A).put(`/api/players/${id}/photo`), Buffer.from('hola'), 'text/plain', 'a.txt').expect(415);
    await send(as(A).put(`/api/players/${id}/photo`), Buffer.from('esto no es un png de verdad, solo texto'), 'image/png', 'falso.png').expect(415);
    await send(as(A).put(`/api/players/${id}/photo`), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'x.svg').expect(415);
    await send(as(A).put(`/api/players/${id}/photo`), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]), 'image/png', 'enorme.png').expect(413);
    await as(A).put(`/api/players/${id}/photo`).attach('foto', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(400); // campo equivocado
    expect(upload).not.toHaveBeenCalled();
    expect((await stored(id)).photoUrl).toBeNull();
  });

  it('si Cloudinary falla: 502 y la ficha queda como estaba', async () => {
    const id = await newPlayer(A);
    await send(as(A).put(`/api/players/${id}/photo`)).expect(200);
    const before = (await stored(id)).photoUrl;
    upload.mockRejectedValueOnce(new (await import('@nestjs/common')).BadGatewayException('No se pudo subir la imagen. Inténtalo de nuevo.'));
    const res = await send(as(A).put(`/api/players/${id}/photo`)).expect(502);
    expect(res.body.message).toBe('No se pudo subir la imagen. Inténtalo de nuevo.');
    expect((await stored(id)).photoUrl).toBe(before);
  });

  it('dos subidas simultáneas: queda una, y se borran exactamente las reemplazadas (sin huérfanas)', async () => {
    const id = await newPlayer(A);
    await send(as(A).put(`/api/players/${id}/photo`)).expect(200);
    const original = (await stored(id)).photoPublicId;
    destroy.mockClear();
    upload.mockClear();
    const res = await Promise.all([1, 2, 3].map(() => send(as(A).put(`/api/players/${id}/photo`))));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const uploaded = (await Promise.all(upload.mock.results.map((r) => r.value as Promise<{ publicId: string }>))).map((x) => x.publicId);
    const final = (await stored(id)).photoPublicId!;
    const destroyed = destroy.mock.calls.map((c) => c[0] as string).sort();
    expect(uploaded).toContain(final);
    expect(destroyed).toEqual([original, ...uploaded.filter((p) => p !== final)].sort());
  });

  it('borrar el jugador (sin historia) borra su foto de Cloudinary', async () => {
    const id = await newPlayer(A);
    await send(as(A).put(`/api/players/${id}/photo`)).expect(200);
    const pid = (await stored(id)).photoPublicId;
    await as(A).delete(`/api/players/${id}`).expect(204);
    expect(destroy).toHaveBeenCalledWith(pid);
  });
});

describe('Logo de equipo', () => {
  let dep: string;
  beforeAll(async () => {
    dep = await newTeam(A); // A lo registró (custodio)…
    await admins.assignOwner(dep, owner.id); // …pero tiene OWNER: la custodia ya no aplica
    await as(owner).post(`/api/teams/${dep}/managers`).send({ userId: manager.id }).expect(201);
  });
  const logoId = async (id: string) => (await teams.findById(id).lean())!.logoPublicId;

  it('OWNER sube (preset de logo, 512 px); MANAGER reemplaza (borra el anterior); public_id nunca expuesto', async () => {
    const r1 = await send(as(owner).put(`/api/teams/${dep}/logo`)).expect(200);
    expect(r1.body.logoUrl).toMatch(URL_RE);
    expect(r1.body).not.toHaveProperty('logoPublicId');
    expect(upload.mock.calls[0][1]).toMatchObject({ folder: 'kikovo/teams', incoming: 'c_limit,w_512,h_512', delivery: 'f_auto,q_auto' });
    const first = await logoId(dep);
    await send(as(manager).put(`/api/teams/${dep}/logo`), JPG, 'image/jpeg', 'logo.jpg').expect(200);
    expect(destroy).toHaveBeenCalledWith(first);
    for (const path of [`/api/teams/${dep}`, `/api/teams/${dep}/profile`, '/api/teams?limit=100']) {
      expect(JSON.stringify((await api().get(path).expect(200)).body)).not.toContain('logoPublicId');
    }
    const profile = (await api().get(`/api/teams/${dep}/profile`).expect(200)).body;
    expect(profile.team.logoUrl).toMatch(URL_RE);
  });

  it('permisos de siempre: creador con OWNER existente, otro usuario → 403; sin sesión 401', async () => {
    await send(as(A).put(`/api/teams/${dep}/logo`)).expect(403);
    await send(as(B).put(`/api/teams/${dep}/logo`)).expect(403);
    await as(B).delete(`/api/teams/${dep}/logo`).expect(403);
    await send(api().put(`/api/teams/${dep}/logo`)).expect(401);
    expect(upload).not.toHaveBeenCalled();
  });

  it('custodio de un equipo SIN OWNER puede (mismas reglas que editar la ficha)', async () => {
    const t = await newTeam(B);
    await send(as(B).put(`/api/teams/${t}/logo`)).expect(200);
    await send(as(A).put(`/api/teams/${t}/logo`)).expect(403);
  });

  it('quitar el logo lo borra de Cloudinary; PATCH logoUrl: null también; URL externa → 400; validación igual que en jugador', async () => {
    const t = await newTeam(B);
    await send(as(B).put(`/api/teams/${t}/logo`)).expect(200);
    const pid = await logoId(t);
    const del = await as(B).delete(`/api/teams/${t}/logo`).expect(200);
    expect(del.body.logoUrl).toBeNull();
    expect(destroy).toHaveBeenCalledWith(pid);
    await send(as(B).put(`/api/teams/${t}/logo`)).expect(200);
    const pid2 = await logoId(t);
    await as(B).patch(`/api/teams/${t}`).send({ logoUrl: 'https://example.com/escudo.png' }).expect(400);
    await as(B).post('/api/teams').send({ name: 'Con logo externo', logoUrl: 'https://example.com/x.png' }).expect(400);
    expect(await logoId(t)).toBe(pid2);
    await as(B).patch(`/api/teams/${t}`).send({ logoUrl: null }).expect(200);
    expect(destroy).toHaveBeenCalledWith(pid2);
    expect(await logoId(t)).toBeNull();
    await send(as(B).put(`/api/teams/${t}/logo`), Buffer.from('GIF? no'), 'image/gif', 'x.gif').expect(415);
  });

  it('borrar el equipo (sin historia) borra su logo de Cloudinary', async () => {
    const t = await newTeam(B);
    await send(as(B).put(`/api/teams/${t}/logo`)).expect(200);
    const pid = await logoId(t);
    await as(B).delete(`/api/teams/${t}`).expect(204);
    expect(destroy).toHaveBeenCalledWith(pid);
  });

  it('id inexistente → 404', async () => {
    await send(as(A).put(`/api/teams/${new Types.ObjectId().toHexString()}/logo`)).expect(404);
  });
});
