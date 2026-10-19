/**
 * Módulo 4C (2026-10-18): estado de cuenta del EQUIPO en solo lectura (F3b) — solo su propietario y
 * delegados, solo lo suyo, sin notas internas, autores, roles ni claves; y los datos que la pestaña
 * Finanzas del organizador usa (estados, saldo a favor, retirados y quitados).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, CLUB: U, DELEGATE: U, RIVAL: U, STRANGER: U;
const as = (u: U) => authed(http, u.token);
let seq = 0;

async function tournament(by = O) {
  return (await as(by).post('/api/tournaments').send({ name: `Fin C ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: `2026-0${(seq % 9) + 1}-01`, status: 'ACTIVE' }).expect(201)).body.id as string;
}
const ownTeam = async (u: U) => (await as(u).post('/api/me/teams').send({ name: `Club C ${++seq}` }).expect(201)).body.id as string;
const enroll = (t: string, team: string, by = O) => as(by).post(`/api/tournaments/${t}/teams/${team}`).expect(201);
const entry = (t: string, body: Record<string, unknown>, who = O) => as(who).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), concept: 'Movimiento', ...body });
const statements = (team: string, who: U) => as(who).get(`/api/teams/${team}/finance`);

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, CLUB, DELEGATE, RIVAL, STRANGER] = [
    await registerOrganizer(http, 'DueñoFinC'),
    await registerOrganizer(http, 'AdminFinC'),
    await registerOrganizer(http, 'ClubFinC'),
    await registerOrganizer(http, 'DelegadoFinC'),
    await registerOrganizer(http, 'RivalFinC'),
    await registerOrganizer(http, 'ExtrañoFinC'),
  ];
});
afterAll(async () => ctx?.close());

describe('4C — estado de cuenta del equipo (solo lectura, F3b)', () => {
  it('propietario y delegado ven lo suyo; organizador, administrador del torneo, otro equipo y anónimo no', async () => {
    const club = await ownTeam(CLUB);
    await as(CLUB).post(`/api/teams/${club}/managers`).send({ userId: DELEGATE.id }).expect(201);
    const rival = await ownTeam(RIVAL);
    const t = await tournament();
    await enroll(t, club);
    await enroll(t, rival);
    const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role: 'ADMIN' }).expect(201)).body;
    await as(ADM).post(`/api/invitations/${inv.token}/accept`).expect(200);
    await entry(t, { teamId: club, kind: 'CHARGE', category: 'ENROLLMENT', amount: 150_000, concept: 'Inscripción', notes: 'NOTA-INTERNA-SECRETA' }).expect(201);
    await entry(t, { teamId: rival, kind: 'CHARGE', amount: 99_999, concept: 'Cargo del rival' }).expect(201);

    for (const u of [CLUB, DELEGATE]) {
      const body = (await statements(club, u).expect(200)).body;
      expect(body.accounts).toHaveLength(1);
      expect(body.accounts[0]).toMatchObject({ tournament: { id: t }, currency: 'MXN', totals: { charged: 150_000, due: 150_000 } });
    }
    // El organizador (aunque registró los movimientos) y su administrador no entran por la vista del equipo.
    for (const u of [O, ADM, RIVAL, STRANGER]) await statements(club, u).expect(403);
    await request(http).get(`/api/teams/${club}/finance`).expect(401);
    await statements('0123456789abcdef01234567', CLUB).expect(404);
    // Y el equipo nunca escribe ni consulta las cuentas del torneo.
    await entry(t, { teamId: club, kind: 'PAYMENT', amount: 100, method: 'CASH' }, CLUB).expect(403);
    await as(CLUB).get(`/api/tournaments/${t}/finance/accounts`).expect(403);
    await as(CLUB).get(`/api/tournaments/${t}/finance/accounts/${club}`).expect(403);
  });

  it('privacidad: sin notas internas, autor, rol, clave de solicitud ni datos de otros equipos', async () => {
    const club = await ownTeam(CLUB);
    const rival = await ownTeam(RIVAL);
    const t = await tournament();
    await enroll(t, club);
    await enroll(t, rival);
    const fine = (await entry(t, { teamId: club, kind: 'CHARGE', category: 'FINE', amount: 20_000, concept: 'Multa', reason: 'Roja directa', notes: 'NOTA-INTERNA-SECRETA' }).expect(201)).body.entry;
    await entry(t, { teamId: club, kind: 'PAYMENT', amount: 25_000, method: 'TRANSFER', reference: 'SPEI 12', allowCredit: true, notes: 'Pagó el tesorero' }).expect(201);
    await entry(t, { teamId: rival, kind: 'CHARGE', amount: 77_777, concept: 'Cargo del rival', notes: 'Otra nota' }).expect(201);
    // 4D: el resumen trae los totales por torneo; los movimientos, la página de cada torneo.
    const summary = (await statements(club, CLUB).expect(200)).body;
    const page = (await as(CLUB).get(`/api/teams/${club}/finance/${t}`).expect(200)).body;
    const body = { accounts: [{ ...summary.accounts[0], entries: page.entries }] };
    const text = JSON.stringify([summary, page]);
    for (const secret of ['NOTA-INTERNA-SECRETA', 'Pagó el tesorero', 'Otra nota', 'Cargo del rival', '77777', O.id, fine.requestId, 'recordedBy', 'recordedRole', 'requestId', 'notes', 'OWNER']) {
      expect(text).not.toContain(secret);
    }
    const [account] = body.accounts;
    expect(account.totals).toMatchObject({ charged: 20_000, paid: 25_000, balance: -5_000, due: 0, credit: 5_000 });
    expect(account.entries.map((e: { kind: string; category: string | null; amount: number; reason: string | null; method: string | null; reference: string | null }) => [e.kind, e.category, e.amount, e.reason, e.method, e.reference])).toEqual([
      ['CHARGE', 'FINE', 20_000, 'Roja directa', null, null],
      ['PAYMENT', null, 25_000, null, 'TRANSFER', 'SPEI 12'],
    ]);
    expect(Object.keys(account.entries[0]).sort()).toEqual(['amount', 'category', 'concept', 'correction', 'createdAt', 'currency', 'date', 'id', 'kind', 'method', 'reason', 'reference', 'voided', 'voidedAt']);
    // La página de otro torneo o de otro equipo no se abre por aquí.
    await as(CLUB).get(`/api/teams/${rival}/finance/${t}`).expect(403);
    await as(RIVAL).get(`/api/teams/${club}/finance/${t}`).expect(403);
  });

  it('varios torneos (también retirado, quitado o finalizado), cada uno con su cuenta; sin movimientos, lista vacía', async () => {
    const club = await ownTeam(CLUB);
    expect((await statements(club, CLUB).expect(200)).body.accounts).toEqual([]);
    const [t1, t2, other] = [await tournament(), await tournament(), await tournament(STRANGER)];
    await enroll(t1, club);
    await enroll(t2, club);
    await enroll(other, club, STRANGER);
    await entry(t1, { teamId: club, kind: 'CHARGE', amount: 1_000 }).expect(201);
    await entry(t2, { teamId: club, kind: 'CHARGE', amount: 2_000 }).expect(201);
    await entry(other, { teamId: club, kind: 'CHARGE', amount: 3_000 }, STRANGER).expect(201);
    await as(O).delete(`/api/tournaments/${t2}/teams/${club}`).expect(204); // quitado: la cuenta sigue
    await as(O).post(`/api/tournaments/${t1}/finish`).send({ allowPendingMatches: true }).expect(200);
    const accounts = (await statements(club, CLUB).expect(200)).body.accounts as { tournament: { id: string; status: string }; totals: { due: number } }[];
    expect(accounts.map((a) => [a.tournament.id, a.totals.due]).sort()).toEqual([[t1, 1_000], [t2, 2_000], [other, 3_000]].sort());
    expect(accounts.find((a) => a.tournament.id === t1)?.tournament.status).toBe('FINISHED');
  });
});
