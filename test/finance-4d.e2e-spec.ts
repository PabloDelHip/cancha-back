/**
 * Módulo 4D (2026-10-18): anulación y corrección (F6), reportes (listado con filtros, CSV de
 * movimientos y saldos), estado de cuenta paginado, jugadores históricos para multas, carreras
 * reales, permisos y aislamiento.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types, type Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, OTHER: U, CLUB: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const oid = (id: string) => new Types.ObjectId(id);
let seq = 0;

async function tournament(names: string[], by = O) {
  seq++;
  const t = (await as(by).post('/api/tournaments').send({ name: `Fin D ${seq} Liga Ñandú`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (const name of names) {
    const id = (await as(by).post('/api/teams').send({ name: `${name} D${++seq}` }).expect(201)).body.id as string;
    await as(by).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
const entry = (t: string, body: Record<string, unknown>, who = O) => as(who).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), concept: 'Movimiento', ...body });
const charge = async (t: string, teamId: string, amount: number, extra: Record<string, unknown> = {}) => (await entry(t, { teamId, kind: 'CHARGE', amount, ...extra }).expect(201)).body.entry.id as string;
const pay = async (t: string, teamId: string, amount: number, extra: Record<string, unknown> = {}) => (await entry(t, { teamId, kind: 'PAYMENT', amount, method: 'CASH', allowCredit: true, ...extra }).expect(201)).body.entry.id as string;
const voidIt = (t: string, id: string, extra: Record<string, unknown> = {}, who = O) => as(who).post(`/api/tournaments/${t}/finance/entries/${id}/void`).send({ requestId: randomUUID(), reason: 'Error de captura', ...extra });
const correct = (t: string, id: string, replacement: Record<string, unknown>, extra: Record<string, unknown> = {}, who = O) =>
  as(who).post(`/api/tournaments/${t}/finance/entries/${id}/correct`).send({ requestId: randomUUID(), reason: 'Importe equivocado', entry: { concept: 'Corregido', ...replacement }, ...extra });
const totalsOf = async (t: string, teamId: string) => (await as(O).get(`/api/tournaments/${t}/finance/accounts/${teamId}`).expect(200)).body.totals;
const csv = (t: string, path: string, q: Record<string, string> = {}, who = O) => as(who).get(`/api/tournaments/${t}/finance/export/${path}`).query(q).buffer(true).parse((res, cb) => { let d = ''; res.setEncoding('utf8'); res.on('data', (c: string) => (d += c)); res.on('end', () => cb(null, d)); });
/** Parser CSV mínimo (comillas, comas y saltos dentro de comillas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  return rows;
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, OTHER, CLUB] = [
    await registerOrganizer(http, 'DueñoFinD'),
    await registerOrganizer(http, 'AdminFinD'),
    await registerOrganizer(http, 'CoordFinD'),
    await registerOrganizer(http, 'OtroFinD'),
    await registerOrganizer(http, 'ClubFinD'),
  ];
});
afterAll(async () => ctx?.close());

describe('4D — anulación (F6)', () => {
  it('motivo obligatorio; conserva el original con autor, rol y fecha; recalcula; no se anula dos veces; idempotente', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const c = await charge(t, a, 10_000);
    const p = await pay(t, a, 4_000);
    await as(O).post(`/api/tournaments/${t}/finance/entries/${p}/void`).send({ requestId: randomUUID(), reason: 'x' }).expect(400);
    await as(O).post(`/api/tournaments/${t}/finance/entries/${p}/void`).send({ requestId: randomUUID() }).expect(400);
    const key = randomUUID();
    const res = (await voidIt(t, p, { requestId: key }).expect(200)).body;
    expect(res.entry).toMatchObject({ id: p, voidReason: 'Error de captura', voidedBy: O.id, voidedRole: 'OWNER', amount: 4_000 });
    expect(res.entry.voidedAt).toBeTruthy();
    expect(res.account).toMatchObject({ charged: 10_000, paid: 0, due: 10_000 });
    // La misma clave repetida: la misma anulación; otra clave: 409.
    expect((await voidIt(t, p, { requestId: key }).expect(200)).body).toMatchObject({ replayed: true, entry: { id: p } });
    expect((await voidIt(t, p).expect(409)).body.error).toBe('ENTRY_ALREADY_VOIDED');
    // Sigue en el libro, visible y marcado; fuera del saldo.
    const st = (await as(O).get(`/api/tournaments/${t}/finance/accounts/${a}`).expect(200)).body;
    expect(st.entries.map((e: { id: string; voidedAt: string | null }) => [e.id, Boolean(e.voidedAt)])).toEqual([[c, false], [p, true]]);
    expect(st.totals).toMatchObject({ paid: 0, due: 10_000, entries: 1 });
    expect(Object.keys(st.refs.users)).toContain(O.id);
    expect(await db().collection('finance_entries').countDocuments({ tournamentId: oid(t) })).toBe(2);
  });

  it('no deja estados inválidos: devolución sin pago, descuento sin cargo; saldo a favor solo confirmado', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    await charge(t, a, 1_000);
    const p = await pay(t, a, 1_500); // 500 a favor
    const r = (await entry(t, { teamId: a, kind: 'REFUND', amount: 500, method: 'CASH' }).expect(201)).body.entry.id;
    expect((await voidIt(t, p, { allowCredit: true }).expect(409)).body.error).toBe('VOID_BREAKS_LEDGER');
    // Anular la devolución devuelve el saldo a favor: pide confirmación.
    expect((await voidIt(t, r).expect(409)).body).toMatchObject({ error: 'CREDIT_CONFIRMATION_REQUIRED', credit: 0, creditWouldBe: 500 });
    await voidIt(t, r, { allowCredit: true }).expect(200);
    await voidIt(t, p).expect(200); // ahora sí: la cuenta vuelve a deber 1000
    expect(await totalsOf(t, a)).toMatchObject({ due: 1_000, credit: 0 });
    const cb = await charge(t, b, 1_000);
    await entry(t, { teamId: b, kind: 'DISCOUNT', amount: 200, reason: 'Beca' }).expect(201);
    expect((await voidIt(t, cb, { allowCredit: true }).expect(409)).body.error).toBe('VOID_BREAKS_LEDGER');
  });

  it('anular un cargo de inscripción generado permite volver a generarlo; isolación entre torneos', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await as(O).patch(`/api/tournaments/${t}`).send({ information: { enrollment: { paymentMode: 'paid', teamFee: 1000 } } }).expect(200);
    const gen = (await as(O).post(`/api/tournaments/${t}/finance/enrollment-charges`).send({}).expect(200)).body.created[0].id;
    await voidIt(t, gen).expect(200);
    expect((await as(O).post(`/api/tournaments/${t}/finance/enrollment-charges`).send({}).expect(200)).body.created).toHaveLength(1);
    expect((await totalsOf(t, a)).charged).toBe(100_000);
    const other = await tournament(['Ajeno']);
    await voidIt(other.t, gen).expect(404); // el movimiento no es de ese torneo
    await voidIt(t, new Types.ObjectId().toHexString()).expect(404);
  });

  it('carrera: 5 anulaciones simultáneas del mismo movimiento → una sola', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, teams: [a] } = await tournament(['Águilas']);
      await charge(t, a, 5_000);
      const p = await pay(t, a, 2_000);
      const res = await Promise.all(Array.from({ length: 5 }, () => voidIt(t, p)));
      expect(res.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
      const doc = await db().collection('finance_entries').findOne({ _id: oid(p) });
      expect(doc?.voidRequestId).toBe(res.find((r) => r.status === 200)?.body.entry.voidRequestId);
    }
  });

  it('carrera: anular un pago mientras se devuelve su saldo a favor → nunca queda una devolución sin pago', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, teams: [a] } = await tournament(['Águilas']);
      await charge(t, a, 1_000);
      const p = await pay(t, a, 1_500);
      const res = await Promise.all([voidIt(t, p, { allowCredit: true }), entry(t, { teamId: a, kind: 'REFUND', amount: 500, method: 'CASH' })]);
      // Exactamente uno entra (la anulación 200 o la devolución 201) y el otro recibe 409.
      expect(res.filter((r) => r.status === 409)).toHaveLength(1);
      expect(res.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
      const tt = await totalsOf(t, a);
      expect(tt.refunded).toBeLessThanOrEqual(tt.paid);
    }
  });
});

describe('4D — corrección (anular + reemplazo enlazado)', () => {
  it('atómica, enlazada, idempotente; si el reemplazo es inválido, el original sigue vigente', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const c = await charge(t, a, 10_000);
    const p = await pay(t, a, 3_000);
    const key = randomUUID();
    const res = (await correct(t, p, { kind: 'PAYMENT', amount: 3_500, method: 'TRANSFER', reference: 'SPEI 1' }, { requestId: key }).expect(201)).body;
    expect(res.voided).toMatchObject({ id: p, voidReason: 'Importe equivocado', replacedBy: res.entry.id, voidedRole: 'OWNER' });
    expect(res.entry).toMatchObject({ replaces: p, amount: 3_500, method: 'TRANSFER', teamId: a, recordedBy: O.id });
    expect(res.account).toMatchObject({ paid: 3_500, due: 6_500 });
    expect((await correct(t, p, { kind: 'PAYMENT', amount: 3_500, method: 'TRANSFER', reference: 'SPEI 1' }, { requestId: key }).expect(201)).body).toMatchObject({ replayed: true, entry: { id: res.entry.id } });
    expect((await correct(t, p, { kind: 'PAYMENT', amount: 1, method: 'CASH' }).expect(409)).body.error).toBe('ENTRY_ALREADY_VOIDED');
    // Reemplazo inválido (descuento mayor que el adeudo): nada cambia.
    expect((await correct(t, c, { kind: 'DISCOUNT', amount: 1, reason: 'x' }).expect(409)).body.error).toBe('DISCOUNT_EXCEEDS_BALANCE');
    expect((await correct(t, c, { kind: 'CHARGE', amount: 2_000 }).expect(409)).body).toMatchObject({ error: 'CREDIT_CONFIRMATION_REQUIRED', creditWouldBe: 1_500 });
    expect((await correct(t, c, { kind: 'PAYMENT', amount: 1 }).expect(400)).body.message).toMatch(/método/);
    const docs = await db().collection('finance_entries').find({ tournamentId: oid(t) }).toArray();
    expect(docs.filter((d) => !d.voidedAt).map((d) => d.amount).sort()).toEqual([10_000, 3_500].sort());
    // Con confirmación, el cargo se corrige y queda saldo a favor.
    await correct(t, c, { kind: 'CHARGE', category: 'ENROLLMENT', amount: 2_000 }, { allowCredit: true }).expect(201);
    expect(await totalsOf(t, a)).toMatchObject({ charged: 2_000, paid: 3_500, credit: 1_500 });
  });

  it('carrera: dos correcciones simultáneas del mismo movimiento → una sola, con un solo reemplazo', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, teams: [a] } = await tournament(['Águilas']);
      const c = await charge(t, a, 5_000);
      const res = await Promise.all([correct(t, c, { kind: 'CHARGE', amount: 4_000 }), correct(t, c, { kind: 'CHARGE', amount: 6_000 })]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      const live = await db().collection('finance_entries').find({ tournamentId: oid(t), voidedAt: null }).toArray();
      expect(live).toHaveLength(1);
      expect(live[0].replaces?.toHexString()).toBe(c);
    }
  });
});

describe('4D — estado de cuenta paginado', () => {
  it('saldo inicial de cada página = saldo acumulado real; por defecto la última página', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const docs = Array.from({ length: 120 }, (_, i) => ({
      tournamentId: oid(t), teamId: oid(a), kind: i % 3 === 2 ? 'PAYMENT' : 'CHARGE', category: i % 3 === 2 ? null : 'OTHER', amount: 100 + i, currency: 'MXN', method: i % 3 === 2 ? 'CASH' : null,
      reference: null, date: `2026-0${1 + (i % 9)}-1${i % 10}`, concept: `Mov ${i}`, notes: null, reason: null, matchId: null, playerId: null, recordedBy: oid(O.id), recordedRole: 'OWNER',
      requestId: randomUUID(), voidedAt: i % 17 === 0 ? new Date() : null, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }));
    await db().collection('finance_entries').insertMany(docs);
    const all = (await as(O).get(`/api/tournaments/${t}/finance/accounts/${a}`).query({ limit: 500 }).expect(200)).body;
    const effect = (e: { kind: string; amount: number; voidedAt: string | null }) => (e.voidedAt ? 0 : (e.kind === 'CHARGE' || e.kind === 'REFUND' ? 1 : -1) * e.amount);
    const running: number[] = [];
    all.entries.reduce((b: number, e: Parameters<typeof effect>[0]) => (running.push(b + effect(e)), b + effect(e)), 0);
    const last = (await as(O).get(`/api/tournaments/${t}/finance/accounts/${a}`).query({ limit: 50 }).expect(200)).body;
    expect(last).toMatchObject({ page: 3, pages: 3, total: 120, limit: 50 });
    expect(last.entries).toHaveLength(20);
    expect(last.openingBalance).toBe(running[99]);
    const p2 = (await as(O).get(`/api/tournaments/${t}/finance/accounts/${a}`).query({ limit: 50, page: 2 }).expect(200)).body;
    expect(p2.openingBalance).toBe(running[49]);
    expect(p2.entries[0].id).toBe(all.entries[50].id);
    expect(last.totals.balance).toBe(running[119]);
    expect(p2.totals).toEqual(all.totals);
  });
});

describe('4D — reportes y CSV', () => {
  it('filtros (equipo, tipo, método, periodo, estado) y CSV con BOM, acentos, fórmulas neutralizadas y totales que cuadran', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas Ñandú', 'Búhos']);
    await charge(t, a, 150_000, { category: 'ENROLLMENT', concept: 'Inscripción', date: '2026-01-10' });
    await charge(t, b, 150_000, { category: 'ENROLLMENT', concept: 'Inscripción', date: '2026-01-10' });
    await entry(t, { teamId: a, kind: 'CHARGE', category: 'FINE', amount: 20_000, concept: '=HYPERLINK("http://evil")', reason: '+cmd|calc', date: '2026-02-01' }).expect(201);
    await pay(t, a, 100_000, { method: 'TRANSFER', reference: '@SUM(A1)', date: '2026-02-15', notes: 'Nota «interna»' });
    const wrong = await pay(t, b, 50_000, { date: '2026-03-01' });
    await correct(t, wrong, { kind: 'PAYMENT', amount: 60_000, method: 'CARD', date: '2026-03-01' }).expect(201);
    await entry(t, { teamId: b, kind: 'DISCOUNT', amount: 10_000, reason: 'Pronto pago', date: '2026-03-02' }).expect(201);

    const list = async (q: Record<string, string | number>) => (await as(O).get(`/api/tournaments/${t}/finance/entries`).query(q).expect(200)).body;
    expect((await list({})).total).toBe(7);
    expect((await list({ teamId: a })).total).toBe(3);
    expect((await list({ kind: 'FINE' })).data.map((e: { amount: number }) => e.amount)).toEqual([20_000]);
    expect((await list({ kind: 'PAYMENT', status: 'active' })).total).toBe(2);
    expect((await list({ method: 'CARD' })).total).toBe(1);
    expect((await list({ from: '2026-02-01', to: '2026-02-28' })).total).toBe(2);
    expect((await list({ status: 'voided' })).total).toBe(1);
    expect((await list({ limit: 2, page: 2 })).data).toHaveLength(2);
    await as(O).get(`/api/tournaments/${t}/finance/entries`).query({ from: '2026-03-01', to: '2026-01-01' }).expect(400);
    await as(O).get(`/api/tournaments/${t}/finance/entries`).query({ kind: 'BOGUS' }).expect(400);

    const res = await csv(t, 'entries.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="movimientos-fin-d-\d+-liga-nandu\.csv"/);
    const text = res.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(text.slice(1));
    expect(rows[0].slice(0, 4)).toEqual(['Fecha', 'Equipo', 'Movimiento', 'Categoría']);
    expect(rows).toHaveLength(8);
    expect(text).toContain('Águilas Ñandú');
    expect(text).toContain('Inscripción');
    expect(text).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(text).toContain(`'=HYPERLINK`);
    expect(text).toContain(`'+cmd|calc`);
    expect(text).toContain(`'@SUM(A1)`);
    // Totales: lo vigente del CSV cuadra con la pantalla (por equipo y del torneo).
    const h = rows[0];
    const col = (r: string[], name: string) => r[h.indexOf(name)];
    const live = rows.slice(1).filter((r) => col(r, 'Estado') === 'Vigente');
    const cents = (v: string) => (v ? Math.round(Number(v) * 100) : 0);
    const screen = (await as(O).get(`/api/tournaments/${t}/finance/accounts`).expect(200)).body;
    const csvBalance = live.reduce((n, r) => n + cents(col(r, 'Cargo')) - cents(col(r, 'Abono')), 0);
    expect(csvBalance).toBe(screen.totals.balance);
    expect(rows.slice(1).filter((r) => col(r, 'Estado') === 'Anulado').map((r) => col(r, 'Corrección'))).toEqual([expect.stringMatching(/^Reemplazado por /)]);
    // Con filtro: el CSV y el listado traen lo mismo.
    const filtered = parseCsv(((await csv(t, 'entries.csv', { teamId: b, status: 'active' })).body as string).slice(1));
    expect(filtered.length - 1).toBe((await list({ teamId: b, status: 'active' })).total);

    const bal = parseCsv(((await csv(t, 'balances.csv')).body as string).slice(1));
    const bh = bal[0];
    const total = bal.find((r) => r[0] === 'TOTAL')!;
    expect(cents(total[bh.indexOf('Saldo')])).toBe(screen.totals.balance);
    expect(cents(total[bh.indexOf('Adeudo')])).toBe(screen.totals.due);
    expect(cents(total[bh.indexOf('Saldo a favor')])).toBe(screen.totals.credit);
    for (const acc of screen.accounts) {
      const r = bal.find((x) => x[0] === acc.teamName)!;
      expect([cents(r[bh.indexOf('Cargado')]), cents(r[bh.indexOf('Pagado')]), cents(r[bh.indexOf('Descuentos')]), cents(r[bh.indexOf('Saldo')])]).toEqual([acc.charged, acc.paid, acc.discounted, acc.balance]);
    }
    expect(screen.byCategory).toEqual(expect.arrayContaining([{ category: 'ENROLLMENT', amount: 300_000, entries: 2 }, { category: 'FINE', amount: 20_000, entries: 1 }]));
    expect(screen.byMethod).toEqual(expect.arrayContaining([{ kind: 'PAYMENT', method: 'TRANSFER', amount: 100_000 }, { kind: 'PAYMENT', method: 'CARD', amount: 60_000 }]));
  });
});

describe('4D — jugadores para multas, permisos y entidades', () => {
  it('jugadores históricos de un equipo quitado; multa vinculada', async () => {
    const { t, teams: [a] } = await tournament(['Quitado']);
    const p = (await as(O).post('/api/players').send({ firstName: 'Histórico', lastName: `D${++seq}`, position: 'FORWARD', confirmNew: true }).expect(201)).body.id;
    await as(O).put(`/api/tournaments/${t}/players/${p}`).send({ teamId: a }).expect(200);
    await charge(t, a, 1_000);
    await as(O).delete(`/api/tournaments/${t}/teams/${a}`).expect(204);
    const opts = (await as(O).get(`/api/tournaments/${t}/finance/accounts/${a}/fine-players`).expect(200)).body;
    expect(opts.players).toEqual([expect.objectContaining({ id: p, current: false })]);
    await entry(t, { teamId: a, kind: 'CHARGE', category: 'FINE', amount: 500, reason: 'Agresión', playerId: p }).expect(201);
  });

  it('administrador sí; coordinador, otro organizador, equipo y anónimo no (anular, corregir, listar, exportar)', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const inv = (r: string) => as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role: r }).expect(201);
    await as(ADM).post(`/api/invitations/${(await inv('ADMIN')).body.token}/accept`).expect(200);
    await as(COO).post(`/api/invitations/${(await inv('COORDINATOR')).body.token}/accept`).expect(200);
    const c1 = await charge(t, a, 1_000);
    const c2 = await charge(t, a, 2_000);
    expect((await voidIt(t, c1, {}, ADM).expect(200)).body.entry.voidedRole).toBe('ADMIN');
    for (const u of [COO, OTHER, CLUB]) {
      await voidIt(t, c2, {}, u).expect(403);
      await correct(t, c2, { kind: 'CHARGE', amount: 1 }, {}, u).expect(403);
      await as(u).get(`/api/tournaments/${t}/finance/entries`).expect(403);
      expect((await csv(t, 'entries.csv', {}, u)).status).toBe(403);
      expect((await csv(t, 'balances.csv', {}, u)).status).toBe(403);
      await as(u).get(`/api/tournaments/${t}/finance/accounts/${a}/fine-players`).expect(403);
    }
    await request(http).get(`/api/tournaments/${t}/finance/export/entries.csv`).expect(401);
    expect(await db().collection('finance_entries').countDocuments({ tournamentId: oid(t), voidedAt: null })).toBe(1);
  });

  it('torneo finalizado: se anula y se corrige; con movimientos (también anulados) no se borra torneo ni equipo', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const c = await charge(t, a, 1_000);
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    const r = (await correct(t, c, { kind: 'CHARGE', amount: 900 }).expect(201)).body.entry.id;
    await voidIt(t, r).expect(200);
    expect(await totalsOf(t, a)).toMatchObject({ charged: 0, entries: 0 });
    await as(O).delete(`/api/tournaments/${t}`).expect(409); // finalizado: ya no se borra (regla previa)
    expect((await as(O).delete(`/api/teams/${a}`).expect(409)).body.error).toBe('TEAM_HAS_FINANCE');
    // Torneo activo cuyos movimientos están todos anulados: siguen siendo historia, no se borra.
    const live = await tournament(['Anulado']);
    await voidIt(live.t, await charge(live.t, live.teams[0], 500)).expect(200);
    expect((await as(O).delete(`/api/tournaments/${live.t}`).expect(409)).body.error).toBe('TOURNAMENT_HAS_FINANCE');
  });
});
