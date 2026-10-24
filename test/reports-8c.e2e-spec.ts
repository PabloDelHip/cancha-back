/**
 * Módulo 8C (2026-10-23): auditoría de permisos de los reportes por acceso directo a la API (sin la
 * interfaz). Los 7 reportes × 3 formatos × todos los roles (propietario, administrador,
 * coordinador, anotador, ajeno y colaborador revocado), coherencia con el catálogo, aislamiento entre
 * torneos, manipulación de parámetros y datos sensibles. Base en memoria (createTestApp).
 */
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types, type Connection } from 'mongoose';
import { strFromU8, unzipSync } from 'fflate';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, SCO: U, OUT: U, REV: U, O2: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());

const REPORTS = ['standings', 'matches', 'players', 'rosters', 'discipline', 'finance', 'summary'] as const;
const FORMATS = ['pdf', 'xlsx', 'csv'] as const;
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const get = (u: U, t: string, report: string, q: Record<string, string | string[]> = {}) => as(u).get(`/api/tournaments/${t}/reports/${report}`).query(q).buffer(true).parse(binary);
const text = (b: Buffer) => b.toString('utf8');
const xlsxText = (b: Buffer) =>
  Object.values(unzipSync(new Uint8Array(b)))
    .map((v) => strFromU8(v))
    .join('\n');

let T: string, T2: string, teamA: string, teamB: string, foreignTeam: string;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, SCO, OUT, REV, O2] = await Promise.all(['DuenoAud', 'AdminAud', 'CoordAud', 'AnotAud', 'AjenoAud', 'RevocAud', 'OtroDueno'].map((n) => registerOrganizer(http, n)));
  T = (await as(O).post('/api/tournaments').send({ name: 'Auditoría 8C', format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE' }).expect(201)).body.id;
  teamA = (await as(O).post('/api/teams').send({ name: 'Águilas Auditoría' }).expect(201)).body.id;
  teamB = (await as(O).post('/api/teams').send({ name: 'Leones Auditoría' }).expect(201)).body.id;
  for (const id of [teamA, teamB]) await as(O).post(`/api/tournaments/${T}/teams/${id}`).expect(201);
  const inv = (r: string) => as(O).post(`/api/tournaments/${T}/invitations`).send({ kind: 'LINK', role: r }).expect(201);
  await as(ADM).post(`/api/invitations/${(await inv('ADMIN')).body.token}/accept`).expect(200);
  await as(COO).post(`/api/invitations/${(await inv('COORDINATOR')).body.token}/accept`).expect(200);
  await as(SCO).post(`/api/invitations/${(await inv('SCORER')).body.token}/accept`).expect(200);
  await as(REV).post(`/api/invitations/${(await inv('ADMIN')).body.token}/accept`).expect(200);
  await as(O).delete(`/api/tournaments/${T}/members/${REV.id}`).expect((r) => expect([200, 204]).toContain(r.status));
  // Jugador con fecha de nacimiento (no debe salir) y movimiento con nota interna (no debe salir).
  const p = (await as(O).post('/api/players').send({ firstName: 'Menor', lastName: 'Privado', position: 'FORWARD', confirmNew: true, birthDate: '2011-07-15' }).expect(201)).body.id;
  await as(O).put(`/api/tournaments/${T}/players/${p}`).send({ teamId: teamA, jerseyNumber: 7 }).expect(200);
  await as(O).post(`/api/tournaments/${T}/finance/entries`).send({ requestId: randomUUID(), teamId: teamA, kind: 'CHARGE', category: 'ENROLLMENT', amount: 100_000, concept: 'Inscripción', notes: 'NOTA-INTERNA-SECRETA', date: '2026-01-10' }).expect(201);
  await as(O).post('/api/matches').send({ tournamentId: T, round: 1, homeTeamId: teamA, awayTeamId: teamB, date: '2027-02-01', time: '10:00' }).expect(201);
  // Otro torneo de otro organizador.
  T2 = (await as(O2).post('/api/tournaments').send({ name: 'Torneo Ajeno 8C', format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE' }).expect(201)).body.id;
  foreignTeam = (await as(O2).post('/api/teams').send({ name: 'Equipo Secreto Ajeno' }).expect(201)).body.id;
  await as(O2).post(`/api/tournaments/${T2}/teams/${foreignTeam}`).expect(201);
});
afterAll(async () => ctx?.close());

describe('8C — matriz de permisos (acceso directo a la API)', () => {
  const EXPECT: Record<string, Record<(typeof REPORTS)[number], number>> = {
    owner: { standings: 200, matches: 200, players: 200, rosters: 200, discipline: 200, finance: 200, summary: 200 },
    admin: { standings: 200, matches: 200, players: 200, rosters: 200, discipline: 200, finance: 200, summary: 200 },
    coordinator: { standings: 200, matches: 200, players: 200, rosters: 403, discipline: 200, finance: 403, summary: 200 },
    scorer: { standings: 200, matches: 200, players: 200, rosters: 403, discipline: 200, finance: 403, summary: 200 },
    outsider: { standings: 403, matches: 403, players: 403, rosters: 403, discipline: 403, finance: 403, summary: 403 },
    revoked: { standings: 403, matches: 403, players: 403, rosters: 403, discipline: 403, finance: 403, summary: 403 },
  };
  const who = () => ({ owner: O, admin: ADM, coordinator: COO, scorer: SCO, outsider: OUT, revoked: REV });

  it('7 reportes × 3 formatos × 6 perfiles: exactamente lo esperado', async () => {
    const got: Record<string, Record<string, number[]>> = {};
    for (const [name, u] of Object.entries(who())) {
      got[name] = {};
      // En secuencia: en paralelo el límite de 2 generaciones simultáneas por usuario daría 429 (esperado).
      for (const r of REPORTS) {
        got[name][r] = [];
        for (const f of FORMATS) got[name][r].push((await get(u, T, r, { format: f })).status);
      }
    }
    for (const [name, map] of Object.entries(EXPECT)) for (const r of REPORTS) expect({ name, r, codes: got[name][r] }).toEqual({ name, r, codes: [map[r], map[r], map[r]] });
  });

  it('el catálogo dice lo mismo que la descarga; ajeno y revocado no ven el catálogo', async () => {
    for (const [name, u] of Object.entries(who())) {
      const res = await as(u).get(`/api/tournaments/${T}/reports`);
      if (name === 'outsider' || name === 'revoked') {
        expect(res.status).toBe(403);
        continue;
      }
      const allowed = Object.fromEntries(res.body.reports.map((r: { id: string; allowed: boolean }) => [r.id, r.allowed]));
      for (const r of REPORTS) expect({ name, r, allowed: allowed[r] }).toEqual({ name, r, allowed: EXPECT[name][r] === 200 });
    }
  });

  it('sin sesión o con token inválido: 401 (nunca un archivo)', async () => {
    for (const r of REPORTS) await request(http).get(`/api/tournaments/${T}/reports/${r}?format=csv`).expect(401);
    await request(http).get(`/api/tournaments/${T}/reports/finance`).set('Authorization', 'Bearer x.y.z').expect(401);
    await request(http).get(`/api/tournaments/${T}/reports`).expect(401);
  });

  it('el 403 no revela datos del torneo ni del permiso a un ajeno', async () => {
    const res = await get(OUT, T, 'finance', { format: 'csv' }).expect(403);
    const body = JSON.parse(text(res.body as Buffer));
    expect(body.message).toBe('No tienes permiso para administrar este torneo');
    expect(text(res.body as Buffer)).not.toContain('Auditoría 8C');
  });
});

describe('8C — aislamiento y manipulación de parámetros', () => {
  it('torneo ajeno con un token válido: 403 en todo; con id inexistente: 404', async () => {
    for (const r of REPORTS) await get(O, T2, r, { format: 'csv' }).expect(403);
    await get(O, new Types.ObjectId().toHexString(), 'summary').expect(404);
    await as(O).get('/api/tournaments/no-es-un-id/reports').expect(400);
  });

  it('teamId de otro torneo: 400 y el nombre del equipo ajeno nunca aparece', async () => {
    for (const r of ['matches', 'players', 'rosters', 'discipline', 'finance']) {
      const res = await get(O, T, r, { format: 'csv', teamId: foreignTeam }).expect(400);
      expect(text(res.body as Buffer)).toContain('El equipo no participa en este torneo');
      expect(text(res.body as Buffer)).not.toContain('Secreto');
    }
    // Un equipo propio sí.
    await get(O, T, 'matches', { format: 'csv', teamId: teamA }).expect(200);
  });

  it('nombres de reporte manipulados: 404 (también claves del prototipo, que antes daban 500)', async () => {
    for (const r of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'STANDINGS', 'standings.pdf', '%2e%2e%2fstandings', 'finance%00']) {
      const res = await as(O).get(`/api/tournaments/${T}/reports/${r}`);
      expect({ r, status: res.status }).toEqual({ r, status: 404 });
    }
  });

  it('parámetros: formato, operadores de Mongo, arreglos, desconocidos y valores fuera de rango → 400', async () => {
    const bad: Record<string, string | string[]>[] = [
      { format: 'PDF' },
      { format: ['pdf', 'csv'] },
      { format: '../../etc/passwd' },
      { 'teamId[$ne]': 'x' },
      { 'status[$ne]': 'FINISHED' },
      { 'round[$gt]': '0' },
      { round: '1e9' },
      { round: '0' },
      { round: '-1' },
      { from: '2027-02-01T00:00:00Z' },
      { from: "2027-02-01'; drop" },
      { status: 'FINISHED,$where' },
      { isAdmin: 'true' },
    ];
    for (const q of bad) {
      const res = await get(O, T, 'matches', { format: 'csv', ...q });
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
    }
    // Claves del prototipo en la cadena de consulta: el parser (qs) las descarta (no llegan) o se
    // rechazan; nunca contaminan Object.prototype. La app corre en este mismo proceso: se comprueba.
    for (const raw of ['__proto__=x', '__proto__[admin]=1', 'constructor[prototype][x]=1', 'constructor[prototype][admin]=1']) {
      const res = await as(O).get(`/api/tournaments/${T}/reports/matches?format=csv&${raw}`);
      expect({ raw, ok: [200, 400].includes(res.status) }).toEqual({ raw, ok: true });
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    // Estados repetidos como arreglo (?status=A&status=B) son válidos.
    await get(O, T, 'matches', { format: 'csv', status: ['FINISHED', 'SCHEDULED'] }).expect(200);
    // Un filtro de otro reporte se rechaza (no se ignora).
    await get(O, T, 'finance', { format: 'csv', round: '1' }).expect(400);
  });

  it('no hay forma de pedir datos de otro torneo vía parámetros de finanzas o plantillas', async () => {
    const res = await get(O, T, 'finance', { format: 'csv' }).expect(200);
    expect(text(res.body as Buffer)).not.toContain('Equipo Secreto Ajeno');
    const r2 = await get(O, T, 'rosters', { format: 'csv' }).expect(200);
    expect(text(r2.body as Buffer)).not.toContain('Equipo Secreto Ajeno');
  });
});

describe('8C — datos sensibles', () => {
  it('plantillas: sin fecha de nacimiento, correo ni teléfono en ningún formato', async () => {
    const pdf = (await get(O, T, 'rosters').expect(200)).body as Buffer;
    const xlsx = (await get(O, T, 'rosters', { format: 'xlsx' }).expect(200)).body as Buffer;
    const csv = (await get(O, T, 'rosters', { format: 'csv' }).expect(200)).body as Buffer;
    for (const content of [xlsxText(xlsx), text(csv), pdf.toString('latin1')]) {
      expect(content).not.toContain('2011-07-15');
      expect(content).not.toMatch(/15\/07\/2011|15 jul 2011/);
      expect(content).not.toMatch(/@example\.com/);
    }
    expect(text(csv)).toContain('Menor Privado');
  });

  it('finanzas: sin notas internas ni datos de quién registró', async () => {
    const csv = text((await get(ADM, T, 'finance', { format: 'csv' }).expect(200)).body as Buffer);
    const xlsx = xlsxText((await get(ADM, T, 'finance', { format: 'xlsx' }).expect(200)).body as Buffer);
    for (const content of [csv, xlsx]) {
      expect(content).not.toContain('NOTA-INTERNA-SECRETA');
      expect(content).not.toContain('DuenoAud');
    }
    expect(csv).toContain('Inscripción');
  });

  it('las respuestas no se guardan en caché intermedias', async () => {
    const res = await get(O, T, 'finance', { format: 'xlsx' }).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('un colaborador revocado pierde el acceso al instante (también en finanzas)', async () => {
    await get(REV, T, 'finance', { format: 'csv' }).expect(403);
    const member = await db().collection('tournament_members').findOne({ tournamentId: new Types.ObjectId(T), userId: new Types.ObjectId(REV.id) });
    expect(member?.status === 'ACTIVE').toBe(false);
  });
});

describe('8C — límites de volumen (medidos en docs/reports-8.md § Rendimiento)', () => {
  it('PDF: más de 4,000 movimientos se rechaza ANTES de cargarlos; Excel y CSV hasta 20,000; más de 20,000 → 400', async () => {
    const t = (await as(O).post('/api/tournaments').send({ name: 'Volumen 8C', format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
    const team = (await as(O).post('/api/teams').send({ name: 'Volumen Equipo 8C' }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${team}`).expect(201);
    const entry = (i: number) => ({ tournamentId: new Types.ObjectId(t), teamId: new Types.ObjectId(team), kind: 'CHARGE', category: 'OTHER', amount: 100 + i, currency: 'MXN', method: null, reference: null, date: '2026-09-01', concept: `Cargo ${i}`, reason: null, matchId: null, playerId: null, notes: null, recordedBy: new Types.ObjectId(O.id), recordedRole: 'OWNER', requestId: randomUUID(), voidedAt: null, createdAt: new Date() });
    await db().collection('finance_entries').insertMany(Array.from({ length: 4_001 }, (_, i) => entry(i)));
    const pdf = await get(O, t, 'finance');
    expect(pdf.status).toBe(400);
    expect(JSON.parse(text(pdf.body as Buffer)).message).toBe('El reporte tiene 4001 movimientos: para un PDF el máximo es 4000. Descárgalo en Excel o CSV, o aplica filtros');
    await get(O, t, 'finance', { format: 'xlsx' }).expect(200);
    await db().collection('finance_entries').insertMany(Array.from({ length: 16_000 }, (_, i) => entry(5_000 + i)));
    const big = await get(O, t, 'finance', { format: 'csv' });
    expect(big.status).toBe(400);
    expect(JSON.parse(text(big.body as Buffer)).message).toBe('El reporte tiene 20001 movimientos (máximo 20000); aplica filtros');
    // Con filtro de periodo vuelve a caber.
    await get(O, t, 'finance', { format: 'csv', from: '2026-10-01' }).expect(200);
  });
});

describe('8C — textos del archivo', () => {
  it('los filtros del encabezado van en español (no los códigos del API)', async () => {
    const xlsx = xlsxText((await get(O, T, 'matches', { format: 'xlsx', status: 'FINISHED,PENDING_SCHEDULE,SCHEDULED' }).expect(200)).body as Buffer);
    expect(xlsx).toContain('Estados: Finalizado, Por programar, Programado');
    expect(xlsx).not.toContain('PENDING_SCHEDULE');
  });
});

describe('8C — bitácora de exportaciones', () => {
  it('cada exportación deja un evento report.export con quién, qué, cuándo y si es sensible (sin datos personales)', async () => {
    const spy = vi.spyOn(Logger.prototype, 'log');
    try {
      await get(ADM, T, 'finance', { format: 'xlsx', teamId: teamA }).expect(200);
      await get(COO, T, 'standings', { format: 'csv' }).expect(200);
      await get(COO, T, 'finance', { format: 'csv' }).expect(403);
      const events = spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('"report.export"')).map((m) => JSON.parse(m));
      expect(events).toHaveLength(2);
      const [fin, std] = events;
      expect(fin).toMatchObject({ event: 'report.export', report: 'finance', format: 'xlsx', sensitive: true, tournamentId: T, userId: ADM.id, role: 'ADMIN', filters: ['Equipo: Águilas Auditoría'] });
      expect(new Date(fin.at).toISOString()).toBe(fin.at);
      expect(fin.rows).toBeGreaterThan(0);
      expect(std).toMatchObject({ report: 'standings', format: 'csv', sensitive: false, userId: COO.id, role: 'COORDINATOR' });
      // Sin correos ni nombres de personas en la bitácora; el intento rechazado no se registra como exportación.
      expect(JSON.stringify(events)).not.toMatch(/@example\.com|AdminAud|CoordAud/);
    } finally {
      spy.mockRestore();
    }
  });
});

