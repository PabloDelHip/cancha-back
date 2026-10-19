/**
 * Módulo 4D — rendimiento con volumen: 20 000 movimientos en un torneo (20 equipos, ~1 000 por
 * cuenta) más 5 000 de otro torneo como ruido. Mide las lecturas reales por HTTP y comprueba con
 * `explain` que las consultas usan índices (sin COLLSCAN). Los topes son holgados (máquina de CI);
 * los tiempos medidos se imprimen y se documentan en docs/payments-4.md.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, type Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let O: Awaited<ReturnType<typeof registerOrganizer>>;
const db = () => ctx.app.get<Connection>(getConnectionToken());
const LIMIT_MS = 2_000;
const timings: Record<string, number> = {};

async function timed<T>(label: string, fn: () => Promise<T>) {
  const start = performance.now();
  const out = await fn();
  timings[label] = Math.round(performance.now() - start);
  return out;
}

function ledger(tournamentId: Types.ObjectId, teams: Types.ObjectId[], perTeam: number, user: Types.ObjectId) {
  const docs = [];
  for (const [ti, teamId] of teams.entries()) {
    for (let i = 0; i < perTeam; i++) {
      const kind = i % 4 === 0 ? 'PAYMENT' : i % 10 === 9 ? 'DISCOUNT' : 'CHARGE';
      docs.push({
        tournamentId, teamId, kind, category: kind === 'CHARGE' ? (i % 7 === 0 ? 'FINE' : 'OTHER') : null, amount: 100 + ((i * 37 + ti) % 5_000), currency: 'MXN',
        method: kind === 'PAYMENT' ? (['CASH', 'TRANSFER', 'CARD'] as const)[i % 3] : null, reference: null,
        date: `202${5 + (i % 2)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
        concept: `Movimiento ${i}`, notes: null, reason: kind === 'DISCOUNT' ? 'Beca' : null, matchId: null, playerId: null,
        recordedBy: user, recordedRole: 'OWNER', requestId: randomUUID(), voidedAt: i % 50 === 0 ? new Date() : null,
        voidedBy: null, voidedRole: null, voidReason: null, replaces: null, replacedBy: null, voidRequestId: null,
        createdAt: new Date(Date.UTC(2025, 0, 1) + i * 60_000 + ti),
      });
    }
  }
  return docs;
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  O = await registerOrganizer(http, 'DueñoPerf');
}, 120_000);
afterAll(async () => {
  console.log('4D rendimiento (ms):', JSON.stringify(timings));
  await ctx?.close();
});

it('20 000 movimientos: resumen, estado de cuenta paginado, listado, CSV y vista del equipo, con índices', async () => {
  const as = authed(http, O.token);
  const t = (await as.post('/api/tournaments').send({ name: 'Liga Volumen', format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
  const teams: Types.ObjectId[] = [];
  for (let i = 0; i < 20; i++) {
    const id = (await as.post('/api/me/teams').send({ name: `Equipo Volumen ${i}` }).expect(201)).body.id as string;
    await as.post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(new Types.ObjectId(id));
  }
  const noise = new Types.ObjectId();
  const col = db().collection('finance_entries');
  await col.insertMany(ledger(new Types.ObjectId(t), teams, 1_000, new Types.ObjectId(O.id)));
  await col.insertMany(ledger(noise, teams.slice(0, 5), 1_000, new Types.ObjectId(O.id)));
  const [team] = teams.map(String);

  const summary = (await timed('resumen', () => as.get(`/api/tournaments/${t}/finance/accounts`).expect(200))).body;
  expect(summary.accounts).toHaveLength(20);
  expect(summary.accounts.reduce((n: number, a: { entries: number }) => n + a.entries, 0)).toBe(20 * 980); // 2 % anulados
  const last = (await timed('estado de cuenta (última página)', () => as.get(`/api/tournaments/${t}/finance/accounts/${team}`).expect(200))).body;
  expect(last).toMatchObject({ total: 1_000, pages: 20, page: 20 });
  const first = (await timed('estado de cuenta (página 1)', () => as.get(`/api/tournaments/${t}/finance/accounts/${team}`).query({ page: 1 }).expect(200))).body;
  expect(first.openingBalance).toBe(0);
  // Saldo inicial de la última página + sus movimientos = saldo total de la cuenta.
  const effect = (e: { kind: string; amount: number; voidedAt: string | null }) => (e.voidedAt ? 0 : (e.kind === 'CHARGE' || e.kind === 'REFUND' ? 1 : -1) * e.amount);
  expect(last.openingBalance + last.entries.reduce((n: number, e: Parameters<typeof effect>[0]) => n + effect(e), 0)).toBe(last.totals.balance);
  const list = (await timed('listado filtrado', () => as.get(`/api/tournaments/${t}/finance/entries`).query({ kind: 'PAYMENT', method: 'CARD', from: '2025-01-01', to: '2025-12-31' }).expect(200))).body;
  expect(list.total).toBeGreaterThan(0);
  await timed('listado sin filtros (página 200)', () => as.get(`/api/tournaments/${t}/finance/entries`).query({ page: 200 }).expect(200));
  const csv = await timed('CSV de 20 000 movimientos', () => as.get(`/api/tournaments/${t}/finance/export/entries.csv`).expect(200));
  expect(csv.text.split('\r\n').length).toBe(20_000 + 2); // encabezado + filas + línea final vacía
  await timed('CSV de saldos', () => as.get(`/api/tournaments/${t}/finance/export/balances.csv`).expect(200));
  await timed('vista del equipo (resumen)', () => as.get(`/api/teams/${team}/finance`).expect(200));
  await timed('vista del equipo (página)', () => as.get(`/api/teams/${team}/finance/${t}`).expect(200));
  for (const [label, ms] of Object.entries(timings)) expect(ms, label).toBeLessThan(label.startsWith('CSV de 20') ? LIMIT_MS * 3 : LIMIT_MS);

  // Índices: ninguna de las consultas del libro recorre la colección completa.
  const plans = [
    await col.find({ tournamentId: new Types.ObjectId(t), teamId: teams[0] }).sort({ date: 1, createdAt: 1, _id: 1 }).skip(950).limit(50).explain(),
    await col.find({ tournamentId: new Types.ObjectId(t) }).sort({ date: -1, createdAt: -1, _id: -1 }).limit(50).explain(),
    await col.find({ teamId: teams[0] }).explain(),
  ];
  for (const plan of plans) {
    const text = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(text).toContain('IXSCAN');
    expect(text).not.toContain('COLLSCAN');
    expect(text).not.toContain('"SORT"');
  }
}, 180_000);
