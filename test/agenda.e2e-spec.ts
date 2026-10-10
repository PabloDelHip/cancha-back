/**
 * Agenda global (Módulo 2C-3, 2026-10-10): partidos de torneos propios y colaboraciones activas,
 * filtros combinables, paginación estable, alcance de catálogos del propietario, RBAC, revocación,
 * aislamiento, torneos finalizados, regresión de 2C-2 y rendimiento. API real.
 */
import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, P: U, C: U, X: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());

type T = { t: string; teams: string[] };
let seq = 0;
async function tournament(owner: U, name: string): Promise<T> {
  const t = (await as(owner).post('/api/tournaments').send({ name, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = (await as(owner).post('/api/teams').send({ name: `${name} E${i} ${++seq}` }).expect(201)).body.id as string;
    await as(owner).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
const rounds = new Map<string, number>();
async function match(owner: U, x: T, date: string, time: string, extra: Record<string, unknown> = {}) {
  const round = (rounds.get(x.t) ?? 0) + 1;
  rounds.set(x.t, round);
  return (await as(owner).post('/api/matches').send({ tournamentId: x.t, round, homeTeamId: x.teams[round % 2 ? 0 : 2], awayTeamId: x.teams[round % 2 ? 1 : 3], date, time, ...extra }).expect(201)).body.id as string;
}
async function join(owner: U, t: string, u: U, role: string) {
  const inv = (await as(owner).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}
type Item = { id: string; date: string; time: string; status: string; tournament: { id: string; name: string; status: string }; homeTeam: { name: string }; awayTeam: { name: string }; venue: string | null; centralReferee: string | null; round: number; roundName: string | null };
type Page = { data: Item[]; meta: { page: number; limit: number; total: number; totalPages: number }; tournaments: { id: string; name: string; myRole: string; permissions: string[] }[] };
const agenda = async (u: U, query: Record<string, string | number | boolean> = {}, status = 200) =>
  (await as(u).get('/api/agenda').query({ limit: 100, ...query }).expect(status)).body as Page;
const ids = (p: Page) => p.data.map((m) => m.id);

// Escenario: O es dueño de T1, T2 y TF (finalizado); P es dueño de TP. C es COORDINATOR en T1 y SCORER en TP.
let T1: T, T2: T, TF: T, TP: T;
let V1: { id: string; fields: string[] }, V2: { id: string; fields: string[] }, VP: { id: string; fields: string[] };
let R1: string, R2: string, RP: string;
const M: Record<string, string> = {};

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, P, C, X] = [await registerOrganizer(http, 'AgendaO'), await registerOrganizer(http, 'AgendaP'), await registerOrganizer(http, 'AgendaC'), await registerOrganizer(http, 'AgendaX')];
  [T1, T2, TF, TP] = [await tournament(O, 'Apertura'), await tournament(O, 'Nocturna'), await tournament(O, 'Clausura Vieja'), await tournament(P, 'Ajena')];
  const venue = async (u: U, name: string, fields: string[]) => {
    const v = (await as(u).post('/api/venues').send({ name, fields: fields.map((f) => ({ name: f })) }).expect(201)).body;
    return { id: v.id as string, fields: v.fields.map((f: { id: string }) => f.id) as string[] };
  };
  V1 = await venue(O, 'Deportivo Norte', ['Cancha 1', 'Cancha 2']);
  V2 = await venue(O, 'Unidad Sur', ['Principal']);
  VP = await venue(P, 'Campo Ajeno', ['Única']);
  const ref = async (u: U, name: string) => (await as(u).post('/api/referees').send({ firstName: name, lastName: 'Agenda', phone: '998 000 0000', email: `${name.toLowerCase()}@example.com` }).expect(201)).body.id as string;
  [R1, R2, RP] = [await ref(O, 'Rita'), await ref(O, 'Raul'), await ref(P, 'Pedro')];

  M.a = await match(O, T1, '2027-03-06', '10:00', { fieldId: V1.fields[0] });
  M.b = await match(O, T1, '2027-03-06', '12:00', { fieldId: V1.fields[1] });
  M.c = await match(O, T2, '2027-03-06', '10:00', { fieldId: V2.fields[0] });
  M.d = await match(O, T2, '2027-03-13', '09:00');
  M.e = await match(O, T1, '2027-03-20', '18:00', { fieldId: V1.fields[0] });
  M.f = await match(O, TF, '2027-02-27', '10:00');
  M.p = await match(P, TP, '2027-03-06', '11:00', { fieldId: VP.fields[0] });
  await as(O).post(`/api/matches/${M.a}/referees`).send({ refereeId: R1, role: 'CENTRAL' }).expect(201);
  await as(O).post(`/api/matches/${M.c}/referees`).send({ refereeId: R2, role: 'CENTRAL' }).expect(201);
  await as(O).post(`/api/matches/${M.e}/referees`).send({ refereeId: R1, role: 'ASSISTANT_1' }).expect(201);
  await as(P).post(`/api/matches/${M.p}/referees`).send({ refereeId: RP, role: 'CENTRAL' }).expect(201);
  await as(O).put(`/api/matches/${M.f}/result`).send({ homeScore: 1, awayScore: 0, status: 'FINISHED', playerStats: [] }).expect(200);
  await as(O).post(`/api/tournaments/${TF.t}/finish`).send({}).expect(200);
  await join(O, T1.t, C, 'COORDINATOR');
  await join(P, TP.t, C, 'SCORER');
});
afterAll(async () => ctx?.close());

describe('alcance', () => {
  it('sin sesión: 401', async () => {
    await request(http).get('/api/agenda').expect(401);
  });

  it('propietario de varios torneos: los suyos en orden cronológico; sin finalizados ni ajenos; con rol y permisos', async () => {
    const p = await agenda(O);
    expect(ids(p)).toEqual([M.a, M.c, M.b, M.d, M.e]);
    expect(p.data[0]).toMatchObject({ tournament: { id: T1.t, name: 'Apertura', status: 'ACTIVE' }, venue: 'Deportivo Norte · Cancha 1', centralReferee: 'Rita Agenda', round: 1 });
    expect(p.data[0].homeTeam.name).toMatch(/^Apertura E0/);
    expect(p.tournaments.map((t) => t.name)).toEqual(['Apertura', 'Nocturna']);
    expect(p.tournaments[0]).toMatchObject({ myRole: 'OWNER', permissions: expect.arrayContaining(['SCHEDULE', 'INCIDENTS']) });
    // Nada de contacto de árbitros ni correcciones internas.
    expect(JSON.stringify(p)).not.toMatch(/998 000|@example\.com|voided|absenceVoided/);
  });

  it('finalizados solo con includeFinished', async () => {
    expect(ids(await agenda(O, { includeFinished: true }))[0]).toBe(M.f);
    expect(ids(await agenda(O, { tournamentId: TF.t }))).toEqual([]);
    expect(ids(await agenda(O, { tournamentId: TF.t, includeFinished: true }))).toEqual([M.f]);
  });

  it('colaborador con roles distintos en torneos de dos propietarios', async () => {
    const p = await agenda(C);
    expect(ids(p)).toEqual([M.a, M.p, M.b, M.e]);
    expect(Object.fromEntries(p.tournaments.map((t) => [t.name, t.myRole]))).toEqual({ Apertura: 'COORDINATOR', Ajena: 'SCORER' });
    expect(p.tournaments.find((t) => t.name === 'Ajena')!.permissions).not.toContain('SCHEDULE');
  });

  it('aislamiento entre propietarios: ni partidos, ni torneos, ni catálogos ajenos', async () => {
    expect(ids(await agenda(P))).toEqual([M.p]);
    await agenda(P, { tournamentId: T1.t }, 404);
    await agenda(P, { venueId: V1.id }, 404);
    await agenda(P, { refereeId: R1 }, 404);
    await agenda(O, { fieldId: VP.fields[0] }, 404);
    await agenda(O, { tournamentId: new Types.ObjectId().toHexString() }, 404);
    expect((await agenda(X)).data).toEqual([]);
  });
});

describe('filtros', () => {
  it('individuales: fechas, torneo, estado, sede, cancha, árbitro', async () => {
    expect(ids(await agenda(O, { from: '2027-03-13' }))).toEqual([M.d, M.e]);
    expect(ids(await agenda(O, { to: '2027-03-06' }))).toEqual([M.a, M.c, M.b]);
    expect(ids(await agenda(O, { from: '2027-03-07', to: '2027-03-19' }))).toEqual([M.d]);
    expect(ids(await agenda(O, { tournamentId: T2.t }))).toEqual([M.c, M.d]);
    expect(ids(await agenda(O, { venueId: V1.id }))).toEqual([M.a, M.b, M.e]);
    expect(ids(await agenda(O, { fieldId: V1.fields[0] }))).toEqual([M.a, M.e]);
    expect(ids(await agenda(O, { refereeId: R1 }))).toEqual([M.a, M.e]);
    expect(ids(await agenda(O, { status: 'FINISHED', includeFinished: true }))).toEqual([M.f]);
    await agenda(O, { from: '2027-04-01', to: '2027-03-01' }, 400);
    await agenda(O, { status: 'RAIN' }, 400);
    await agenda(O, { from: '06/03/2027' }, 400);
  });

  it('combinados (AND) y estado SUSPENDED; varios estados a la vez', async () => {
    expect(ids(await agenda(O, { venueId: V1.id, from: '2027-03-07' }))).toEqual([M.e]);
    expect(ids(await agenda(O, { refereeId: R1, tournamentId: T1.t, to: '2027-03-10' }))).toEqual([M.a]);
    expect(ids(await agenda(O, { venueId: V2.id, tournamentId: T1.t }))).toEqual([]);
    // Una cancha que no es de esa sede: 404 (combinación inexistente).
    await agenda(O, { venueId: V2.id, fieldId: V1.fields[0] }, 404);
    expect(ids(await agenda(O, { venueId: V1.id, fieldId: V1.fields[1] }))).toEqual([M.b]);

    const x = await tournament(O, 'Suspensiones');
    const s = await match(O, x, '2027-05-01', '10:00');
    await as(O).post(`/api/matches/${s}/incidents`).send({ type: 'SUSPENSION', description: 'Tormenta' }).expect(201);
    expect(ids(await agenda(O, { status: 'SUSPENDED' }))).toEqual([s]);
    expect(ids(await agenda(O, { status: 'SUSPENDED,FINISHED', includeFinished: true }))).toEqual([M.f, s]);
  });

  it('catálogos del propietario solo con ASSIGNMENTS: el coordinador filtra por las sedes de O; como anotador de P, no', async () => {
    expect(ids(await agenda(C, { venueId: V1.id }))).toEqual([M.a, M.b, M.e]);
    expect(ids(await agenda(C, { refereeId: R1 }))).toEqual([M.a, M.e]);
    await agenda(C, { venueId: VP.id }, 404);
    await agenda(C, { refereeId: RP }, 404);
    // T2 es de O pero C no colabora ahí: nunca aparece aunque use la sede V2 de O.
    expect(ids(await agenda(C, { venueId: V2.id }))).toEqual([]);
  });

  it('opciones de filtros: torneos, sedes/canchas y árbitros a mi alcance, sin contacto', async () => {
    const own = (await as(O).get('/api/agenda/options').expect(200)).body;
    expect(own.tournaments.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['Apertura', 'Nocturna']));
    expect(own.tournaments.map((t: { name: string }) => t.name)).not.toContain('Clausura Vieja');
    expect(own.venues.map((v: { name: string }) => v.name)).toEqual(['Deportivo Norte', 'Unidad Sur']);
    expect(own.venues[0].fields.map((f: { name: string }) => f.name)).toEqual(['Cancha 1', 'Cancha 2']);
    expect(own.referees.map((r: { name: string }) => r.name).sort()).toEqual(['Raul Agenda', 'Rita Agenda']);
    expect(JSON.stringify(own)).not.toMatch(/998 000|@example\.com/);
    expect((await as(O).get('/api/agenda/options').query({ includeFinished: true }).expect(200)).body.tournaments.map((t: { name: string }) => t.name)).toContain('Clausura Vieja');
    const collab = (await as(C).get('/api/agenda/options').expect(200)).body;
    expect(collab.venues.map((v: { name: string }) => v.name)).toEqual(['Deportivo Norte', 'Unidad Sur']); // de O (coordinador), no de P (anotador)
    expect(collab.referees.map((r: { name: string }) => r.name)).not.toContain('Pedro Agenda');
  });
});

describe('paginación', () => {
  it('orden estable con la misma fecha y hora; cada partido aparece una sola vez', async () => {
    const x = await tournament(O, 'Empates');
    const same: string[] = [];
    for (let i = 0; i < 4; i++) same.push(await match(O, x, '2027-06-05', '09:00'));
    const all: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const p = await agenda(O, { tournamentId: x.t, limit: 2, page });
      expect(p.meta).toMatchObject({ total: 4, totalPages: 2, limit: 2, page });
      all.push(...ids(p));
    }
    expect(all).toEqual([...same].sort());
    // La misma consulta repetida da el mismo orden.
    expect(ids(await agenda(O, { tournamentId: x.t, limit: 2, page: 2 }))).toEqual(all.slice(2));
    await agenda(O, { limit: 101 }, 400);
  });
});

describe('RBAC, revocación y regresión', () => {
  it('las acciones siguen por sus endpoints: coordinador reprograma desde la agenda; anotador no; finalizado solo lectura', async () => {
    const p = await agenda(C, { tournamentId: T1.t });
    const target = p.data.find((m) => m.id === M.b)!;
    const preview = (await as(C).post(`/api/matches/${target.id}/reschedule-preview`).send({ date: '2027-03-21', time: '08:00' }).expect(200)).body;
    await as(C).patch(`/api/matches/${target.id}`).send({ date: '2027-03-21', time: '08:00', reason: 'Desde la agenda', release: preview.release }).expect(200);
    // El nuevo horario se refleja en el orden de la agenda.
    expect(ids(await agenda(C, { tournamentId: T1.t }))).toEqual([M.a, M.e, M.b]);
    // Como anotador en TP no programa ni registra incidencias.
    await as(C).patch(`/api/matches/${M.p}`).send({ time: '12:00', reason: 'No' }).expect(403);
    await as(C).post(`/api/matches/${M.p}/incidents`).send({ type: 'DELAY', description: 'No puedo' }).expect(403);
    // Historial del cambio, consultable por el coordinador.
    expect((await as(C).get(`/api/matches/${M.b}/log`).expect(200)).body.entries.at(-1)).toMatchObject({ action: 'RESCHEDULED', reason: 'Desde la agenda', actorRole: 'COORDINATOR' });
    // Finalizado: aparece con includeFinished, pero no se modifica.
    await as(O).patch(`/api/matches/${M.f}`).send({ venue: 'x' }).expect(409);
  });

  it('revocación: deja de ver el torneo de inmediato y el otro sigue', async () => {
    const x = await tournament(O, 'Revocable');
    const m = await match(O, x, '2027-07-01', '10:00');
    await join(O, x.t, X, 'SCORER');
    expect(ids(await agenda(X))).toEqual([m]);
    await as(O).delete(`/api/tournaments/${x.t}/members/${X.id}`).expect(200);
    expect(ids(await agenda(X))).toEqual([]);
    await agenda(X, { tournamentId: x.t }, 404);
    // C sigue viendo sus torneos.
    expect((await agenda(C)).tournaments.length).toBe(2);
  });
});

describe('rendimiento', () => {
  it('3000 partidos en 12 torneos: página en tiempo acotado y con índice (sin recorrer la colección)', async () => {
    const owner = await registerOrganizer(http, 'AgendaVol');
    const ts: T[] = [];
    for (let i = 0; i < 12; i++) ts.push(await tournament(owner, `Vol ${i}`));
    const docs = [];
    for (let i = 0; i < 3000; i++) {
      const x = ts[i % ts.length];
      const day = String((i % 28) + 1).padStart(2, '0');
      docs.push({
        tournamentId: new Types.ObjectId(x.t),
        round: Math.floor(i / 12) + 1,
        homeTeamId: new Types.ObjectId(x.teams[0]),
        awayTeamId: new Types.ObjectId(x.teams[1]),
        date: `2027-${String((Math.floor(i / 28) % 12) + 1).padStart(2, '0')}-${day}`,
        time: ['09:00', '11:00', '13:00'][i % 3],
        status: 'SCHEDULED',
        homeScore: null,
        awayScore: null,
        referees: [],
        stage: null,
      });
    }
    await db().collection('matches').insertMany(docs);
    const started = Date.now();
    const p = await agenda(owner, { limit: 50, page: 10, from: '2027-02-01', to: '2027-10-31' });
    const elapsed = Date.now() - started;
    expect(p.data).toHaveLength(50);
    expect(p.meta.total).toBeGreaterThan(2000);
    expect(elapsed).toBeLessThan(1500);
    // Plan: usa el índice tournamentId+date+time+_id (sin COLLSCAN ni ordenar en memoria toda la colección).
    const plan = await db()
      .collection('matches')
      .find({ tournamentId: { $in: ts.map((x) => new Types.ObjectId(x.t)) }, date: { $gte: '2027-02-01', $lte: '2027-10-31' } })
      .sort({ date: 1, time: 1, _id: 1 })
      .skip(450)
      .limit(50)
      .explain('executionStats');
    const text = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(text).not.toContain('COLLSCAN');
    expect(text).toContain('tournamentId_1_date_1_time_1__id_1');
    expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(500);
  });
});
