/**
 * Módulo 2C-2 (2026-10-10): incidencias y suspensiones, correcciones arbitrales (VOID) y
 * reprogramación con vista previa y liberación selectiva. API real con replica set en memoria.
 */
import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, SCO: U, OUT: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());

let seq = 0;
type T = { t: string; home: string; away: string };
async function tournament(status: 'ACTIVE' | 'DRAFT' = 'ACTIVE'): Promise<T> {
  seq++;
  const t = (await as(O).post('/api/tournaments').send({ name: `2C2 ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status }).expect(201)).body.id as string;
  const home = (await as(O).post('/api/teams').send({ name: `Local 2C2-${seq}` }).expect(201)).body.id as string;
  const away = (await as(O).post('/api/teams').send({ name: `Visita 2C2-${seq}` }).expect(201)).body.id as string;
  for (const id of [home, away]) await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  return { t, home, away };
}
let round = 0;
const match = async (x: T, date: string, time: string, extra: Record<string, unknown> = {}) =>
  (await as(O).post('/api/matches').send({ tournamentId: x.t, round: ++round, homeTeamId: x.home, awayTeamId: x.away, date, time, ...extra }).expect(201)).body.id as string;
const referee = async (firstName: string) => (await as(O).post('/api/referees').send({ firstName, lastName: `Corr${++seq}` }).expect(201)).body as { id: string; name: string };
const venue = async () => {
  const v = (await as(O).post('/api/venues').send({ name: `Sede 2C2 ${++seq}`, fields: [{ name: 'Cancha 1' }] }).expect(201)).body;
  return v.fields[0].id as string;
};
const assign = (m: string, refereeId: string, role = 'CENTRAL') => as(O).post(`/api/matches/${m}/referees`).send({ refereeId, role }).expect(201);
const refs = async (m: string) => (await as(O).get(`/api/matches/${m}/referees`).expect(200)).body as { centralReferee: string | null; referees: { id: string; refereeId: string; role: string; status: string; substituteFor: string | null; voided: { reason: string; by: string } | null; absenceVoided: { reason: string }[] }[] };
const get = async (m: string) => (await request(http).get(`/api/matches/${m}`).expect(200)).body;
const incidents = async (m: string, who = O) => (await as(who).get(`/api/matches/${m}/incidents`).expect(200)).body as { incidents: { id: string; type: string; status: string; description: string; reportedRole: string; occurredAt: string; resolution: { decision: string | null; note: string | null } | null; voided: { note: string } | null }[]; users: Record<string, string> };
const actions = async (m: string) => ((await as(O).get(`/api/matches/${m}/log`).expect(200)).body.entries as { action: string; reason: string | null; changes: Record<string, { from: unknown; to: unknown }>; released: unknown[] | null; actorRole: string }[]);
const live = (m: string, home = 1, away = 0, who = O) => as(who).put(`/api/matches/${m}/result`).send({ homeScore: home, awayScore: away, status: 'LIVE', playerStats: [] });
const report = (m: string, type: string, description = `Incidencia ${++seq}`, who = O) => as(who).post(`/api/matches/${m}/incidents`).send({ type, description });

async function join(t: string, u: U, role: string) {
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, SCO, OUT] = [
    await registerOrganizer(http, 'Dueño2C2'),
    await registerOrganizer(http, 'Admin2C2'),
    await registerOrganizer(http, 'Coord2C2'),
    await registerOrganizer(http, 'Capt2C2'),
    await registerOrganizer(http, 'Ajeno2C2'),
  ];
});
afterAll(async () => ctx?.close());

// ─── Incidencias ──────────────────────────────────────────────────────────────

describe('incidencias', () => {
  it('registra cada tipo informativo con autor, rol y fecha; sin duplicados; no son públicas', async () => {
    const x = await tournament();
    const m = await match(x, '2027-03-06', '10:00');
    for (const type of ['DELAY', 'FACILITIES', 'SECURITY', 'OTHER']) await report(m, type, `Tipo ${type}`).expect(201);
    await as(O).post(`/api/matches/${m}/incidents`).send({ type: 'DELAY', description: 'Retraso de 20 minutos por tráfico', occurredAt: '2027-03-06T16:20:00.000Z' }).expect(201);
    expect((await as(O).post(`/api/matches/${m}/incidents`).send({ type: 'DELAY', description: 'Retraso de 20 minutos por tráfico' }).expect(409)).body.message).toMatch(/ya está registrada/);
    await as(O).post(`/api/matches/${m}/incidents`).send({ type: 'RAIN', description: 'xx' }).expect(400);
    await as(O).post(`/api/matches/${m}/incidents`).send({ type: 'OTHER', description: '' }).expect(400);

    const list = await incidents(m);
    expect(list.incidents.map((i) => i.type)).toEqual(['DELAY', 'FACILITIES', 'SECURITY', 'OTHER', 'DELAY']);
    expect(list.incidents.every((i) => i.status === 'OPEN' && i.reportedRole === 'OWNER')).toBe(true);
    expect(list.incidents[4].occurredAt).toBe('2027-03-06T16:20:00.000Z');
    expect(Object.values(list.users)).toEqual([expect.stringContaining('Dueño2C2')]);
    // Informativas: el partido sigue igual; nada sale en la vista pública.
    const pub = await get(m);
    expect(pub.status).toBe('SCHEDULED');
    expect(JSON.stringify(pub)).not.toMatch(/Retraso de 20 minutos/);
    expect((await actions(m)).filter((e) => e.action === 'INCIDENT_REPORTED')).toHaveLength(5);
  });

  it('resolver y anular (VOID) incidencias informativas; todo queda en el historial', async () => {
    const x = await tournament();
    const m = await match(x, '2027-03-07', '10:00');
    await report(m, 'FACILITIES', 'Sin agua en vestidores').expect(201);
    await report(m, 'SECURITY', 'Registrada en el partido equivocado').expect(201);
    const [fac, sec] = (await incidents(m)).incidents;
    await as(O).post(`/api/matches/${m}/incidents/${fac.id}/resolve`).send({}).expect(400);
    await as(O).post(`/api/matches/${m}/incidents/${fac.id}/resolve`).send({ note: 'El club llevó garrafones' }).expect(200);
    expect((await as(O).post(`/api/matches/${m}/incidents/${fac.id}/resolve`).send({ note: 'otra vez' }).expect(409)).body.message).toMatch(/ya está resuelta/);
    await as(O).post(`/api/matches/${m}/incidents/${sec.id}/void`).send({}).expect(400);
    await as(O).post(`/api/matches/${m}/incidents/${sec.id}/void`).send({ reason: 'Era del otro partido' }).expect(200);
    await as(O).post(`/api/matches/${m}/incidents/${sec.id}/void`).send({ reason: 'Era del otro partido' }).expect(409);
    await as(O).post(`/api/matches/${m}/incidents/${sec.id}/resolve`).send({ note: 'nada' }).expect(409);

    const list = (await incidents(m)).incidents;
    expect(list[0]).toMatchObject({ status: 'RESOLVED', resolution: { note: 'El club llevó garrafones', decision: null } });
    expect(list[1]).toMatchObject({ status: 'VOID', voided: { note: 'Era del otro partido' } });
    const log = await actions(m);
    expect(log.map((e) => e.action)).toEqual(['CREATED', 'INCIDENT_REPORTED', 'INCIDENT_REPORTED', 'INCIDENT_RESOLVED', 'INCIDENT_VOIDED']);
    expect(log[4].reason).toBe('Era del otro partido');
    // Las incidencias nunca se borran.
    expect(await db().collection('match_incidents').countDocuments({ matchId: new Types.ObjectId(m) })).toBe(2);
  });
});

// ─── Suspensiones ─────────────────────────────────────────────────────────────

describe('suspensión: pendiente de decisión', () => {
  it('suspender un partido en juego lo deja SUSPENDED, sin resultado automático; bloquea ediciones y capturas en vivo', async () => {
    const x = await tournament();
    const m = await match(x, '2027-04-03', '10:00');
    await live(m, 1, 0).expect(200);
    await report(m, 'SUSPENSION', 'Tormenta eléctrica al minuto 30').expect(201);
    const pub = await get(m);
    expect(pub).toMatchObject({ status: 'SUSPENDED', homeScore: 1, awayScore: 0 });
    // Pendiente de decisión: sin cambiar el estado no se edita; no se suspende dos veces.
    expect((await as(O).patch(`/api/matches/${m}`).send({ date: '2027-04-10', reason: 'x' }).expect(409)).body.message).toMatch(/suspendido/);
    expect((await report(m, 'SUSPENSION', 'Otra').expect(409)).body.message).toMatch(/programado o en juego/);
    await as(O).patch(`/api/matches/${m}`).send({ status: 'SUSPENDED' }).expect(409);
    expect((await live(m, 2, 0).expect(409)).body.message).toMatch(/reanúdalo/);
    // Una suspensión se resuelve decidiendo sobre el partido, no con una nota.
    const [inc] = (await incidents(m)).incidents;
    await as(O).post(`/api/matches/${m}/incidents/${inc.id}/resolve`).send({ note: 'ya pasó' }).expect(409);
    // La tabla no lo cuenta y finalizar el torneo lo ve como pendiente.
    expect((await request(http).get(`/api/tournaments/${x.t}/standings`).expect(200)).body.every((r: { played: number }) => r.played === 0)).toBe(true);
    expect((await as(O).post(`/api/tournaments/${x.t}/finish`).send({}).expect(409)).body.message).toMatch(/Quedan 1 partidos/);
  });

  it('PATCH no puede poner SUSPENDED (solo una incidencia); no se suspende en DRAFT ni un partido finalizado', async () => {
    const x = await tournament();
    const m = await match(x, '2027-04-04', '10:00');
    expect((await as(O).patch(`/api/matches/${m}`).send({ status: 'SUSPENDED' }).expect(400)).body.message).toMatch(/incidencia de suspensión/);
    await as(O).put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 0, status: 'FINISHED', playerStats: [] }).expect(200);
    await report(m, 'SUSPENSION').expect(409);
    const d = await tournament('DRAFT');
    const md = await match(d, '2027-04-04', '12:00');
    await report(md, 'SUSPENSION').expect(409);
    await report(md, 'DELAY').expect(201); // las informativas sí
  });

  it('reanudar: vuelve a LIVE con su marcador; exige motivo; cierra la incidencia con la decisión', async () => {
    const x = await tournament();
    const m = await match(x, '2027-04-10', '10:00');
    await live(m, 2, 1).expect(200);
    await report(m, 'SUSPENSION', 'Pelea en la tribuna').expect(201);
    await as(O).patch(`/api/matches/${m}`).send({ status: 'LIVE' }).expect(400);
    await as(O).patch(`/api/matches/${m}`).send({ status: 'LIVE', reason: 'Se restableció el orden' }).expect(200);
    expect(await get(m)).toMatchObject({ status: 'LIVE', homeScore: 2, awayScore: 1 });
    expect((await incidents(m)).incidents[0]).toMatchObject({ status: 'RESOLVED', resolution: { decision: 'RESUMED', note: 'Se restableció el orden' } });
    const last = (await actions(m)).at(-1)!;
    expect(last).toMatchObject({ action: 'SUSPENSION_RESOLVED', reason: 'Se restableció el orden', changes: { status: { from: 'SUSPENDED', to: 'LIVE' }, decision: { from: null, to: 'RESUMED' } } });
  });

  it('reprogramar conserva el marcador parcial (continuación); cancelar solo sin marcador; posponer; terminar con resultado', async () => {
    const x = await tournament();
    // Con marcador parcial: reprogramar sí (se reanudará desde 1–0), cancelar o posponer no.
    const m1 = await match(x, '2027-04-17', '10:00');
    await live(m1, 1, 0).expect(200);
    await report(m1, 'SUSPENSION', 'Lluvia').expect(201);
    expect((await as(O).patch(`/api/matches/${m1}`).send({ status: 'CANCELLED', reason: 'x' }).expect(409)).body.message).toMatch(/resultado o estadísticas/);
    await as(O).patch(`/api/matches/${m1}`).send({ status: 'POSTPONED', reason: 'x' }).expect(409);
    await as(O).patch(`/api/matches/${m1}`).send({ status: 'SCHEDULED', date: '2027-04-24', time: '09:00', reason: 'Se completan los minutos restantes' }).expect(200);
    expect(await get(m1)).toMatchObject({ status: 'SCHEDULED', date: '2027-04-24', homeScore: 1, awayScore: 0 });
    expect((await incidents(m1)).incidents[0].resolution!.decision).toBe('RESCHEDULED');
    // La continuación se juega desde su marcador.
    await as(O).patch(`/api/matches/${m1}`).send({ status: 'LIVE' }).expect(200);
    expect(await get(m1)).toMatchObject({ status: 'LIVE', homeScore: 1 });

    // Sin marcador (suspendido antes de empezar): cancelar y posponer sí.
    const m2 = await match(x, '2027-04-18', '10:00');
    await report(m2, 'SUSPENSION', 'Cancha inundada').expect(201);
    await as(O).patch(`/api/matches/${m2}`).send({ status: 'CANCELLED', reason: 'La liga lo cancela' }).expect(200);
    expect((await incidents(m2)).incidents[0].resolution!.decision).toBe('CANCELLED');
    const m3 = await match(x, '2027-04-19', '10:00');
    await report(m3, 'SUSPENSION', 'Sin árbitro').expect(201);
    await as(O).patch(`/api/matches/${m3}`).send({ status: 'POSTPONED', reason: 'Sin fecha aún' }).expect(200);
    expect(await get(m3)).toMatchObject({ status: 'POSTPONED', postponedFrom: { date: '2027-04-19', time: '10:00' } });

    // Darlo por terminado: capturar el resultado final (cierra la suspensión).
    const m4 = await match(x, '2027-04-20', '10:00');
    await live(m4, 0, 3).expect(200);
    await report(m4, 'SUSPENSION', 'Equipo local abandonó').expect(201);
    await as(O).put(`/api/matches/${m4}/result`).send({ homeScore: 0, awayScore: 3, status: 'FINISHED', playerStats: [] }).expect(200);
    expect((await get(m4)).status).toBe('FINISHED');
    expect((await incidents(m4)).incidents[0].resolution!.decision).toBe('FINISHED');
  });

  it('anular una suspensión registrada por error devuelve el partido a su estado; ya decidida no se anula', async () => {
    const x = await tournament();
    const m = await match(x, '2027-04-25', '10:00');
    await report(m, 'SUSPENSION', 'Partido equivocado').expect(201);
    const [inc] = (await incidents(m)).incidents;
    await as(O).post(`/api/matches/${m}/incidents/${inc.id}/void`).send({ reason: 'Era otro partido' }).expect(200);
    expect((await get(m)).status).toBe('SCHEDULED');
    await live(m).expect(200);
    await report(m, 'SUSPENSION', 'Ahora sí').expect(201);
    const second = (await incidents(m)).incidents[1];
    await as(O).patch(`/api/matches/${m}`).send({ status: 'LIVE', reason: 'Se reanuda' }).expect(200);
    expect((await as(O).post(`/api/matches/${m}/incidents/${second.id}/void`).send({ reason: 'x x' }).expect(409)).body.message).toMatch(/Ya se decidió/);
    expect((await get(m)).status).toBe('LIVE');
  });

  it('carrera: dos suspensiones simultáneas del mismo partido; solo una', async () => {
    const x = await tournament();
    const m = await match(x, '2027-04-26', '10:00');
    const res = await Promise.all([report(m, 'SUSPENSION', 'Una'), report(m, 'SUSPENSION', 'Otra')]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db().collection('match_incidents').countDocuments({ matchId: new Types.ObjectId(m), type: 'SUSPENSION' })).toBe(1);
  });
});

// ─── Correcciones arbitrales ──────────────────────────────────────────────────

describe('correcciones arbitrales (VOID)', () => {
  const correct = (m: string, a: string, body: Record<string, unknown>, who = O) => as(who).post(`/api/matches/${m}/referees/${a}/correct`).send(body);

  it('anular una ausencia: el árbitro vuelve, su sustituto queda VOID con motivo; nada se borra', async () => {
    const x = await tournament();
    const m = await match(x, '2027-05-01', '10:00');
    const [a, b] = [await referee('Ausente'), await referee('Sustituto')];
    await assign(m, a.id);
    const aId = (await refs(m)).referees[0].id;
    await as(O).post(`/api/matches/${m}/referees/${aId}/absence`).send({ substituteId: b.id, note: 'No llegó' }).expect(200);
    expect((await refs(m)).centralReferee).toBe(b.name);

    await correct(m, aId, {}).expect(400); // motivo obligatorio
    await correct(m, aId, { reason: 'x' }).expect(400);
    await correct(m, aId, { reason: 'Sí llegó: el capturista se equivocó de partido' }).expect(200);
    const view = await refs(m);
    expect(view.centralReferee).toBe(a.name);
    const [ra, rb] = view.referees;
    expect(ra).toMatchObject({ refereeId: a.id, status: 'ASSIGNED', absenceVoided: [expect.objectContaining({ reason: 'Sí llegó: el capturista se equivocó de partido', absenceNote: 'No llegó', by: O.id })] });
    expect(rb).toMatchObject({ refereeId: b.id, status: 'VOID', substituteFor: aId, voided: expect.objectContaining({ reason: 'Sí llegó: el capturista se equivocó de partido', role: 'OWNER' }) });
    const last = (await actions(m)).at(-1)!;
    expect(last).toMatchObject({ action: 'REFEREE_CORRECTED', reason: 'Sí llegó: el capturista se equivocó de partido', actorRole: 'OWNER' });
    expect(Object.keys(last.changes).sort()).toEqual(['absence', 'voided']);
    // Sin duplicados: una anulada no se vuelve a anular; lo que no es ausencia ni sustitución, tampoco.
    expect((await correct(m, rb.id, { reason: 'Otra vez' }).expect(409)).body.message).toMatch(/ya está anulada/);
    expect((await correct(m, aId, { reason: 'Otra vez' }).expect(409)).body.message).toMatch(/Quitar/);
    // Lo público no lleva motivos ni quién corrigió.
    expect(JSON.stringify(await get(m))).not.toMatch(/capturista|absenceVoided|voided/);
    // El historial del árbitro no muestra al sustituto anulado.
    const hist = (await as(O).get(`/api/referees/${a.id}/matches`).expect(200)).body;
    expect(hist[0]).toMatchObject({ status: 'ASSIGNED', replacedBy: null });
  });

  it('corregir una sustitución: el sustituto equivocado queda VOID y entra el correcto; o queda sin sustituto', async () => {
    const x = await tournament();
    const m = await match(x, '2027-05-02', '10:00');
    const [a, wrong, right] = [await referee('Titular'), await referee('Equivocado'), await referee('Correcto')];
    await assign(m, a.id);
    const aId = (await refs(m)).referees[0].id;
    await as(O).post(`/api/matches/${m}/referees/${aId}/absence`).send({ substituteId: wrong.id }).expect(200);
    const wrongId = (await refs(m)).referees[1].id;
    await correct(m, wrongId, { reason: 'Lo cubrió otro árbitro', substituteId: right.id }).expect(200);
    let view = await refs(m);
    expect(view.referees.map((r) => [r.refereeId, r.status, r.substituteFor])).toEqual([
      [a.id, 'ABSENT', null],
      [wrong.id, 'VOID', aId],
      [right.id, 'ASSIGNED', aId],
    ]);
    expect(view.centralReferee).toBe(right.name);
    // Sin sustituto: el correcto también era un error.
    await correct(m, view.referees[2].id, { reason: 'Nadie lo sustituyó' }).expect(200);
    view = await refs(m);
    expect(view.referees.map((r) => r.status)).toEqual(['ABSENT', 'VOID', 'VOID']);
    expect(view.centralReferee).toBeNull();
    // Cambiar el sustituto desde la ausencia (no tenía): entra uno nuevo.
    await correct(m, aId, { reason: 'Sí hubo sustituto', substituteId: wrong.id }).expect(200);
    expect((await refs(m)).referees.at(-1)).toMatchObject({ refereeId: wrong.id, status: 'ASSIGNED', substituteFor: aId });
    expect((await actions(m)).filter((e) => e.action === 'REFEREE_CORRECTED')).toHaveLength(3);
  });

  it('restituir valida choques y disponibilidad: si ya arbitra otro partido a esa hora → 409 sin cambios', async () => {
    const x = await tournament();
    const y = await tournament();
    const m1 = await match(x, '2027-05-08', '10:00');
    const m2 = await match(y, '2027-05-08', '10:30');
    const [a, b] = [await referee('Doble'), await referee('Cubre')];
    await assign(m1, a.id);
    const aId = (await refs(m1)).referees[0].id;
    await as(O).post(`/api/matches/${m1}/referees/${aId}/absence`).send({ substituteId: b.id }).expect(200);
    // Ausente en m1: ya no lo ocupa, así que arbitra m2 a la misma hora.
    await assign(m2, a.id);
    const res = await correct(m1, aId, { reason: 'Dicen que sí llegó' }).expect(409);
    expect(res.body.error).toBe('REFEREE_CONFLICT');
    expect((await refs(m1)).referees.map((r) => r.status)).toEqual(['ABSENT', 'ASSIGNED']);
    // Rol ocupado: no se mete un segundo sustituto mientras el actual siga en funciones.
    const [c] = [await referee('Tercero')];
    await correct(m1, aId, { reason: 'Era otro', substituteId: c.id }).expect(200);
    expect((await refs(m1)).referees.map((r) => r.status)).toEqual(['ABSENT', 'VOID', 'ASSIGNED']);
  });

  it('cadena: si el sustituto también faltó, se corrige desde el final', async () => {
    const x = await tournament();
    const m = await match(x, '2027-05-09', '10:00');
    const [a, b, c] = [await referee('Primero'), await referee('Segundo'), await referee('Tercero')];
    await assign(m, a.id);
    const aId = (await refs(m)).referees[0].id;
    await as(O).post(`/api/matches/${m}/referees/${aId}/absence`).send({ substituteId: b.id }).expect(200);
    const bId = (await refs(m)).referees[1].id;
    await as(O).post(`/api/matches/${m}/referees/${bId}/absence`).send({ substituteId: c.id }).expect(200);
    expect((await correct(m, aId, { reason: 'Sí llegó' }).expect(409)).body.message).toMatch(/registros posteriores/);
    // Desde el final: B sí llegó (C queda VOID); después ya se puede corregir A (B queda VOID).
    await correct(m, bId, { reason: 'B sí llegó' }).expect(200);
    expect((await refs(m)).referees.map((r) => r.status)).toEqual(['ABSENT', 'ASSIGNED', 'VOID']);
    await correct(m, aId, { reason: 'A también llegó' }).expect(200);
    const view = await refs(m);
    expect(view.referees.map((r) => r.status)).toEqual(['ASSIGNED', 'VOID', 'VOID']);
    expect(view.referees[1].absenceVoided).toHaveLength(1); // la corrección de B se conserva
    expect(view.centralReferee).toBe(a.name);
  });

  it('carrera: la misma corrección enviada dos veces a la vez se aplica una sola vez', async () => {
    const x = await tournament();
    const m = await match(x, '2027-05-15', '10:00');
    const [a, b] = [await referee('Carrera'), await referee('CarreraSub')];
    await assign(m, a.id);
    const aId = (await refs(m)).referees[0].id;
    await as(O).post(`/api/matches/${m}/referees/${aId}/absence`).send({ substituteId: b.id }).expect(200);
    const res = await Promise.all([correct(m, aId, { reason: 'Sí llegó' }), correct(m, aId, { reason: 'Sí llegó' })]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const view = await refs(m);
    expect(view.referees.map((r) => r.status)).toEqual(['ASSIGNED', 'VOID']);
    expect(view.referees[0].absenceVoided).toHaveLength(1);
    expect((await actions(m)).filter((e) => e.action === 'REFEREE_CORRECTED')).toHaveLength(1);
  });

  it('compatibilidad: asignaciones guardadas antes de 2C-2 (sin los campos nuevos) se corrigen', async () => {
    const x = await tournament();
    const m = await match(x, '2027-05-16', '10:00');
    const [a, b] = [await referee('Viejo'), await referee('ViejoSub')];
    await assign(m, a.id);
    const aId = (await refs(m)).referees[0].id;
    await as(O).post(`/api/matches/${m}/referees/${aId}/absence`).send({ substituteId: b.id }).expect(200);
    await db().collection('matches').updateOne({ _id: new Types.ObjectId(m) }, { $unset: { 'referees.$[].voided': '', 'referees.$[].absenceVoided': '', 'referees.$[].releasedAt': '' } });
    await correct(m, aId, { reason: 'Registro antiguo corregido' }).expect(200);
    expect((await refs(m)).referees.map((r) => r.status)).toEqual(['ASSIGNED', 'VOID']);
  });
});

// ─── Reprogramación con vista previa ──────────────────────────────────────────

describe('reprogramación segura', () => {
  const preview = (m: string, body: Record<string, unknown>, who = O) => as(who).post(`/api/matches/${m}/reschedule-preview`).send(body);
  type Preview = { field: { action: string; conflicts: unknown[] } | null; referees: { assignmentId: string; refereeId: string; action: string; conflicts: unknown[] }[]; release: { field: boolean; assignmentIds: string[] }; needsConfirmation: boolean };

  it('sin conflictos: todo se conserva y se guarda como siempre (con o sin confirmación)', async () => {
    const x = await tournament();
    const f = await venue();
    const m = await match(x, '2027-06-05', '10:00', { fieldId: f });
    const r = await referee('Libre');
    await assign(m, r.id);
    const p = (await preview(m, { date: '2027-06-05', time: '12:00' }).expect(200)).body as Preview;
    expect(p).toMatchObject({ needsConfirmation: false, field: { action: 'KEEP' }, referees: [{ refereeId: r.id, action: 'KEEP' }], release: { field: false, assignmentIds: [] } });
    await as(O).patch(`/api/matches/${m}`).send({ time: '12:00', reason: 'Cambio de horario' }).expect(200);
    await as(O).patch(`/api/matches/${m}`).send({ time: '13:00', reason: 'Otro cambio', release: p.release }).expect(200);
    expect(await get(m)).toMatchObject({ time: '13:00', fieldId: f, centralReferee: r.name });
  });

  it('conflicto de cancha: solo se libera la cancha; los árbitros se conservan; sin confirmar → 409 como antes', async () => {
    const x = await tournament();
    const f = await venue();
    const m1 = await match(x, '2027-06-12', '10:00', { fieldId: f });
    await match(x, '2027-06-12', '12:00', { fieldId: f });
    const r = await referee('Conserva');
    await assign(m1, r.id);
    const p = (await preview(m1, { date: '2027-06-12', time: '12:00' }).expect(200)).body as Preview;
    expect(p).toMatchObject({ needsConfirmation: true, field: { action: 'RELEASE' }, referees: [{ action: 'KEEP' }], release: { field: true, assignmentIds: [] } });
    expect((await as(O).patch(`/api/matches/${m1}`).send({ time: '12:00', reason: 'Lluvia' }).expect(409)).body.error).toBe('FIELD_CONFLICT');
    await as(O).patch(`/api/matches/${m1}`).send({ time: '12:00', reason: 'Lluvia', release: p.release }).expect(200);
    expect(await get(m1)).toMatchObject({ time: '12:00', fieldId: null, venue: null, centralReferee: r.name });
    const last = (await actions(m1)).at(-1)!;
    expect(last).toMatchObject({ action: 'RESCHEDULED', reason: 'Lluvia', released: [{ fieldId: f, referees: [] }] });
  });

  it('conflicto de árbitros: solo se libera el que choca (RELEASED, se conserva); la cancha y el otro árbitro siguen', async () => {
    const x = await tournament();
    const y = await tournament();
    const f = await venue();
    const m1 = await match(x, '2027-06-19', '10:00', { fieldId: f });
    const other = await match(y, '2027-06-19', '16:00');
    const [busy, free] = [await referee('Ocupado'), await referee('Disponible')];
    await assign(m1, busy.id);
    await assign(m1, free.id, 'ASSISTANT_1');
    await assign(other, busy.id);
    const p = (await preview(m1, { date: '2027-06-19', time: '16:00' }).expect(200)).body as Preview;
    expect(p.field!.action).toBe('KEEP');
    expect(p.referees.map((r) => [r.refereeId, r.action])).toEqual([
      [busy.id, 'RELEASE'],
      [free.id, 'KEEP'],
    ]);
    expect((await as(O).patch(`/api/matches/${m1}`).send({ time: '16:00', reason: 'Pedido del local' }).expect(409)).body.error).toBe('REFEREE_CONFLICT');
    // ASSIGNMENTS también hace falta para liberar: el capturista no tiene ni SCHEDULE.
    await as(O).patch(`/api/matches/${m1}`).send({ time: '16:00', reason: 'Pedido del local', release: p.release }).expect(200);
    const view = await refs(m1);
    expect(view.referees.map((r) => [r.refereeId, r.status])).toEqual([
      [busy.id, 'RELEASED'],
      [free.id, 'ASSIGNED'],
    ]);
    expect(view.centralReferee).toBeNull();
    expect((await get(m1)).fieldId).toBe(f);
    // El liberado ya puede volver a un partido a esa hora en otro lado; su historial lo conserva.
    expect((await as(O).get(`/api/referees/${busy.id}/matches`).expect(200)).body.map((h: { status: string }) => h.status).sort()).toEqual(['ASSIGNED', 'RELEASED']);
    expect((await actions(m1)).at(-1)!.released).toEqual([{ matchId: m1, fieldId: null, venue: null, referees: [{ refereeId: busy.id, role: 'CENTRAL' }] }]);
  });

  it('confirmación obsoleta: si la disponibilidad cambió desde la vista previa → 409 RESCHEDULE_STALE con la vista nueva, sin cambios', async () => {
    const x = await tournament();
    const f = await venue();
    const m = await match(x, '2027-06-26', '10:00', { fieldId: f });
    // Vista previa sin choques… y otro partido ocupa la cancha antes de confirmar.
    const p = (await preview(m, { date: '2027-06-26', time: '18:00' }).expect(200)).body as Preview;
    expect(p.needsConfirmation).toBe(false);
    const blocker = await match(x, '2027-06-26', '18:00', { fieldId: f });
    const stale = await as(O).patch(`/api/matches/${m}`).send({ time: '18:00', reason: 'x x', release: p.release }).expect(409);
    expect(stale.body).toMatchObject({ error: 'RESCHEDULE_STALE', preview: { field: { action: 'RELEASE' }, release: { field: true } } });
    expect(await get(m)).toMatchObject({ time: '10:00', fieldId: f });
    // Al revés: la vista decía liberar y el choque desapareció → también se vuelve a revisar.
    const p2 = (await preview(m, { date: '2027-06-26', time: '18:00' }).expect(200)).body as Preview;
    await as(O).delete(`/api/matches/${blocker}`).expect(204);
    expect((await as(O).patch(`/api/matches/${m}`).send({ time: '18:00', reason: 'x x', release: p2.release }).expect(409)).body.preview.release).toEqual({ field: false, assignmentIds: [] });
    expect((await get(m)).fieldId).toBe(f);
  });

  it('carrera: dos torneos mueven a la vez sus partidos al mismo horario con el mismo árbitro; no queda en dos partidos', async () => {
    const x = await tournament();
    const y = await tournament();
    const r = await referee('Disputado');
    const mA = await match(x, '2027-07-03', '08:00');
    const mB = await match(y, '2027-07-03', '20:00');
    await assign(mA, r.id);
    await assign(mB, r.id);
    // Cada vista previa, por separado, dice que se conserva.
    const [pA, pB] = await Promise.all([preview(mA, { date: '2027-07-03', time: '14:00' }), preview(mB, { date: '2027-07-03', time: '14:00' })]);
    expect([pA.body.needsConfirmation, pB.body.needsConfirmation]).toEqual([false, false]);
    const res = await Promise.all([
      as(O).patch(`/api/matches/${mA}`).send({ time: '14:00', reason: 'Movido', release: pA.body.release }),
      as(O).patch(`/api/matches/${mB}`).send({ time: '14:00', reason: 'Movido', release: pB.body.release }),
    ]);
    expect(res.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(['RESCHEDULE_STALE', 'REFEREE_CONFLICT']).toContain(res.find((x) => x.status === 409)!.body.error);
    const at14 = await db().collection('matches').countDocuments({ _id: { $in: [new Types.ObjectId(mA), new Types.ObjectId(mB)] }, time: '14:00', referees: { $elemMatch: { refereeId: new Types.ObjectId(r.id), status: 'ASSIGNED' } } });
    expect(at14).toBe(1);
  });

  it('reprogramar un suspendido usa la misma vista previa y confirmación', async () => {
    const x = await tournament();
    const f = await venue();
    const m = await match(x, '2027-07-10', '10:00', { fieldId: f });
    await match(x, '2027-07-17', '10:00', { fieldId: f });
    await report(m, 'SUSPENSION', 'Apagón').expect(201);
    const p = (await preview(m, { date: '2027-07-17', time: '10:00', status: 'SCHEDULED' }).expect(200)).body as Preview;
    expect(p.release.field).toBe(true);
    await as(O).patch(`/api/matches/${m}`).send({ status: 'SCHEDULED', date: '2027-07-17', reason: 'Se repite', release: p.release }).expect(200);
    expect(await get(m)).toMatchObject({ status: 'SCHEDULED', date: '2027-07-17', fieldId: null });
    const last = (await actions(m)).at(-1)!;
    expect(last).toMatchObject({ action: 'SUSPENSION_RESOLVED', released: [{ fieldId: f }] });
  });
});

// ─── Permisos, revocación y torneos finalizados ──────────────────────────────

describe('permisos 2C-2', () => {
  it('OWNER/ADMIN/COORDINATOR operan; SCORER solo consulta; ajenos nada; revocación inmediata', async () => {
    const x = await tournament();
    await join(x.t, ADM, 'ADMIN');
    await join(x.t, COO, 'COORDINATOR');
    await join(x.t, SCO, 'SCORER');
    const m = await match(x, '2027-08-07', '10:00');
    const [a, b] = [await referee('PermA'), await referee('PermB')];
    await assign(m, a.id);
    const aId = (await refs(m)).referees[0].id;
    await as(O).post(`/api/matches/${m}/referees/${aId}/absence`).send({ substituteId: b.id }).expect(200);

    // SCORER: consulta incidencias e historial; nada más de 2C-2.
    await report(m, 'DELAY', 'Capturista', SCO).expect(403);
    await as(SCO).post(`/api/matches/${m}/referees/${aId}/correct`).send({ reason: 'No puedo' }).expect(403);
    await as(SCO).post(`/api/matches/${m}/reschedule-preview`).send({ date: '2027-08-07', time: '11:00' }).expect(403);
    expect((await incidents(m, SCO)).incidents).toEqual([]);
    // Ajeno: ni consulta.
    await as(OUT).get(`/api/matches/${m}/incidents`).expect(403);
    await report(m, 'DELAY', 'Ajeno', OUT).expect(403);

    // COORDINATOR: incidencias, suspensión, reanudar, corrección arbitral y reprogramación.
    await report(m, 'DELAY', 'Coordinador', COO).expect(201);
    expect((await incidents(m)).incidents[0].reportedRole).toBe('COORDINATOR');
    await as(COO).post(`/api/matches/${m}/referees/${aId}/correct`).send({ reason: 'Sí llegó (coordinador)' }).expect(200);
    expect((await as(COO).post(`/api/matches/${m}/reschedule-preview`).send({ date: '2027-08-07', time: '11:00' }).expect(200)).body.needsConfirmation).toBe(false);
    await live(m, 0, 0).expect(200);
    await report(m, 'SUSPENSION', 'Coordinador suspende', COO).expect(201);
    // SCORER no reanuda ni da por terminado un suspendido (decisión de la incidencia).
    await as(SCO).patch(`/api/matches/${m}`).send({ status: 'LIVE', reason: 'x x' }).expect(403);
    await as(SCO).put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 0, status: 'FINISHED', playerStats: [] }).expect(403);
    // COORDINATOR reanuda (INCIDENTS) pero no captura el resultado final (RESULTS).
    await as(COO).put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 0, status: 'FINISHED', playerStats: [] }).expect(403);
    await as(COO).patch(`/api/matches/${m}`).send({ status: 'LIVE', reason: 'Reanuda coordinador' }).expect(200);
    // ADMIN: también.
    await report(m, 'SECURITY', 'Admin', ADM).expect(201);
    const sec = (await incidents(m)).incidents.find((i) => i.type === 'SECURITY')!;
    await as(ADM).post(`/api/matches/${m}/incidents/${sec.id}/resolve`).send({ note: 'Resuelto admin' }).expect(200);

    // Revocación: el coordinador pierde el acceso de inmediato.
    await as(O).delete(`/api/tournaments/${x.t}/members/${COO.id}`).expect(200);
    await report(m, 'OTHER', 'Ya revocado', COO).expect(403);
    await as(COO).get(`/api/matches/${m}/incidents`).expect(403);
  });

  it('torneo FINISHED: solo lectura (consultar sí; registrar, resolver, corregir o reprogramar no)', async () => {
    const x = await tournament();
    const m = await match(x, '2027-08-14', '10:00');
    const [a, b] = [await referee('FinA'), await referee('FinB')];
    await assign(m, a.id);
    const aId = (await refs(m)).referees[0].id;
    await as(O).post(`/api/matches/${m}/referees/${aId}/absence`).send({ substituteId: b.id }).expect(200);
    await report(m, 'DELAY', 'Antes de cerrar').expect(201);
    const [inc] = (await incidents(m)).incidents;
    await as(O).put(`/api/matches/${m}/result`).send({ homeScore: 1, awayScore: 1, status: 'FINISHED', playerStats: [] }).expect(200);
    await as(O).post(`/api/tournaments/${x.t}/finish`).send({}).expect(200);

    await report(m, 'OTHER', 'Después').expect(409);
    await as(O).post(`/api/matches/${m}/incidents/${inc.id}/resolve`).send({ note: 'tarde' }).expect(409);
    await as(O).post(`/api/matches/${m}/incidents/${inc.id}/void`).send({ reason: 'tarde' }).expect(409);
    await as(O).post(`/api/matches/${m}/referees/${aId}/correct`).send({ reason: 'tarde' }).expect(409);
    await as(O).post(`/api/matches/${m}/reschedule-preview`).send({ date: '2027-08-15', time: '10:00' }).expect(409);
    expect((await incidents(m)).incidents).toHaveLength(1);
  });
});
