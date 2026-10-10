/**
 * Módulo 2D (2026-10-10): ficha técnica digital — alineaciones y sustituciones, coherencia con las
 * estadísticas y la disciplina, cierre y reapertura, bloqueo de endpoints existentes con la ficha
 * cerrada, fotografías de evidencia privadas y permisos. Cloudinary se simula espiando
 * CloudinaryService (sin red ni archivos reales).
 */
import request from 'supertest';
import type { MockInstance } from 'vitest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { BadGatewayException } from '@nestjs/common';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { CloudinaryService } from '../src/modules/media/cloudinary.service.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, SCO: U, OUT: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
let cloudinary: CloudinaryService;
let uploadPrivate: MockInstance<CloudinaryService['uploadPrivate']>;
let destroyPrivate: MockInstance<CloudinaryService['destroyPrivate']>;

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(256, 3)]);
let seq = 0;
type S = { t: string; home: string; away: string; h: string[]; a: string[]; m: string[] };

async function setup(rounds = 3): Promise<S> {
  seq++;
  const t = (await as(O).post('/api/tournaments').send({ name: `Ficha ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
  const home = (await as(O).post('/api/teams').send({ name: `Halcones F${seq}` }).expect(201)).body.id as string;
  const away = (await as(O).post('/api/teams').send({ name: `Tigres F${seq}` }).expect(201)).body.id as string;
  for (const id of [home, away]) await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  const player = async (team: string, n: number, name: string) => {
    const id = (await as(O).post('/api/players').send({ firstName: name, lastName: `F${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
    await as(O).put(`/api/tournaments/${t}/players/${id}`).send({ teamId: team, jerseyNumber: n, startDate: '2027-01-01' }).expect(200);
    return id;
  };
  const h: string[] = [];
  for (let i = 1; i <= 6; i++) h.push(await player(home, i, `Local${i}`));
  const a: string[] = [];
  for (let i = 1; i <= 4; i++) a.push(await player(away, 10 + i, `Visita${i}`));
  const m: string[] = [];
  for (let r = 1; r <= rounds; r++) {
    m.push((await as(O).post('/api/matches').send({ tournamentId: t, round: r, homeTeamId: home, awayTeamId: away, date: `2027-01-${String(r * 7).padStart(2, '0')}`, time: '18:00' }).expect(201)).body.id);
  }
  return { t, home, away, h, a, m };
}
const starter = (playerId: string, extra: Record<string, unknown> = {}) => ({ playerId, starter: true, ...extra });
const bench = (playerId: string, extra: Record<string, unknown> = {}) => ({ playerId, starter: false, ...extra });
/** Local: titulares h0–h2 (capitán h0), suplentes h3–h4; h1 → h3 al 30'. h4 nunca entra. */
const homeLineup = (s: S) => ({
  players: [starter(s.h[0], { captain: true }), starter(s.h[1]), starter(s.h[2]), bench(s.h[3]), bench(s.h[4])],
  substitutions: [{ outPlayerId: s.h[1], inPlayerId: s.h[3], minute: 30 }],
});
const saveTeam = (s: S, m: string, team: string, body: Record<string, unknown>, who = O) => as(who).put(`/api/matches/${m}/sheet/teams/${team}`).send(body);
const row = (playerId: string, teamId: string, extra: Record<string, unknown> = {}) => ({ playerId, teamId, goals: 0, assists: 0, yellowCards: 0, redCards: 0, sendOff: null, ...extra });
const result = (m: string, home: number, away: number, playerStats: unknown[], status = 'FINISHED', who = O) => as(who).put(`/api/matches/${m}/result`).send({ homeScore: home, awayScore: away, status, playerStats });
const sheet = async (m: string, who = O) => (await as(who).get(`/api/matches/${m}/sheet`).expect(200)).body;
const actions = async (m: string) => ((await as(O).get(`/api/matches/${m}/log`).expect(200)).body.entries as { action: string; reason: string | null; actorRole: string }[]).map((e) => e.action);
const upload = (m: string, key: string, who = O, extra: Record<string, string> = {}, buf: Buffer = JPG, type = 'image/jpeg') =>
  as(who).post(`/api/matches/${m}/evidence`).field('kind', extra.kind ?? 'REFEREE_REPORT').field('uploadKey', key).field('description', extra.description ?? 'Cédula arbitral').attach('file', buf, { filename: 'cedula.jpg', contentType: type });
/** Local finalizado con la alineación de homeLineup y estadísticas coherentes. */
async function finished(s: S, m: string, score = 1) {
  await saveTeam(s, m, s.home, homeLineup(s)).expect(200);
  await result(m, score, 0, [row(s.h[0], s.home, { goals: score }), row(s.h[1], s.home), row(s.h[2], s.home), row(s.h[3], s.home), row(s.a[0], s.away)]).expect(200);
}
async function join(t: string, u: U, role: string) {
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}

beforeAll(async () => {
  ctx = await createTestApp({ CLOUDINARY_CLOUD_NAME: 'test-cloud', CLOUDINARY_API_KEY: 'test-key', CLOUDINARY_API_SECRET: 'test-secret' });
  http = ctx.app.getHttpServer();
  cloudinary = ctx.app.get(CloudinaryService);
  [O, ADM, COO, SCO, OUT] = [
    await registerOrganizer(http, 'DueñoFicha'),
    await registerOrganizer(http, 'AdminFicha'),
    await registerOrganizer(http, 'CoordFicha'),
    await registerOrganizer(http, 'CaptFicha'),
    await registerOrganizer(http, 'AjenoFicha'),
  ];
});
beforeEach(() => {
  uploadPrivate = vi.spyOn(cloudinary, 'uploadPrivate').mockImplementation(async (file, opts) => ({ publicId: opts.publicId, version: 1, format: 'jpg', bytes: file.size }));
  destroyPrivate = vi.spyOn(cloudinary, 'destroyPrivate').mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => ctx?.close());

// ─── Alineaciones y sustituciones ─────────────────────────────────────────────

describe('alineaciones y sustituciones', () => {
  it('válida: titulares, suplente que ingresó y suplente sin participar; dorsal por defecto; capitán; historial', async () => {
    const s = await setup();
    const res = (await saveTeam(s, s.m[0], s.home, homeLineup(s)).expect(200)).body;
    const home = res.teams[0];
    expect(home.lineup.players.map((p: { name: string; jerseyNumber: number; starter: boolean; captain: boolean; participated: boolean; enteredAt: number | null; leftAt: number | null }) => [p.jerseyNumber, p.starter, p.captain, p.participated, p.enteredAt, p.leftAt])).toEqual([
      [1, true, true, true, null, null],
      [2, true, false, true, null, 30],
      [3, true, false, true, null, null],
      [4, false, false, true, 30, null],
      [5, false, false, false, null, null],
    ]);
    expect(home.lineup.substitutions).toEqual([expect.objectContaining({ outPlayerId: s.h[1], inPlayerId: s.h[3], minute: 30, outName: expect.stringContaining('Local2'), inName: expect.stringContaining('Local4') })]);
    expect(home.consistency).toEqual({ consistent: false, missing: expect.any(Array), extra: [] }); // aún sin estadísticas
    expect(res.schemaVersion).toBe(1);
    // Dorsal distinto para este partido.
    const custom = { ...homeLineup(s), players: [starter(s.h[0], { jerseyNumber: 99 }), ...homeLineup(s).players.slice(1)] };
    expect((await saveTeam(s, s.m[1], s.home, custom).expect(200)).body.teams[0].lineup.players[0].jerseyNumber).toBe(99);
    expect(await actions(s.m[0])).toContain('SHEET_LINEUP_SAVED');
  });

  it('inválidas: duplicado, dorsal repetido, dos capitanes y sustituciones inconsistentes → 400', async () => {
    const s = await setup(1);
    const m = s.m[0];
    expect((await saveTeam(s, m, s.home, { players: [starter(s.h[0]), bench(s.h[0])], substitutions: [] }).expect(400)).body.message.join(' ')).toMatch(/dos veces/);
    expect((await saveTeam(s, m, s.home, { players: [starter(s.h[0], { jerseyNumber: 7 }), starter(s.h[1], { jerseyNumber: 7 })], substitutions: [] }).expect(400)).body.message.join(' ')).toMatch(/dorsal 7/);
    expect((await saveTeam(s, m, s.home, { players: [starter(s.h[0], { captain: true }), starter(s.h[1], { captain: true })], substitutions: [] }).expect(400)).body.message.join(' ')).toMatch(/capitán/);
    const sub = (subs: unknown[]) => saveTeam(s, m, s.home, { players: [starter(s.h[0]), starter(s.h[1]), bench(s.h[2]), bench(s.h[3])], substitutions: subs }).expect(400);
    expect((await sub([{ outPlayerId: s.h[2], inPlayerId: s.h[3], minute: 10 }])).body.message[0]).toMatch(/no está en la cancha/);
    expect((await sub([{ outPlayerId: s.h[0], inPlayerId: s.h[2], minute: 10 }, { outPlayerId: s.h[1], inPlayerId: s.h[2], minute: 20 }])).body.message[0]).toMatch(/ya está en la cancha/);
    await saveTeam(s, m, s.home, { players: [starter(s.h[0])], substitutions: [{ outPlayerId: s.h[0], inPlayerId: s.h[1], minute: 999 }] }).expect(400);
    // Jugador del rival (no registrado con este equipo) y equipo que no juega el partido.
    expect((await saveTeam(s, m, s.home, { players: [starter(s.h[0]), starter(s.a[0])], substitutions: [] }).expect(400)).body.message).toMatch(/No están registrados/);
    await saveTeam(s, m, new Types.ObjectId().toHexString(), { players: [], substitutions: [] }).expect(400);
  });

  it('cambio de equipo: vale la plantilla vigente en la fecha del partido', async () => {
    const s = await setup(3);
    // h5 pasa al visitante desde el 2027-01-15: el partido del 7 lo juega con el local, el del 21 con el visitante.
    await as(O).put(`/api/tournaments/${s.t}/players/${s.h[5]}`).send({ teamId: s.away, jerseyNumber: 30, startDate: '2027-01-15' }).expect(200);
    await saveTeam(s, s.m[0], s.home, { players: [starter(s.h[5])], substitutions: [] }).expect(200);
    await saveTeam(s, s.m[2], s.home, { players: [starter(s.h[5])], substitutions: [] }).expect(400);
    const away = (await saveTeam(s, s.m[2], s.away, { players: [starter(s.h[5])], substitutions: [] }).expect(200)).body.teams[1];
    expect(away.lineup.players[0].jerseyNumber).toBe(30);
    // Ya no puede figurar también con el local en ese partido.
    await saveTeam(s, s.m[2], s.home, { players: [starter(s.h[5]), starter(s.h[0])], substitutions: [] }).expect(400);
  });

  it('suspendidos: con el reglamento WARN se avisa; con BLOCK no puede participar (suplente sin ingresar sí)', async () => {
    const s = await setup(3);
    await as(O).put(`/api/tournaments/${s.t}/discipline/rules`).send({ enabled: true }).expect(200);
    await result(s.m[0], 0, 0, [row(s.h[0], s.home, { redCards: 1, sendOff: 'DIRECT' })]).expect(200);
    const warn = (await saveTeam(s, s.m[1], s.home, { players: [starter(s.h[0]), starter(s.h[1])], substitutions: [] }).expect(200)).body;
    expect(warn.warnings[0]).toMatch(/suspendidos: Local1/);
    await as(O).put(`/api/tournaments/${s.t}/discipline/rules`).send({ eligibility: 'BLOCK', justification: 'Reglamento' }).expect(200);
    expect((await saveTeam(s, s.m[1], s.home, { players: [starter(s.h[0]), starter(s.h[1])], substitutions: [] }).expect(409)).body.message).toMatch(/suspendidos para este partido: Local1/);
    expect((await saveTeam(s, s.m[1], s.home, { players: [starter(s.h[1]), bench(s.h[0])], substitutions: [] }).expect(200)).body.warnings).toEqual([]);
  });

  it('el suplente que nunca ingresó no jugó: la captura debe coincidir con la alineación', async () => {
    const s = await setup(1);
    const m = s.m[0];
    await saveTeam(s, m, s.home, homeLineup(s)).expect(200);
    // h4 (suplente sin ingresar) marcado como jugado → 409; falta h3 (ingresó) → 409.
    expect((await result(m, 0, 0, [row(s.h[0], s.home), row(s.h[1], s.home), row(s.h[2], s.home), row(s.h[3], s.home), row(s.h[4], s.home)]).expect(409)).body).toMatchObject({ error: 'LINEUP_MISMATCH', message: expect.stringContaining('Local5') });
    expect((await result(m, 0, 0, [row(s.h[0], s.home), row(s.h[1], s.home), row(s.h[2], s.home)]).expect(409)).body.message).toMatch(/no están marcados: Local4/);
    await result(m, 1, 0, [row(s.h[0], s.home, { goals: 1 }), row(s.h[1], s.home), row(s.h[2], s.home), row(s.h[3], s.home)]).expect(200);
    const v = await sheet(m);
    expect(v.teams[0].consistency).toEqual({ consistent: true, missing: [], extra: [] });
    expect(v.teams[0].stats.map((r: { jerseyNumber: number }) => r.jerseyNumber)).toEqual([1, 2, 3, 4]);
    // El visitante no tiene alineación: no se valida (las sustituciones históricas no son obligatorias).
    expect(v.teams[1].lineup).toBeNull();
    // Alineación nueva contradiciendo lo capturado → 409; corregirla en un partido finalizado exige motivo.
    expect((await saveTeam(s, m, s.home, { ...homeLineup(s), substitutions: [] }).expect(409)).body.error).toBe('LINEUP_MISMATCH');
    await saveTeam(s, m, s.home, homeLineup(s)).expect(400);
    await saveTeam(s, m, s.home, { ...homeLineup(s), reason: 'Dorsales de la cédula' }).expect(200);
  });
});

// ─── Cierre y reapertura ─────────────────────────────────────────────────────

describe('cierre y reapertura', () => {
  it('solo partidos finalizados; alineaciones y fotos no son obligatorias; snapshot del marcador', async () => {
    const s = await setup(3);
    expect((await as(O).post(`/api/matches/${s.m[0]}/sheet/close`).expect(409)).body.message).toMatch(/finalizado/);
    await result(s.m[1], 0, 0, [], 'LIVE').expect(200);
    await as(O).post(`/api/matches/${s.m[1]}/incidents`).send({ type: 'SUSPENSION', description: 'Lluvia' }).expect(201);
    await as(O).post(`/api/matches/${s.m[1]}/sheet/close`).expect(409);
    await result(s.m[2], 2, 1, []).expect(200);
    const closed = (await as(O).post(`/api/matches/${s.m[2]}/sheet/close`).expect(200)).body;
    expect(closed.closure).toMatchObject({ closed: true, homeScore: 2, awayScore: 1, role: 'OWNER', by: expect.stringContaining('DueñoFicha') });
    await as(O).post(`/api/matches/${s.m[2]}/sheet/close`).expect(409);
    // El público solo ve cuándo se cerró.
    const pub = (await request(http).get(`/api/matches/${s.m[2]}`).expect(200)).body;
    expect(pub.sheetClosed).toEqual({ at: expect.any(String) });
  });

  it('ficha cerrada: los endpoints existentes no modifican información protegida (409 SHEET_CLOSED)', async () => {
    const s = await setup(1);
    const m = s.m[0];
    await finished(s, m);
    const ref = (await as(O).post('/api/referees').send({ firstName: 'Cerrado', lastName: `R${seq}` }).expect(201)).body.id;
    await as(O).post(`/api/matches/${m}/referees`).send({ refereeId: ref, role: 'CENTRAL' }).expect(201);
    const assignment = (await as(O).get(`/api/matches/${m}/referees`).expect(200)).body.referees[0].id;
    await as(O).post(`/api/matches/${m}/incidents`).send({ type: 'DELAY', description: 'Antes del cierre' }).expect(201);
    await as(O).post(`/api/matches/${m}/sheet/close`).expect(200);

    const closedErr = async (r: request.Test) => expect((await r.expect(409)).body.error).toBe('SHEET_CLOSED');
    await closedErr(result(m, 5, 0, [row(s.h[0], s.home, { goals: 5 }), row(s.h[1], s.home), row(s.h[2], s.home), row(s.h[3], s.home)]));
    await closedErr(as(O).patch(`/api/matches/${m}`).send({ venue: 'Otra', reason: 'x x' }));
    await closedErr(as(O).patch(`/api/matches/${m}`).send({ date: '2027-01-08', reason: 'x x' }));
    await closedErr(as(O).delete(`/api/matches/${m}/referees/${assignment}`));
    await closedErr(as(O).post(`/api/matches/${m}/referees/${assignment}/absence`).send({}));
    await closedErr(as(O).post(`/api/matches/${m}/incidents`).send({ type: 'OTHER', description: 'Después del cierre' }));
    await closedErr(saveTeam(s, m, s.home, { ...homeLineup(s), reason: 'Intento' }));
    await closedErr(as(O).put(`/api/matches/${m}/sheet/observations`).send({ observations: 'Tarde' }));
    // Las fotografías (documentación) sí se pueden agregar.
    await upload(m, 'cerrada-0001').expect(201);
    const v = await sheet(m);
    expect([v.match.homeScore, v.match.awayScore]).toEqual([1, 0]);

    // Reabrir: permiso, motivo obligatorio y auditoría; después se corrige como siempre.
    await as(O).post(`/api/matches/${m}/sheet/reopen`).send({}).expect(400);
    await as(O).post(`/api/matches/${m}/sheet/reopen`).send({ reason: 'Error en el marcador de la cédula' }).expect(200);
    await result(m, 2, 0, [row(s.h[0], s.home, { goals: 2 }), row(s.h[1], s.home), row(s.h[2], s.home), row(s.h[3], s.home)]).expect(200);
    await as(O).post(`/api/matches/${m}/sheet/reopen`).send({ reason: 'otra vez' }).expect(409);
    const log = (await as(O).get(`/api/matches/${m}/log`).expect(200)).body.entries as { action: string; reason: string | null; changes: Record<string, { from: unknown; to: unknown }> }[];
    expect(log.filter((e) => e.action.startsWith('SHEET_') || e.action.startsWith('RESULT_')).map((e) => e.action)).toEqual(['SHEET_LINEUP_SAVED', 'RESULT_CAPTURED', 'SHEET_CLOSED', 'SHEET_REOPENED', 'RESULT_CORRECTED']);
    expect(log.find((e) => e.action === 'SHEET_REOPENED')).toMatchObject({ reason: 'Error en el marcador de la cédula', changes: { sheet: { to: 'OPEN' } } });
    expect(log.find((e) => e.action === 'SHEET_CLOSED')!.changes.score.to).toEqual({ home: 1, away: 0 });
  });

  it('datos inconsistentes (registros anteriores) impiden cerrar; observaciones con historial', async () => {
    const s = await setup(1);
    const m = s.m[0];
    await finished(s, m);
    await as(O).put(`/api/matches/${m}/sheet/observations`).send({ observations: 'Cancha en mal estado' }).expect(200);
    await as(O).put(`/api/matches/${m}/sheet/observations`).send({ observations: 'Cancha en mal estado' }).expect(200); // sin cambios: sin entrada
    // Una fila de "jugó" para el suplente que no entró, escrita fuera de las reglas (dato anterior).
    await db().collection('player_match_stats').insertOne({ matchId: new Types.ObjectId(m), playerId: new Types.ObjectId(s.h[4]), teamId: new Types.ObjectId(s.home), played: true, goals: 0, assists: 0, ownGoals: 0, yellowCards: 0, redCards: 0 });
    const res = await as(O).post(`/api/matches/${m}/sheet/close`).expect(409);
    expect(res.body).toMatchObject({ error: 'SHEET_INCONSISTENT', message: expect.stringContaining('Local5') });
    expect((await sheet(m)).observations).toBe('Cancha en mal estado');
    expect((await actions(m)).filter((a) => a === 'SHEET_OBSERVATIONS_SAVED')).toHaveLength(1);
  });

  it('torneo FINISHED: solo lectura; reabrir no elude la regla; finalizar no exige fichas cerradas', async () => {
    const s = await setup(1);
    await finished(s, s.m[0]);
    await as(O).post(`/api/tournaments/${s.t}/finish`).send({}).expect(200); // ficha abierta: no bloquea
    await as(O).post(`/api/matches/${s.m[0]}/sheet/close`).expect(409);
    await as(O).post(`/api/matches/${s.m[0]}/sheet/reopen`).send({ reason: 'x x x' }).expect(409);
    await saveTeam(s, s.m[0], s.home, { ...homeLineup(s), reason: 'x x' }).expect(409);
    await upload(s.m[0], 'finalizado1').expect(409);
    expect((await sheet(s.m[0])).tournament.status).toBe('FINISHED');
  });

  it('carrera: cerrar la ficha y capturar otro resultado a la vez nunca deja un resultado distinto al congelado', async () => {
    for (let i = 0; i < 6; i++) {
      const s = await setup(1);
      const m = s.m[0];
      await result(m, 1, 0, [row(s.h[0], s.home, { goals: 1 })]).expect(200);
      const [close, capture] = await Promise.all([as(O).post(`/api/matches/${m}/sheet/close`), result(m, 3, 0, [row(s.h[0], s.home, { goals: 3 })])]);
      expect(close.status).toBe(200);
      expect([200, 409]).toContain(capture.status);
      const doc = await db().collection('matches').findOne({ _id: new Types.ObjectId(m) });
      expect(doc!.homeScore).toBe(doc!.sheetClosed.homeScore);
      if (capture.status === 409) expect(capture.body.error).toBe('SHEET_CLOSED');
    }
  });
});

// ─── Fotografías de evidencia ────────────────────────────────────────────────

describe('fotografías', () => {
  it('subir: privada (sin URL ni ruta en la API), URL temporal tras permisos, idempotente por clave', async () => {
    const s = await setup(1);
    const m = s.m[0];
    const res = (await upload(m, 'clave-unica-1').expect(201)).body;
    expect(res).toMatchObject({ duplicate: false, evidence: { kind: 'REFEREE_REPORT', description: 'Cédula arbitral', status: 'ACTIVE', uploadedRole: 'OWNER' } });
    expect(JSON.stringify(res)).not.toMatch(/kikovo\/evidence|res\.cloudinary|publicId/);
    expect(uploadPrivate).toHaveBeenCalledWith(expect.anything(), { publicId: `kikovo/evidence/${s.t}/${m}/clave-unica-1`, incoming: 'c_limit,w_2400,h_2400' });
    // Reintento con la misma clave: el mismo registro, sin subir otra vez.
    const again = (await upload(m, 'clave-unica-1').expect(201)).body;
    expect(again).toMatchObject({ duplicate: true, evidence: { id: res.evidence.id } });
    expect(uploadPrivate).toHaveBeenCalledTimes(1);

    const url = (await as(O).get(`/api/matches/${m}/evidence/${res.evidence.id}/url`).expect(200)).body;
    expect(url.url).toMatch(/\/image\/download\?.*expires_at=/);
    expect(new Date(url.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(300_000 + 2000);
    await as(OUT).get(`/api/matches/${m}/evidence/${res.evidence.id}/url`).expect(403);
    await request(http).get(`/api/matches/${m}/evidence/${res.evidence.id}/url`).expect(401);
    expect((await sheet(m)).evidence).toHaveLength(1);
    expect(await actions(m)).toContain('EVIDENCE_ADDED');
  });

  it('validaciones: contenido real, tamaño, clave, tipo de evidencia e incidencia del partido', async () => {
    const s = await setup(1);
    const m = s.m[0];
    await upload(m, 'falsa-0001', O, {}, Buffer.from('<svg onload=alert(1)>'.padEnd(64, ' ')), 'image/png').expect(415);
    await upload(m, 'pdf-00001', O, {}, Buffer.from('%PDF-1.7'.padEnd(64, ' ')), 'application/pdf').expect(415);
    await upload(m, 'grande-001', O, {}, Buffer.concat([JPG, Buffer.alloc(8 * 1024 * 1024)])).expect(413);
    await upload(m, 'x').expect(400);
    await upload(m, 'tipo-00001', O, { kind: 'SELFIE' }).expect(400);
    await as(O).post(`/api/matches/${m}/evidence`).field('kind', 'OTHER').field('uploadKey', 'sinarchivo1').expect(400);
    await as(O).post(`/api/matches/${m}/evidence`).field('kind', 'INCIDENT').field('uploadKey', 'incid-ajena1').field('incidentId', new Types.ObjectId().toHexString()).attach('file', JPG, { filename: 'a.jpg', contentType: 'image/jpeg' }).expect(404);
    expect(uploadPrivate).not.toHaveBeenCalled();
  });

  it('errores de almacenamiento: Cloudinary falla → 502 sin registro; registro fallido → se borra el archivo subido', async () => {
    const s = await setup(1);
    const m = s.m[0];
    uploadPrivate.mockRejectedValueOnce(new BadGatewayException('No se pudo subir la imagen. Inténtalo de nuevo.'));
    await upload(m, 'fallida-001').expect(502);
    expect(await db().collection('match_evidence').countDocuments({ matchId: new Types.ObjectId(m) })).toBe(0);
    // 19 activas: dos subidas a la vez con claves distintas → una entra, la otra se rechaza y su archivo se borra.
    await db().collection('match_evidence').insertMany(
      Array.from({ length: 19 }, (_, i) => ({ tournamentId: new Types.ObjectId(s.t), matchId: new Types.ObjectId(m), kind: 'OTHER', uploadKey: `relleno-${i}-xx`, publicId: `p${i}`, format: 'jpg', bytes: 1, status: 'ACTIVE', uploadedBy: new Types.ObjectId(O.id), createdAt: new Date() })),
    );
    const res = await Promise.all([upload(m, 'carrera-aaa1'), upload(m, 'carrera-bbb2')]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = res.find((r) => r.status === 409)!;
    expect(loser.body.message).toMatch(/20 fotografías/);
    expect(destroyPrivate).toHaveBeenCalledTimes(1);
    expect(await db().collection('match_evidence').countDocuments({ matchId: new Types.ObjectId(m), status: 'ACTIVE' })).toBe(20);
    // Misma clave a la vez: un solo registro y nada se borra (es el mismo archivo).
    const s2 = await setup(1);
    destroyPrivate.mockClear();
    const same = await Promise.all([upload(s2.m[0], 'misma-clave-1'), upload(s2.m[0], 'misma-clave-1')]);
    expect(same.map((r) => r.status)).toEqual([201, 201]);
    expect(new Set(same.map((r) => r.body.evidence.id)).size).toBe(1);
    expect(destroyPrivate).not.toHaveBeenCalled();
  });

  it('retirar: motivo, auditoría, registro conservado y sin URL después', async () => {
    const s = await setup(1);
    const m = s.m[0];
    await join(s.t, SCO, 'SCORER');
    const e = (await upload(m, 'retirar-0001', SCO, { kind: 'SCOREBOARD', description: 'Marcador' }).expect(201)).body.evidence;
    expect(e.uploadedRole).toBe('SCORER');
    await as(SCO).post(`/api/matches/${m}/evidence/${e.id}/remove`).send({ reason: 'No puedo' }).expect(403);
    await as(O).post(`/api/matches/${m}/evidence/${e.id}/remove`).send({}).expect(400);
    await as(O).post(`/api/matches/${m}/evidence/${e.id}/remove`).send({ reason: 'Foto de otro partido' }).expect(204);
    await as(O).post(`/api/matches/${m}/evidence/${e.id}/remove`).send({ reason: 'Otra vez' }).expect(409);
    await as(O).get(`/api/matches/${m}/evidence/${e.id}/url`).expect(410);
    const list = (await sheet(m)).evidence;
    expect(list[0]).toMatchObject({ status: 'REMOVED', removed: { reason: 'Foto de otro partido', role: 'OWNER' } });
    expect(destroyPrivate).not.toHaveBeenCalled(); // el archivo se purga después (evidence:cleanup)
    expect(await actions(m)).toContain('EVIDENCE_REMOVED');
  });
});

// ─── Permisos ─────────────────────────────────────────────────────────────────

describe('permisos 2D', () => {
  it('OWNER/ADMIN cierran y reabren; SCORER captura alineación y fotos; COORDINATOR consulta y sube fotos; ajenos nada; revocación', async () => {
    const s = await setup(2);
    await join(s.t, ADM, 'ADMIN');
    await join(s.t, COO, 'COORDINATOR');
    await join(s.t, SCO, 'SCORER');
    const m = s.m[0];
    // SCORER: alineación, sustituciones, observaciones y resultado.
    await saveTeam(s, m, s.home, homeLineup(s), SCO).expect(200);
    await as(SCO).put(`/api/matches/${m}/sheet/observations`).send({ observations: 'Del anotador' }).expect(200);
    await result(m, 1, 0, [row(s.h[0], s.home, { goals: 1 }), row(s.h[1], s.home), row(s.h[2], s.home), row(s.h[3], s.home)], 'FINISHED', SCO).expect(200);
    await upload(m, 'anotador-001', SCO).expect(201);
    await as(SCO).post(`/api/matches/${m}/sheet/close`).expect(403);
    // COORDINATOR: consulta y fotos; no la información deportiva ni el cierre.
    expect((await sheet(m, COO)).myRole).toBe('COORDINATOR');
    await saveTeam(s, m, s.away, { players: [starter(s.a[0])], substitutions: [] }, COO).expect(403);
    await as(COO).put(`/api/matches/${m}/sheet/observations`).send({ observations: 'No' }).expect(403);
    await upload(m, 'coord-00001', COO).expect(201);
    await as(COO).post(`/api/matches/${m}/sheet/close`).expect(403);
    // ADMIN: cierra y reabre.
    await as(ADM).post(`/api/matches/${m}/sheet/close`).expect(200);
    await as(SCO).post(`/api/matches/${m}/sheet/reopen`).send({ reason: 'x x x' }).expect(403);
    await as(COO).post(`/api/matches/${m}/sheet/reopen`).send({ reason: 'x x x' }).expect(403);
    await as(ADM).post(`/api/matches/${m}/sheet/reopen`).send({ reason: 'Revisión del administrador' }).expect(200);
    // Ajeno: nada.
    await as(OUT).get(`/api/matches/${m}/sheet`).expect(403);
    await upload(m, 'ajeno-00001', OUT).expect(403);
    // Revocación inmediata.
    await as(O).delete(`/api/tournaments/${s.t}/members/${SCO.id}`).expect(200);
    await saveTeam(s, s.m[1], s.home, homeLineup(s), SCO).expect(403);
    await as(SCO).get(`/api/matches/${m}/sheet`).expect(403);
  });
});

// ─── Regresión ────────────────────────────────────────────────────────────────

describe('regresión', () => {
  it('Calendario y Agenda siguen funcionando; la ficha reúne incidencias, árbitros e historial existentes', async () => {
    const s = await setup(1);
    const m = s.m[0];
    await as(O).post(`/api/matches/${m}/incidents`).send({ type: 'FACILITIES', description: 'Sin luz en el vestidor' }).expect(201);
    await finished(s, m);
    await as(O).post(`/api/matches/${m}/sheet/close`).expect(200);
    const v = await sheet(m);
    expect(v.incidents.incidents.map((i: { type: string }) => i.type)).toEqual(['FACILITIES']);
    expect(v.history.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['CREATED', 'INCIDENT_REPORTED', 'RESULT_CAPTURED', 'SHEET_CLOSED']));
    // Nada se duplicó en otra colección: la ficha solo guarda la alineación (y observaciones).
    const stored = await db().collection('match_sheets').findOne({ matchId: new Types.ObjectId(m) });
    expect(Object.keys(stored!).sort()).toEqual(['__v', '_id', 'createdAt', 'matchId', 'observations', 'teams', 'tournamentId', 'updatedAt']);
    const agenda = (await as(O).get('/api/agenda').query({ tournamentId: s.t, includeFinished: true }).expect(200)).body;
    expect(agenda.data[0]).toMatchObject({ id: m, status: 'FINISHED', sheetClosed: { at: expect.any(String) } });
    expect((await request(http).get(`/api/tournaments/${s.t}/matches`).expect(200)).body[0].sheetClosed).toEqual({ at: expect.any(String) });
  });
});
