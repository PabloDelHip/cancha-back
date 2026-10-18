/**
 * Módulo 4B (2026-10-18): cuotas y multas — cargos de inscripción generados (F1), multas manuales
 * con vínculo a partido o jugador (F2), descuentos, saldo a favor con confirmación (F4/F5) y
 * devoluciones. Idempotencia, carreras reales, permisos, aislamiento y compatibilidad (F7, F11).
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types, type Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, SCO: U, OTHER: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const oid = (id: string) => new Types.ObjectId(id);
let seq = 0;

const PAID = { information: { enrollment: { paymentMode: 'paid', teamFee: 1500 } } };
async function tournament(names: string[], extra: Record<string, unknown> = PAID) {
  seq++;
  const t = (await as(O).post('/api/tournaments').send({ name: `Fin B ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE', ...extra }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (const name of names) teams.push(await enroll(t, name));
  return { t, teams };
}
async function enroll(t: string, name: string) {
  const id = (await as(O).post('/api/teams').send({ name: `${name} B${++seq}` }).expect(201)).body.id as string;
  await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  return id;
}
const entry = (t: string, body: Record<string, unknown>, who = O) => as(who).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), concept: 'Movimiento', ...body });
const charge = (t: string, teamId: string, amount: number) => entry(t, { teamId, kind: 'CHARGE', amount });
const pay = (t: string, teamId: string, amount: number, extra: Record<string, unknown> = {}) => entry(t, { teamId, kind: 'PAYMENT', amount, method: 'CASH', ...extra });
const discount = (t: string, teamId: string, amount: number, extra: Record<string, unknown> = {}, who = O) => entry(t, { teamId, kind: 'DISCOUNT', amount, reason: 'Beca del club', ...extra }, who);
const refund = (t: string, teamId: string, amount: number, extra: Record<string, unknown> = {}, who = O) => entry(t, { teamId, kind: 'REFUND', amount, method: 'TRANSFER', ...extra }, who);
const fine = (t: string, teamId: string, amount: number, extra: Record<string, unknown> = {}, who = O) => entry(t, { teamId, kind: 'CHARGE', category: 'FINE', amount, concept: 'Multa', reason: 'Roja directa', ...extra }, who);
const generate = (t: string, who = O, body: Record<string, unknown> = {}) => as(who).post(`/api/tournaments/${t}/finance/enrollment-charges`).send(body);
const totalsOf = async (t: string, teamId: string) => (await as(O).get(`/api/tournaments/${t}/finance/accounts/${teamId}`).expect(200)).body.totals;
const enrollmentCharges = (t: string) => db().collection('finance_entries').find({ tournamentId: oid(t), category: 'ENROLLMENT' }).toArray();
async function join(t: string, u: U, role: string) {
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}
const newPlayer = async () => (await as(O).post('/api/players').send({ firstName: 'Jugador', lastName: `B${++seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
const match = async (t: string, home: string, away: string) =>
  (await as(O).post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: home, awayTeamId: away, date: '2027-02-07', time: '18:00' }).expect(201)).body.id as string;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, SCO, OTHER] = [
    await registerOrganizer(http, 'DueñoFinB'),
    await registerOrganizer(http, 'AdminFinB'),
    await registerOrganizer(http, 'CoordFinB'),
    await registerOrganizer(http, 'AnotFinB'),
    await registerOrganizer(http, 'OtroFinB'),
  ];
});
afterAll(async () => ctx?.close());

describe('4B — cargos de inscripción (F1)', () => {
  it('genera uno por equipo, es idempotente, alcanza a los inscritos después y congela el importe', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const first = (await generate(t).expect(200)).body;
    expect(first).toMatchObject({ amount: 150_000, currency: 'MXN', alreadyCharged: [] });
    expect(first.created.map((e: { teamId: string; amount: number; category: string; kind: string }) => [e.teamId, e.amount, e.kind, e.category])).toEqual([
      [a, 150_000, 'CHARGE', 'ENROLLMENT'],
      [b, 150_000, 'CHARGE', 'ENROLLMENT'],
    ]);
    expect(first.created[0]).toMatchObject({ recordedBy: O.id, recordedRole: 'OWNER', concept: 'Inscripción' });
    // Repetir no duplica.
    expect((await generate(t).expect(200)).body).toMatchObject({ created: [], alreadyCharged: [a, b] });
    // Cambiar la cuota no toca lo ya cargado; el inscrito después recibe la cuota vigente.
    await as(O).patch(`/api/tournaments/${t}`).send({ information: { enrollment: { teamFee: 2000.5 } } }).expect(200);
    const c = await enroll(t, 'Cóndores');
    const later = (await generate(t).expect(200)).body;
    expect(later.created.map((e: { teamId: string; amount: number }) => [e.teamId, e.amount])).toEqual([[c, 200_050]]);
    expect((await enrollmentCharges(t)).map((e) => e.amount).sort()).toEqual([150_000, 150_000, 200_050]);
    expect((await totalsOf(t, a)).due).toBe(150_000);
  });

  it('respeta un cargo de inscripción manual, omite retirados y exige una cuota configurada', async () => {
    const { t, teams: [a, b, w] } = await tournament(['Manual', 'Normal', 'Retirado']);
    await entry(t, { teamId: a, kind: 'CHARGE', category: 'ENROLLMENT', amount: 100_000, concept: 'Inscripción con descuento' }).expect(201);
    await match(t, b, w); // con partidos se retira (sin ellos se quitaría)
    await as(O).post(`/api/tournaments/${t}/teams/${w}/withdraw`).send({ reason: 'Abandonó' }).expect(200);
    const res = (await generate(t).expect(200)).body;
    expect(res.created.map((e: { teamId: string }) => e.teamId)).toEqual([b]);
    expect(res.alreadyCharged).toEqual([a]);
    for (const extra of [{}, { information: { enrollment: { paymentMode: 'free' } } }, { information: { enrollment: { teamFee: 0 } } }]) {
      const free = await tournament(['Gratis'], extra);
      expect((await generate(free.t).expect(409)).body.error).toBe('NO_ENROLLMENT_FEE');
    }
    await generate(t, O, { date: '2999-01-01' }).expect(400);
  });

  it('carrera: 5 generaciones simultáneas dejan exactamente un cargo por equipo', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, teams } = await tournament(['Uno', 'Dos', 'Tres']);
      const res = await Promise.all(Array.from({ length: 5 }, () => generate(t)));
      expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(res.reduce((n, r) => n + r.body.created.length, 0)).toBe(3);
      expect((await enrollmentCharges(t)).map((e) => e.teamId.toHexString()).sort()).toEqual([...teams].sort());
    }
  });
});

describe('4B — multas manuales (F2)', () => {
  it('motivo obligatorio; vínculo opcional a un partido que jugó el equipo y a un jugador de su plantilla', async () => {
    const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
    const m = await match(t, a, b);
    const p = await newPlayer();
    await as(O).put(`/api/tournaments/${t}/players/${p}`).send({ teamId: a }).expect(200);
    await entry(t, { teamId: a, kind: 'CHARGE', category: 'FINE', amount: 20_000, concept: 'Multa' }).expect(400); // sin motivo
    const ok = (await fine(t, a, 20_000, { matchId: m, playerId: p }).expect(201)).body;
    expect(ok.entry).toMatchObject({ kind: 'CHARGE', category: 'FINE', reason: 'Roja directa', matchId: m, playerId: p, recordedBy: O.id, recordedRole: 'OWNER' });
    expect(ok.account).toMatchObject({ charged: 20_000, due: 20_000 });
    await fine(t, a, 5_000).expect(201); // sin vínculos
    expect((await fine(t, c, 5_000, { matchId: m }).expect(409)).body.error).toBe('FINE_MATCH_INVALID'); // no lo jugó
    expect((await fine(t, b, 5_000, { playerId: p }).expect(409)).body.error).toBe('FINE_PLAYER_INVALID'); // no es de su plantilla
    const other = await tournament(['Ajeno']);
    const foreign = await match(other.t, other.teams[0], await enroll(other.t, 'Rival'));
    expect((await fine(t, a, 5_000, { matchId: foreign }).expect(409)).body.error).toBe('FINE_MATCH_INVALID');
    expect((await fine(t, a, 5_000, { matchId: new Types.ObjectId().toHexString() }).expect(409)).body.error).toBe('FINE_MATCH_INVALID');
    await entry(t, { teamId: a, kind: 'CHARGE', amount: 100, matchId: m }).expect(400); // vínculo fuera de una multa
    expect((await totalsOf(t, a)).charged).toBe(25_000);
  });

  it('jugador de un equipo ya quitado del torneo: la multa se sigue pudiendo vincular', async () => {
    const { t, teams: [a] } = await tournament(['Quitado']);
    const p = await newPlayer();
    await as(O).put(`/api/tournaments/${t}/players/${p}`).send({ teamId: a }).expect(200);
    await as(O).delete(`/api/tournaments/${t}/teams/${a}`).expect(204);
    await fine(t, a, 3_000, { playerId: p }).expect(201);
    expect((await totalsOf(t, a)).due).toBe(3_000);
  });
});

describe('4B — descuentos, saldo a favor y devoluciones (F4/F5)', () => {
  it('descuento con motivo y sin superar el adeudo', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await charge(t, a, 10_000).expect(201);
    await entry(t, { teamId: a, kind: 'DISCOUNT', amount: 1_000 }).expect(400); // sin motivo
    await discount(t, a, 1_000, { method: 'CASH' }).expect(400);
    const d = (await discount(t, a, 2_500).expect(201)).body;
    expect(d.entry).toMatchObject({ kind: 'DISCOUNT', reason: 'Beca del club', recordedBy: O.id, recordedRole: 'OWNER', method: null, category: null });
    expect(d.account).toMatchObject({ charged: 10_000, discounted: 2_500, balance: 7_500, due: 7_500 });
    expect((await discount(t, a, 7_501).expect(409)).body).toMatchObject({ error: 'DISCOUNT_EXCEEDS_BALANCE', due: 7_500 });
    await discount(t, a, 7_500).expect(201);
    expect(await totalsOf(t, a)).toMatchObject({ balance: 0, due: 0, credit: 0 });
  });

  it('pago excedente: 409 sin confirmación; con allowCredit queda saldo a favor visible en la cuenta y el torneo', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    await charge(t, a, 10_000).expect(201);
    expect((await pay(t, a, 12_000).expect(409)).body).toMatchObject({ error: 'PAYMENT_EXCEEDS_BALANCE', due: 10_000, creditWouldBe: 2_000 });
    expect((await pay(t, a, 12_000, { allowCredit: false }).expect(409)).body.error).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect((await pay(t, a, 12_000, { allowCredit: true }).expect(201)).body.account).toMatchObject({ paid: 12_000, balance: -2_000, due: 0, credit: 2_000 });
    // Con saldo a favor, cualquier pago adicional también requiere confirmación.
    expect((await pay(t, a, 1).expect(409)).body).toMatchObject({ error: 'PAYMENT_EXCEEDS_BALANCE', credit: 2_000, creditWouldBe: 2_001 });
    // Un cargo posterior consume primero el saldo a favor.
    await charge(t, a, 1_500).expect(201);
    expect(await totalsOf(t, a)).toMatchObject({ balance: -500, credit: 500 });
    await charge(t, b, 4_000).expect(201);
    const list = (await as(O).get(`/api/tournaments/${t}/finance/accounts`).expect(200)).body;
    expect(list.totals).toMatchObject({ charged: 15_500, paid: 12_000, balance: 3_500, due: 4_000, credit: 500 });
    expect(list.accounts.map((x: { teamId: string; credit: number; due: number }) => [x.teamId, x.due, x.credit])).toEqual([[a, 0, 500], [b, 4_000, 0]]);
    await entry(t, { teamId: b, kind: 'CHARGE', amount: 100, allowCredit: true }).expect(400); // solo en pagos
  });

  it('devolución: método obligatorio y nunca mayor que el saldo a favor', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await charge(t, a, 1_000).expect(201);
    expect((await refund(t, a, 1).expect(409)).body).toMatchObject({ error: 'REFUND_EXCEEDS_CREDIT', credit: 0 });
    await pay(t, a, 4_000, { allowCredit: true }).expect(201);
    await entry(t, { teamId: a, kind: 'REFUND', amount: 1_000 }).expect(400); // sin método
    expect((await refund(t, a, 3_001).expect(409)).body).toMatchObject({ error: 'REFUND_EXCEEDS_CREDIT', credit: 3_000 });
    const r = (await refund(t, a, 3_000, { reference: 'SPEI 77', reason: 'Se retiró del torneo' }).expect(201)).body;
    expect(r.entry).toMatchObject({ kind: 'REFUND', method: 'TRANSFER', reference: 'SPEI 77', reason: 'Se retiró del torneo', recordedBy: O.id });
    expect(r.account).toMatchObject({ charged: 1_000, paid: 4_000, refunded: 3_000, balance: 0, credit: 0 });
  });

  it('carrera: dos devoluciones simultáneas que juntas superan el saldo a favor → solo una entra', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, teams: [a] } = await tournament(['Águilas']);
      await pay(t, a, 1_000, { allowCredit: true }).expect(201);
      const res = await Promise.all([refund(t, a, 700), refund(t, a, 700)]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await totalsOf(t, a)).toMatchObject({ refunded: 700, credit: 300, balance: -300 });
    }
  });

  it('carrera: dos pagos excedentes simultáneos sin confirmación → solo el que cabe en el adeudo entra', async () => {
    for (let round = 0; round < 3; round++) {
      const { t, teams: [a] } = await tournament(['Águilas']);
      await charge(t, a, 1_000).expect(201);
      const res = await Promise.all([pay(t, a, 1_000), pay(t, a, 1_000), discount(t, a, 1_000)]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await totalsOf(t, a)).toMatchObject({ balance: 0, due: 0, credit: 0 });
    }
  });

  it('idempotencia: el mismo pago con saldo a favor repetido no duplica; otro motivo con la misma clave → 409', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    const body = { requestId: randomUUID(), teamId: a, kind: 'PAYMENT', amount: 5_000, method: 'CASH', concept: 'Adelanto', allowCredit: true };
    const res = await Promise.all(Array.from({ length: 4 }, () => as(O).post(`/api/tournaments/${t}/finance/entries`).send(body)));
    expect(res.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(res.map((r) => r.body.entry.id)).size).toBe(1);
    expect((await totalsOf(t, a)).credit).toBe(5_000);
    const d = { requestId: randomUUID(), teamId: a, kind: 'REFUND', amount: 1_000, method: 'CASH', concept: 'Devolución', reason: 'A' };
    await as(O).post(`/api/tournaments/${t}/finance/entries`).send(d).expect(201);
    expect((await as(O).post(`/api/tournaments/${t}/finance/entries`).send({ ...d, reason: 'B' }).expect(409)).body.error).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('4B — permisos, aislamiento y compatibilidad', () => {
  it('propietario y administrador sí; coordinador, anotador, otro organizador y anónimo no', async () => {
    const { t, teams: [a] } = await tournament(['Águilas']);
    await join(t, ADM, 'ADMIN');
    await join(t, COO, 'COORDINATOR');
    await join(t, SCO, 'SCORER');
    expect((await generate(t, ADM).expect(200)).body.created[0].recordedRole).toBe('ADMIN');
    await discount(t, a, 100, {}, ADM).expect(201);
    for (const u of [COO, SCO, OTHER]) {
      await generate(t, u).expect(403);
      await fine(t, a, 100, {}, u).expect(403);
      await discount(t, a, 100, {}, u).expect(403);
      await refund(t, a, 100, {}, u).expect(403);
    }
    await request(http).post(`/api/tournaments/${t}/finance/enrollment-charges`).send({}).expect(401);
    expect(await db().collection('finance_entries').countDocuments({ tournamentId: oid(t) })).toBe(2);
  });

  it('aislamiento: el saldo a favor de un torneo no se usa en otro', async () => {
    const one = await tournament(['Compartido']);
    const shared = one.teams[0];
    const two = await tournament([]);
    await as(O).post(`/api/tournaments/${two.t}/teams/${shared}`).expect(201);
    await pay(one.t, shared, 5_000, { allowCredit: true }).expect(201);
    expect((await refund(two.t, shared, 1).expect(409)).body).toMatchObject({ error: 'REFUND_EXCEEDS_CREDIT', credit: 0 });
    expect((await generate(two.t).expect(200)).body.created).toHaveLength(1);
    expect(await totalsOf(two.t, shared)).toMatchObject({ due: 150_000, credit: 0 });
    expect(await totalsOf(one.t, shared)).toMatchObject({ due: 0, credit: 5_000 });
  });

  it('torneo finalizado y equipos retirados: se generan cargos, multas, descuentos y devoluciones', async () => {
    const { t, teams: [a, w] } = await tournament(['Activo', 'Retirado']);
    await generate(t).expect(200);
    await match(t, a, w);
    await as(O).post(`/api/tournaments/${t}/teams/${w}/withdraw`).send({ reason: 'Abandonó' }).expect(200);
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    const late = await enroll(t, 'Tardío').catch(() => null); // no se inscribe en un torneo finalizado
    expect(late).toBeNull();
    expect((await generate(t).expect(200)).body.created).toEqual([]);
    await fine(t, w, 10_000).expect(201);
    await discount(t, w, 50_000).expect(201);
    await pay(t, w, 120_000, { allowCredit: true }).expect(201);
    await refund(t, w, 10_000).expect(201);
    expect(await totalsOf(t, w)).toMatchObject({ charged: 160_000, discounted: 50_000, paid: 120_000, refunded: 10_000, balance: 0 });
    expect((await totalsOf(t, a)).due).toBe(150_000);
  });
});
