/**
 * Módulo 4A (2026-10-17): base financiera — cuentas por equipo y torneo, cargos manuales, pagos y
 * abonos, saldo derivado, idempotencia, permisos (F3), auditoría, torneo finalizado (F11), equipos
 * retirados o quitados (F7), moneda única (F8) y aislamiento entre torneos.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types, type Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { todayISODate } from '../src/common/utils/dates.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, SCO: U, TM: U, OTHER: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const oid = (id: string) => new Types.ObjectId(id);
const today = todayISODate();
let seq = 0;

async function tournament(names: string[], by = O, extra: Record<string, unknown> = {}) {
  seq++;
  const t = (await as(by).post('/api/tournaments').send({ name: `Fin ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE', ...extra }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (const [i, name] of names.entries()) {
    const id = (await as(by).post('/api/teams').send({ name: `E${i + 1} ${name} F${seq}` }).expect(201)).body.id as string;
    await as(by).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
const entry = (t: string, body: Record<string, unknown>, who = O) => as(who).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), concept: 'Movimiento', ...body });
const charge = (t: string, teamId: string, amount: number, who = O) => entry(t, { teamId, kind: 'CHARGE', amount, category: 'ENROLLMENT', concept: 'Inscripción' }, who);
const pay = (t: string, teamId: string, amount: number, extra: Record<string, unknown> = {}, who = O) => entry(t, { teamId, kind: 'PAYMENT', amount, method: 'CASH', concept: 'Abono', ...extra }, who);
const accounts = (t: string, who = O) => as(who).get(`/api/tournaments/${t}/finance/accounts`);
const account = (t: string, teamId: string, who = O) => as(who).get(`/api/tournaments/${t}/finance/accounts/${teamId}`);
async function join(t: string, u: U, role: string) {
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, SCO, TM, OTHER] = [
    await registerOrganizer(http, 'DueñoFin'),
    await registerOrganizer(http, 'AdminFin'),
    await registerOrganizer(http, 'CoordFin'),
    await registerOrganizer(http, 'AnotFin'),
    await registerOrganizer(http, 'ClubFin'),
    await registerOrganizer(http, 'OtroFin'),
  ];
});
afterAll(async () => ctx?.close());

describe('4A — cargos, pagos y saldo', () => {
  it('cargo manual, abonos parciales y liquidación: saldo derivado, autor, rol, fecha, moneda', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos'], O, { information: { costs: { currency: 'USD' } } });
    await join(t, ADM, 'ADMIN');
    const c = (await charge(t, a, 150_000).expect(201)).body;
    expect(c).toMatchObject({ replayed: false, account: { charged: 150_000, paid: 0, balance: 150_000, entries: 1 } });
    expect(c.entry).toMatchObject({ kind: 'CHARGE', category: 'ENROLLMENT', amount: 150_000, currency: 'USD', date: today, recordedBy: O.id, recordedRole: 'OWNER', method: null, voidedAt: null });
    await pay(t, a, 50_050, { method: 'TRANSFER', reference: 'SPEI 123', date: '2026-02-01' }, ADM).expect(201);
    const last = (await pay(t, a, 99_950).expect(201)).body;
    expect(last.account).toMatchObject({ charged: 150_000, paid: 150_000, balance: 0, entries: 3 });

    const st = (await account(t, a).expect(200)).body;
    expect(st).toMatchObject({ currency: 'USD', totals: { charged: 150_000, paid: 150_000, balance: 0, entries: 3 } });
    expect(st.entries.map((e: { kind: string; date: string }) => [e.kind, e.date])).toEqual([['PAYMENT', '2026-02-01'], ['CHARGE', today], ['PAYMENT', today]]);
    expect(st.entries[0]).toMatchObject({ method: 'TRANSFER', reference: 'SPEI 123', recordedBy: ADM.id, recordedRole: 'ADMIN' });
    expect(Object.keys(st.refs.users).sort()).toEqual([O.id, ADM.id].sort());

    const list = (await accounts(t).expect(200)).body;
    expect(list).toMatchObject({ currency: 'USD', totals: { charged: 150_000, paid: 150_000, balance: 0 } });
    expect(list.accounts.map((x: { teamId: string; balance: number; status: string }) => [x.teamId, x.balance, x.status])).toEqual([[a, 0, 'ENROLLED'], [b, 0, 'ENROLLED']]);
  });

  it('pago mayor que el adeudo (o sin adeudo) → 409 PAYMENT_EXCEEDS_BALANCE (saldos a favor: 4B)', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    expect((await pay(t, a, 100).expect(409)).body).toMatchObject({ error: 'PAYMENT_EXCEEDS_BALANCE', balance: 0 });
    await charge(t, a, 1_000).expect(201);
    expect((await pay(t, a, 1_001).expect(409)).body).toMatchObject({ error: 'PAYMENT_EXCEEDS_BALANCE', balance: 1_000 });
    await pay(t, a, 1_000).expect(201);
  });

  it('validación: centavos enteros positivos, fecha no futura, método solo en pagos, categoría solo en cargos', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await charge(t, a, 10.5).expect(400);
    await charge(t, a, 0).expect(400);
    await charge(t, a, -5).expect(400);
    await charge(t, a, 100_000_000_001).expect(400);
    await entry(t, { teamId: a, kind: 'CHARGE', amount: 100, date: '2999-01-01' }).expect(400);
    await entry(t, { teamId: a, kind: 'CHARGE', amount: 100, method: 'CASH' }).expect(400);
    await entry(t, { teamId: a, kind: 'REFUND', amount: 100 }).expect(400);
    await charge(t, a, 100).expect(201);
    await entry(t, { teamId: a, kind: 'PAYMENT', amount: 50 }).expect(400); // sin método
    await entry(t, { teamId: a, kind: 'PAYMENT', amount: 50, method: 'BITCOIN' }).expect(400);
    await entry(t, { teamId: a, kind: 'PAYMENT', amount: 50, method: 'CASH', category: 'OTHER' }).expect(400);
    await entry(t, { teamId: a, kind: 'CHARGE', amount: 100, concept: 'x' }).expect(400);
    await entry(t, { teamId: a, kind: 'CHARGE', amount: 100, requestId: 'no-uuid' }).expect(400);
    await entry(t, { teamId: a, kind: 'CHARGE', amount: 100, recordedBy: OTHER.id }).expect(400); // campos no permitidos
  });
});

describe('4A — idempotencia y concurrencia', () => {
  it('mismo requestId: devuelve el mismo movimiento; con otro contenido → 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await charge(t, a, 5_000).expect(201);
    const body = { requestId: randomUUID(), teamId: a, kind: 'PAYMENT', amount: 2_000, method: 'CASH', concept: 'Abono' };
    const first = (await as(O).post(`/api/tournaments/${t}/finance/entries`).send(body).expect(201)).body;
    const again = (await as(O).post(`/api/tournaments/${t}/finance/entries`).send(body).expect(201)).body;
    expect(again).toMatchObject({ replayed: true, entry: { id: first.entry.id } });
    expect((await as(O).post(`/api/tournaments/${t}/finance/entries`).send({ ...body, amount: 3_000 }).expect(409)).body.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await account(t, a).expect(200)).body.totals).toMatchObject({ paid: 2_000, balance: 3_000 });
  });

  it('carrera: el mismo pago enviado 5 veces a la vez (doble clic, reintentos) se registra una sola vez', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, teams: [a] } = await tournament(['Águilas']);
      await charge(t, a, 10_000).expect(201);
      const body = { requestId: randomUUID(), teamId: a, kind: 'PAYMENT', amount: 1_000, method: 'CASH', concept: 'Abono' };
      const res = await Promise.all(Array.from({ length: 5 }, () => as(O).post(`/api/tournaments/${t}/finance/entries`).send(body)));
      expect(res.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(res.map((r) => r.body.entry.id)).size).toBe(1);
      expect(await db().collection('finance_entries').countDocuments({ tournamentId: oid(t), kind: 'PAYMENT' })).toBe(1);
    }
  });

  it('carrera: dos pagos distintos que juntos superan el adeudo → solo uno entra; el saldo nunca queda negativo', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, teams: [a] } = await tournament(['Águilas']);
      await charge(t, a, 1_000).expect(201);
      const res = await Promise.all([pay(t, a, 700), pay(t, a, 700)]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      expect((await account(t, a).expect(200)).body.totals).toMatchObject({ paid: 700, balance: 300 });
    }
  });
});

describe('4A — permisos, privacidad y aislamiento', () => {
  it('propietario y administrador sí; coordinador, anotador, equipo, otro organizador y anónimo no', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await join(t, ADM, 'ADMIN');
    await join(t, COO, 'COORDINATOR');
    await join(t, SCO, 'SCORER');
    await charge(t, a, 1_000, ADM).expect(201);
    for (const u of [COO, SCO, OTHER]) {
      await charge(t, a, 1_000, u).expect(403);
      await accounts(t, u).expect(403);
      await account(t, a, u).expect(403);
    }
    await request(http).get(`/api/tournaments/${t}/finance/accounts`).expect(401);
    await request(http).post(`/api/tournaments/${t}/finance/entries`).send({}).expect(401);
    // El dueño del equipo (sin rol en el torneo) no registra ni consulta aquí (su vista de solo lectura: 4C).
    const club = (await as(TM).post('/api/me/teams').send({ name: `Club Fin ${++seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${club}`).expect(201);
    await pay(t, club, 100, {}, TM).expect(403);
    await accounts(t, TM).expect(403);
    // Nada financiero en las lecturas públicas.
    const pub = JSON.stringify([(await request(http).get(`/api/tournaments/${t}`).expect(200)).body, (await request(http).get(`/api/tournaments/${t}/teams`).expect(200)).body]);
    expect(pub).not.toMatch(/balance|finance|charged/);
  });

  it('aislamiento: el mismo equipo en dos torneos tiene dos cuentas; un equipo ajeno al torneo → 409', async () => {
    const one = await tournament(['Águilas']);
    const two = await tournament([], OTHER);
    await as(OTHER).post(`/api/tournaments/${two.t}/teams/${one.teams[0]}`).expect(201);
    await charge(one.t, one.teams[0], 1_000).expect(201);
    await charge(two.t, one.teams[0], 7_000, OTHER).expect(201);
    expect((await account(one.t, one.teams[0]).expect(200)).body.totals.charged).toBe(1_000);
    expect((await account(two.t, one.teams[0], OTHER).expect(200)).body.totals.charged).toBe(7_000);
    await accounts(two.t, O).expect(403);
    const stranger = (await as(O).post('/api/teams').send({ name: `Ajeno ${++seq}` }).expect(201)).body.id as string;
    expect((await charge(one.t, stranger, 100).expect(409)).body.error).toBe('TEAM_NOT_IN_TOURNAMENT');
    await charge(one.t, new Types.ObjectId().toHexString(), 100).expect(404);
    await account(one.t, stranger).expect(409);
  });
});

describe('4A — compatibilidad con torneos y equipos (F7, F8, F11)', () => {
  it('torneo finalizado: se siguen registrando pagos y cargos', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await charge(t, a, 2_000).expect(201);
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    await pay(t, a, 2_000).expect(201);
    await charge(t, a, 500).expect(201);
    expect((await account(t, a).expect(200)).body.totals.balance).toBe(500);
  });

  it('equipo retirado y equipo quitado: la cuenta y su adeudo se conservan y siguen admitiendo pagos', async () => {
    const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Quitado']);
    await charge(t, b, 3_000).expect(201);
    await charge(t, c, 4_000).expect(201);
    await as(O).post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: a, awayTeamId: b, date: '2027-02-07', time: '18:00' }).expect(201);
    await as(O).post(`/api/tournaments/${t}/teams/${b}/withdraw`).send({ reason: 'Abandonó' }).expect(200);
    await as(O).delete(`/api/tournaments/${t}/teams/${c}`).expect(204);
    const list = (await accounts(t).expect(200)).body.accounts;
    expect(list.map((x: { teamId: string; status: string; balance: number }) => [x.teamId, x.status, x.balance])).toEqual([
      [a, 'ENROLLED', 0],
      [b, 'WITHDRAWN', 3_000],
      [c, 'NOT_ENROLLED', 4_000],
    ]);
    await pay(t, b, 3_000).expect(201);
    await pay(t, c, 1_000).expect(201);
    expect((await account(t, c).expect(200)).body.totals.balance).toBe(3_000);
  });

  it('no se borra un torneo ni un equipo con movimientos; la moneda no cambia con movimientos', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await as(O).patch(`/api/tournaments/${t}`).send({ information: { costs: { currency: 'USD' } } }).expect(200); // sin movimientos: libre
    await charge(t, a, 1_000).expect(201);
    expect((await as(O).patch(`/api/tournaments/${t}`).send({ information: { costs: { currency: 'MXN' } } }).expect(409)).body.error).toBe('FINANCE_CURRENCY_LOCKED');
    await as(O).patch(`/api/tournaments/${t}`).send({ information: { costs: { paymentNotes: 'Pagar en la mesa' } } }).expect(200); // otros datos sí
    expect((await as(O).delete(`/api/tournaments/${t}`).expect(409)).body.error).toBe('TOURNAMENT_HAS_FINANCE');
    await as(O).delete(`/api/tournaments/${t}/teams/${a}`).expect(204);
    expect((await as(O).delete(`/api/teams/${a}`).expect(409)).body.error).toBe('TEAM_HAS_FINANCE');
    expect(await db().collection('finance_entries').countDocuments({ tournamentId: oid(t) })).toBe(1);
    // Sin movimientos todo sigue como antes.
    const free = await tournament(['Libre']);
    await as(O).delete(`/api/tournaments/${free.t}`).expect(204);
  });
});
