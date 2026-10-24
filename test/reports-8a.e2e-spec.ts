/**
 * Módulo 8A (2026-10-23): reportes y exportaciones. Datos reales del torneo (los mismos de las
 * pantallas), permisos por reporte, aislamiento entre torneos, filtros, estados de partido (también
 * «por programar» de 6C), torneo vacío, CSV injection, datos personales y volumen alto. Base en
 * memoria (createTestApp): nunca producción.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types, type Connection } from 'mongoose';
import { strFromU8, unzipSync } from 'fflate';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, SCO: U, OTHER: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const oid = (id: string) => new Types.ObjectId(id);

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const get = (u: U, t: string, report: string, q: Record<string, string> = {}) => as(u).get(`/api/tournaments/${t}/reports/${report}`).query(q).buffer(true).parse(binary);
const csvOf = async (u: U, t: string, report: string, q: Record<string, string> = {}) => {
  const res = await get(u, t, report, { ...q, format: 'csv' }).expect(200);
  return parseCsv((res.body as Buffer).toString('utf8').replace(/^﻿/, ''));
};
const sheets = (b: Buffer) => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(b))).map(([k, v]) => [k, strFromU8(v)]));

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

let seq = 0;
async function tournament(names: string[], by = O, extra: Record<string, unknown> = {}) {
  seq++;
  const t = (await as(by).post('/api/tournaments').send({ name: `Reportes ${seq} Liga Ñandú «Águilas»`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE', ...extra }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (const name of names) {
    const id = (await as(by).post('/api/teams').send({ name: `${name}` }).expect(201)).body.id as string;
    await as(by).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
async function player(t: string, teamId: string, firstName: string, lastName: string, extra: Record<string, unknown> = {}) {
  const id = (await as(O).post('/api/players').send({ firstName, lastName, position: 'FORWARD', confirmNew: true, ...extra }).expect(201)).body.id as string;
  await as(O).put(`/api/tournaments/${t}/players/${id}`).send({ teamId, jerseyNumber: 9 }).expect(200);
  return id;
}
const match = async (t: string, round: number, home: string, away: string, date = '2027-02-01', time = '10:00') =>
  (await as(O).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date, time }).expect(201)).body.id as string;

/** Torneo con datos de todo tipo, compartido por varias pruebas. */
let S: { t: string; A: string; B: string; C: string; D: string; pA: string; pB: string; pC: string; m: Record<string, string> };

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, SCO, OTHER] = [
    await registerOrganizer(http, 'DueñoRep'),
    await registerOrganizer(http, 'AdminRep'),
    await registerOrganizer(http, 'CoordRep'),
    await registerOrganizer(http, 'AnotRep'),
    await registerOrganizer(http, 'OtroRep'),
  ];
  const long = 'Club Deportivo Atlético Unión de Pescadores y Amigos del Puerto de Altata';
  const { t, teams } = await tournament(['Águilas Ñandú', 'Leones "del" Norte, A.C.', long, '=HYPERLINK("http://malo")']);
  const [A, B, C, D] = teams;
  const inv = (r: string) => as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role: r }).expect(201);
  await as(ADM).post(`/api/invitations/${(await inv('ADMIN')).body.token}/accept`).expect(200);
  await as(COO).post(`/api/invitations/${(await inv('COORDINATOR')).body.token}/accept`).expect(200);
  await as(SCO).post(`/api/invitations/${(await inv('SCORER')).body.token}/accept`).expect(200);
  const pA = await player(t, A, 'José', 'Ñúñez Peña', { birthDate: '2009-05-05' });
  const pB = await player(t, B, 'Rival', 'Visitante');
  const pC = await player(t, C, 'Ezequiel', 'Rojo');
  await as(O).put(`/api/tournaments/${t}/discipline/rules`).send({ enabled: true }).expect(200);
  const m = {
    ab: await match(t, 1, A, B, '2027-02-01', '10:00'),
    cd: await match(t, 1, C, D, '2027-02-01', '12:00'),
    ac: await match(t, 2, A, C, '2027-02-08', '10:00'),
    bd: await match(t, 2, B, D, '2027-02-08', '12:00'),
    ad: await match(t, 3, A, D, '2027-02-15', '10:00'),
    bc: await match(t, 3, B, C, '2027-02-15', '12:00'),
  };
  // J1: A 3-1 B (2 de José, 1 de Rival; el tercero de A, autogol de Rival). C 0-0 D con roja directa de Ezequiel.
  await as(O)
    .put(`/api/matches/${m.ab}/result`)
    .send({ homeScore: 3, awayScore: 1, playerStats: [{ playerId: pA, teamId: A, goals: 2, assists: 1, yellowCards: 1, redCards: 0, sendOff: null }, { playerId: pB, teamId: B, goals: 1, assists: 0, ownGoals: 1, yellowCards: 0, redCards: 0, sendOff: null }] })
    .expect(200);
  await as(O).put(`/api/matches/${m.cd}/result`).send({ homeScore: 0, awayScore: 0, playerStats: [{ playerId: pC, teamId: C, goals: 0, assists: 0, yellowCards: 0, redCards: 1, sendOff: 'DIRECT' }] }).expect(200);
  // Estados de la base (6C): pospuesto con fecha previa, «por programar» y cancelado; partido en vivo con estadísticas que NO cuentan.
  await db().collection('matches').updateOne({ _id: oid(m.bd) }, { $set: { status: 'POSTPONED', postponedFrom: { date: '2027-02-08', time: '12:00' } } });
  await db().collection('matches').updateOne({ _id: oid(m.bc) }, { $set: { status: 'POSTPONED', pendingSchedule: true } });
  await db().collection('matches').updateOne({ _id: oid(m.ad) }, { $set: { status: 'CANCELLED' } });
  await db().collection('matches').updateOne({ _id: oid(m.ac) }, { $set: { status: 'LIVE', homeScore: 5, awayScore: 0 } });
  await db().collection('player_match_stats').insertOne({ matchId: oid(m.ac), playerId: oid(pA), teamId: oid(A), played: true, goals: 5, assists: 0, ownGoals: 0, yellowCards: 0, redCards: 0, sendOff: null });
  // Finanzas.
  const entry = (body: Record<string, unknown>) => as(O).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), concept: 'Inscripción', ...body }).expect(201);
  await entry({ teamId: A, kind: 'CHARGE', category: 'ENROLLMENT', amount: 150_000, date: '2026-01-10' });
  await entry({ teamId: A, kind: 'PAYMENT', amount: 50_050, method: 'CASH', concept: '+Abono', date: '2026-01-15' });
  await entry({ teamId: B, kind: 'CHARGE', category: 'ENROLLMENT', amount: 150_000, date: '2026-01-10' });
  S = { t, A, B, C, D, pA, pB, pC, m };
});
afterAll(async () => ctx?.close());

describe('8A — catálogo y permisos', () => {
  it('el catálogo dice qué puede exportar cada rol', async () => {
    const allowed = async (u: U) => Object.fromEntries((await as(u).get(`/api/tournaments/${S.t}/reports`).expect(200)).body.reports.map((r: { id: string; allowed: boolean }) => [r.id, r.allowed]));
    expect(await allowed(O)).toEqual({ standings: true, matches: true, players: true, rosters: true, discipline: true, finance: true, summary: true });
    expect(await allowed(ADM)).toEqual({ standings: true, matches: true, players: true, rosters: true, discipline: true, finance: true, summary: true });
    expect(await allowed(COO)).toEqual({ standings: true, matches: true, players: true, rosters: false, discipline: true, finance: false, summary: true });
    expect(await allowed(SCO)).toEqual({ standings: true, matches: true, players: true, rosters: false, discipline: true, finance: false, summary: true });
    await as(OTHER).get(`/api/tournaments/${S.t}/reports`).expect(403);
  });

  it('leer el torneo no basta: finanzas y plantillas exigen su permiso; torneo ajeno → 403; sin sesión → 401', async () => {
    await get(COO, S.t, 'finance').expect(403);
    await get(SCO, S.t, 'finance', { format: 'csv' }).expect(403);
    await get(COO, S.t, 'rosters').expect(403);
    await get(SCO, S.t, 'rosters', { format: 'xlsx' }).expect(403);
    await get(COO, S.t, 'discipline', { format: 'csv' }).expect(200);
    await get(ADM, S.t, 'finance', { format: 'csv' }).expect(200);
    for (const r of ['standings', 'matches', 'players', 'rosters', 'discipline', 'finance', 'summary']) await get(OTHER, S.t, r, { format: 'csv' }).expect(403);
    await request(http).get(`/api/tournaments/${S.t}/reports/standings`).expect(401);
    await get(O, new Types.ObjectId().toHexString(), 'standings').expect(404);
  });

  it('valida reporte, formato y filtros (un filtro que no aplica no se ignora)', async () => {
    await get(O, S.t, 'nomina').expect(404);
    await get(O, S.t, 'standings', { format: 'docx' }).expect(400);
    await get(O, S.t, 'standings', { teamId: S.A }).expect(400);
    await get(O, S.t, 'summary', { round: '1' }).expect(400);
    await get(O, S.t, 'matches', { status: 'FINISHED,JUGADO' }).expect(400);
    await get(O, S.t, 'matches', { from: '2027-03-01', to: '2027-02-01' }).expect(400);
    await get(O, S.t, 'matches', { from: '01/02/2026' }).expect(400);
    await get(O, S.t, 'players', { teamId: 'abc' }).expect(400);
    await get(O, S.t, 'players', { teamId: new Types.ObjectId().toHexString() }).expect(400);
    await get(O, S.t, 'standings', { phase: '3' }).expect(400);
    await get(O, S.t, 'standings', { group: 'A' }).expect(400);
    await get(O, S.t, 'rosters', { includeInactive: 'quizá' }).expect(400);
  });

  it('cabeceras de descarga: tipo, nombre seguro, sin caché', async () => {
    const res = await get(O, S.t, 'standings', { format: 'xlsx' }).expect(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="tabla-de-posiciones-reportes-\d+-liga-nandu-aguilas-\d{4}-\d{2}-\d{2}\.xlsx"/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const pdf = await get(O, S.t, 'standings').expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('8A — exactitud de los datos', () => {
  it('tabla: igual que GET /standings; nombres con comillas, comas y acentos; fórmula neutralizada', async () => {
    const rows = await csvOf(O, S.t, 'standings');
    const api = (await as(O).get(`/api/tournaments/${S.t}/standings`).expect(200)).body as { position: number; teamId: string; points: number; played: number; goalsFor: number; goalsAgainst: number }[];
    expect(rows[0]).toEqual(['Pos.', 'Equipo', 'PJ', 'G', 'E', 'P', 'GF', 'GC', 'DIF', 'Pts']);
    expect(rows.slice(1).map((r) => Number(r[9]))).toEqual(api.map((s) => s.points));
    expect(rows.slice(1).map((r) => Number(r[2]))).toEqual(api.map((s) => s.played));
    expect(rows[1]).toEqual(['1', 'Águilas Ñandú', '1', '1', '0', '0', '3', '1', '2', '3']);
    const names = rows.slice(1).map((r) => r[1]);
    expect(names).toContain('Leones "del" Norte, A.C.');
    expect(names).toContain(`'=HYPERLINK("http://malo")`);
  });

  it('resultados y calendario: todos los estados; el en vivo no tiene marcador oficial; pospuestos sin fecha vigente', async () => {
    const rows = await csvOf(O, S.t, 'matches');
    const byStatus = Object.fromEntries(rows.slice(1).map((r) => [r[6], r]));
    expect(Object.keys(byStatus).sort()).toEqual(['Cancelado', 'En juego', 'Finalizado', 'Por programar', 'Pospuesto'].sort());
    expect(rows[1].slice(0, 7)).toEqual(['Jornada 1', '2027-02-01', '10:00', 'Águilas Ñandú', '3-1', 'Leones "del" Norte, A.C.', 'Finalizado']);
    expect(byStatus['En juego'][4]).toBe('');
    expect(byStatus['Por programar'].slice(1, 3)).toEqual(['', '']);
    expect(byStatus['Por programar'][10]).toBe('Sin horario asignado');
    expect(byStatus['Pospuesto'].slice(1, 3)).toEqual(['', '']);
    // Filtros: estado «por programar», jornada, equipo y periodo (los pospuestos no tienen fecha vigente).
    expect((await csvOf(O, S.t, 'matches', { status: 'PENDING_SCHEDULE' })).length).toBe(2);
    expect((await csvOf(O, S.t, 'matches', { status: 'POSTPONED' })).slice(1).map((r) => r[6])).toEqual(['Pospuesto']);
    expect((await csvOf(O, S.t, 'matches', { round: '1' })).length).toBe(3);
    expect((await csvOf(O, S.t, 'matches', { teamId: S.A })).length).toBe(4);
    expect((await csvOf(O, S.t, 'matches', { from: '2027-02-08', to: '2027-02-08' })).slice(1).map((r) => r[6])).toEqual(['En juego']);
  });

  it('jugadores: solo partidos finalizados (el en vivo no suma); autogoles aparte', async () => {
    const rows = await csvOf(O, S.t, 'players');
    expect(rows[0]).toEqual(['Pos.', 'Jugador', 'Equipo', 'PJ', 'Goles', 'Prom.', 'Asist.', 'Autogoles', 'Amarillas', 'Rojas']);
    const jose = rows.find((r) => r[1] === 'José Ñúñez Peña')!;
    expect(jose).toEqual(['1', 'José Ñúñez Peña', 'Águilas Ñandú', '1', '2', '2.0', '1', '0', '1', '0']);
    const rival = rows.find((r) => r[1] === 'Rival Visitante')!;
    expect(rival.slice(3, 8)).toEqual(['1', '1', '1.0', '0', '1']);
    expect((await csvOf(O, S.t, 'players', { teamId: S.B })).slice(1).map((r) => r[1])).toEqual(['Rival Visitante']);
  });

  it('plantillas: dorsal y estado, sin fecha de nacimiento; bajas solo si se piden', async () => {
    const xlsx = await get(O, S.t, 'rosters', { format: 'xlsx' }).expect(200);
    const all = Object.values(sheets(xlsx.body as Buffer)).join('\n');
    expect(all).not.toContain('2009-05-05');
    expect(all).not.toMatch(/nacimiento/i);
    const rows = await csvOf(O, S.t, 'rosters');
    const header = rows.findIndex((r) => r[0] === 'Equipo' && r[1] === 'Dorsal');
    expect(rows[header + 1].slice(0, 4)).toEqual(['Águilas Ñandú', '9', 'José Ñúñez Peña', 'Delantero']);
    expect(rows.flat()).not.toContain('2009-05-05');
    await as(O).delete(`/api/tournaments/${S.t}/players/${S.pB}`).send({ reason: 'Se mudó de ciudad' }).expect(204);
    expect((await csvOf(O, S.t, 'rosters')).some((r) => r[2] === 'Rival Visitante')).toBe(false);
    const withInactive = await csvOf(O, S.t, 'rosters', { includeInactive: 'true' });
    const baja = withInactive.find((r) => r[2] === 'Rival Visitante')!;
    expect(baja[6]).toBe('Baja');
    expect(baja[7]).toContain('Se mudó de ciudad');
    await as(O).put(`/api/tournaments/${S.t}/players/${S.pB}`).send({ teamId: S.B }).expect(200);
  });

  it('disciplina: la roja directa genera su sanción, igual que la pestaña Disciplina', async () => {
    const api = (await as(O).get(`/api/tournaments/${S.t}/discipline`).expect(200)).body;
    const rows = await csvOf(O, S.t, 'discipline');
    const sanction = rows.find((r) => r[0] === 'Ezequiel Rojo' && r[2].startsWith('Roja directa'))!;
    expect(sanction).toBeTruthy();
    expect(Number(sanction[4])).toBe(api.sanctions.find((s: { playerId: string }) => s.playerId === S.pC).matches);
    expect(sanction[3]).toMatch(/^J1 · /);
    const cards = rows.find((r) => r[0] === 'Ezequiel Rojo' && r.length === 8 && r[4] === '1');
    expect(cards).toBeTruthy();
    expect((await csvOf(O, S.t, 'discipline', { teamId: S.A })).some((r) => r[0] === 'Ezequiel Rojo')).toBe(false);
  });

  it('finanzas: los totales cuadran con la pestaña Finanzas; la fórmula del concepto se neutraliza', async () => {
    const api = (await as(O).get(`/api/tournaments/${S.t}/finance/accounts`).expect(200)).body;
    const rows = await csvOf(O, S.t, 'finance');
    const total = rows.find((r) => r[0] === 'TOTAL')!;
    expect(total.slice(2, 8).map(Number)).toEqual([api.totals.charged, api.totals.paid, api.totals.discounted, api.totals.refunded, api.totals.due, api.totals.credit].map((c: number) => c / 100));
    expect(rows.some((r) => r[3] === "'+Abono")).toBe(true);
    // Excel: importes como número en unidades.
    const files = sheets((await get(O, S.t, 'finance', { format: 'xlsx' }).expect(200)).body as Buffer);
    const balances = Object.entries(files).find(([k, v]) => k.startsWith('xl/worksheets/') && v.includes('>Movs.<'))![1];
    expect(balances).toContain('<v>1500</v>');
    // Con un equipo: solo su cuenta y sus movimientos.
    const onlyB = await csvOf(O, S.t, 'finance', { teamId: S.B });
    expect(onlyB.find((r) => r[0] === 'TOTAL')!.slice(2, 4)).toEqual(['1500.00', '0.00']);
    expect(onlyB.some((r) => r[3] === "'+Abono")).toBe(false);
  });

  it('resumen: en curso no presenta campeón; finalizado con la estructura lo determina', async () => {
    const active = (await csvOf(O, S.t, 'summary')).map((r) => r[0]);
    expect(active).not.toContain('Campeón');
    expect((await csvOf(O, S.t, 'summary')).find((r) => r[0] === 'Estado')![1]).toBe('En curso (datos parciales)');
    const { t, teams } = await tournament(['Campeones FC', 'Segundos FC']);
    const id = await match(t, 1, teams[0], teams[1]);
    await as(O).put(`/api/matches/${id}/result`).send({ homeScore: 2, awayScore: 0, playerStats: [] }).expect(200);
    await db().collection('tournaments').updateOne({ _id: oid(t) }, { $set: { status: 'FINISHED' } });
    const done = await csvOf(O, t, 'summary');
    expect(done.find((r) => r[0] === 'Campeón')![1]).toBe('Campeones FC');
    expect(done.find((r) => r[0] === 'Partidos programados')![1]).toBe('1');
  });
});

describe('8A — casos límite', () => {
  it('torneo vacío: los 7 reportes en los 3 formatos generan archivos válidos', async () => {
    const { t } = await tournament([]);
    for (const r of ['standings', 'matches', 'players', 'rosters', 'discipline', 'finance', 'summary']) {
      const pdf = (await get(O, t, r).expect(200)).body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      const xlsx = (await get(O, t, r, { format: 'xlsx' }).expect(200)).body as Buffer;
      expect(xlsx.subarray(0, 2).toString()).toBe('PK');
      expect(Object.keys(sheets(xlsx))).toContain('xl/workbook.xml');
      const csv = (await get(O, t, r, { format: 'csv' }).expect(200)).body as Buffer;
      expect(csv.toString('utf8').charCodeAt(0)).toBe(0xfeff);
    }
  });

  it('borrador: solo propietario y colaboradores (otro usuario, 403)', async () => {
    const { t } = await tournament(['Borrador A'], O, { status: 'DRAFT' });
    await get(O, t, 'summary', { format: 'csv' }).expect(200);
    await get(OTHER, t, 'summary', { format: 'csv' }).expect(403);
  });

  it('volumen: 4,100 partidos → PDF rechazado (sugiere Excel/CSV); Excel y CSV completos y rápidos', async () => {
    const { t, teams } = await tournament(['Volumen A', 'Volumen B']);
    const docs = Array.from({ length: 4_100 }, (_, i) => ({
      tournamentId: oid(t),
      round: Math.floor(i / 10) + 1,
      homeTeamId: oid(teams[0]),
      awayTeamId: oid(teams[1]),
      date: '2026-03-01',
      time: '10:00',
      venue: `Cancha ${i}`,
      status: 'FINISHED',
      homeScore: i % 5,
      awayScore: i % 3,
      referees: [],
      stage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await db().collection('matches').insertMany(docs);
    const pdf = await get(O, t, 'matches').expect(400);
    expect(JSON.parse((pdf.body as Buffer).toString()).message).toMatch(/Excel o CSV/);
    const t0 = Date.now();
    const csv = await csvOf(O, t, 'matches');
    expect(csv.length).toBe(4_101);
    const xlsx = sheets((await get(O, t, 'matches', { format: 'xlsx' }).expect(200)).body as Buffer);
    expect(xlsx['xl/worksheets/sheet1.xml']).toContain('<autoFilter ref="A1:K4101"/>');
    expect(Date.now() - t0).toBeLessThan(15_000);
    // Con filtro cabe en un PDF.
    const filtered = await get(O, t, 'matches', { round: '7' }).expect(200);
    expect((filtered.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('demasiadas generaciones simultáneas del mismo usuario → 429 (las demás terminan bien)', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => get(O, S.t, 'summary')));
    const codes = results.map((r) => r.status);
    expect(codes.every((c) => c === 200 || c === 429)).toBe(true);
    expect(codes).toContain(200);
  });
});
