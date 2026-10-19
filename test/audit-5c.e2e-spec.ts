/**
 * 5C (2026-10-18) — validación integral del módulo 5 (`docs/audit-5.md` §9).
 *
 * Borrados masivos de partidos con una sanción manual que arranca en un partido que se borra, por
 * los cuatro caminos masivos (regenerar calendario, cambiar formato, quitar un cruce, reacomodo de la
 * eliminatoria): la sanción sigue aplicando desde su posición guardada, no deja datos dependientes
 * del partido borrado y se puede seguir corrigiendo (antes: 400 «El partido no pertenece a este torneo»).
 *
 * Informe de huérfanos (`npm run orphans:report`): detecta lo sembrado, distingue lo histórico
 * esperado y no escribe nada.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { orphanReport } from '../src/scripts/orphan-report.js';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let db: Connection;
let O: Awaited<ReturnType<typeof registerOrganizer>>;
const as = () => authed(http, O.token);
const api = () => request(http);
const oid = (id: string) => new Types.ObjectId(id);
let seq = 0;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  db = ctx.app.get<Connection>(getConnectionToken());
  O = await registerOrganizer(http, 'Cinco C');
});
afterAll(async () => ctx?.close());

type M = { id: string; homeTeamId: string; awayTeamId: string; homeScore: number | null; status: string; stage: { tie: { round: number; slot: number } | null } | null };
async function tournament(settings: Record<string, unknown> = {}) {
  return (await as().post('/api/tournaments').send({ name: `Auditoría 5C ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', settings }).expect(201)).body.id as string;
}
async function teams(t: string, n: number) {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = (await as().post('/api/teams').send({ name: `C${String(i).padStart(2, '0')} ${++seq}` }).expect(201)).body.id as string;
    await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    out.push(id);
  }
  return out;
}
async function enrolled(t: string, teamId: string) {
  const p = (await as().post('/api/players').send({ firstName: 'Sancionado', lastName: `Cinco C ${++seq}`, position: 'DEFENDER', confirmNew: true }).expect(201)).body.id as string;
  await as().put(`/api/tournaments/${t}/players/${p}`).send({ teamId }).expect(200);
  return p;
}
const matchesOf = async (t: string) => (await as().get(`/api/tournaments/${t}/matches`).expect(200)).body as M[];
const sanction = async (t: string, playerId: string, teamId: string, matchId: string) => {
  const o = (await as().post(`/api/tournaments/${t}/discipline/sanctions`).send({ playerId, teamId, matchId, matches: 2, reason: 'Conducta antideportiva' }).expect(201)).body;
  return o.sanctions.find((s: { kind: string; playerId: string }) => s.kind === 'MANUAL' && s.playerId === playerId).ref as string;
};
const result = (m: string, hs: number, aw: number, extra: Record<string, unknown> = {}) =>
  as().put(`/api/matches/${m}/result`).send({ homeScore: hs, awayScore: aw, playerStats: [], ...extra });

/** Lo común tras el borrado: la sanción sigue, sin dependientes huérfanos, y se puede corregir y anular. */
async function expectSanctionSurvives(t: string, ref: string, deletedMatch: string) {
  expect(await db.collection('matches').countDocuments({ _id: oid(deletedMatch) })).toBe(0);
  for (const c of ['match_sheets', 'match_incidents', 'match_evidence']) expect(await db.collection(c).countDocuments({ matchId: oid(deletedMatch) })).toBe(0);
  const o = (await as().get(`/api/tournaments/${t}/discipline`).expect(200)).body;
  const s = o.sanctions.find((x: { ref: string }) => x.ref === ref);
  expect(s).toMatchObject({ kind: 'MANUAL', matchId: deletedMatch, matches: 2 });
  expect(o.refs.matches[deletedMatch]).toBeUndefined(); // el front lo muestra como «Partido eliminado»

  // El diálogo reenvía el partido original: corregir duración y motivo no exige elegir otro partido.
  const fixed = await as()
    .patch(`/api/tournaments/${t}/discipline/sanctions/${ref}`)
    .send({ matches: 3, reason: 'Conducta antideportiva grave', matchId: deletedMatch, justification: 'Informe arbitral' });
  expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
  expect(fixed.body.sanctions.find((x: { ref: string }) => x.ref === ref)).toMatchObject({ matches: 3, matchId: deletedMatch });
  await as().post(`/api/tournaments/${t}/discipline/sanctions/${ref}/annul`).send({ justification: 'Apelación aceptada' }).expect(200);
}

describe('5C — borrados masivos de partidos con sanciones manuales', () => {
  it('regenerar el calendario', async () => {
    const t = await tournament();
    const [a, b] = await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const m = (await matchesOf(t))[0];
    const ref = await sanction(t, await enrolled(t, a), a, m.id);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-03-06', legs: 2, replaceExisting: true }).expect(201);
    await expectSanctionSurvives(t, ref, m.id);
    void b;
  });

  it('cambiar el formato (resetSchedule)', async () => {
    const t = await tournament({ system: 'LEAGUE' });
    const [a] = await teams(t, 4);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const m = (await matchesOf(t)).find((x) => x.homeTeamId === a || x.awayTeamId === a)!;
    const ref = await sanction(t, await enrolled(t, a), a, m.id);
    await as().patch(`/api/tournaments/${t}`).send({ settings: { system: 'KNOCKOUT' }, resetSchedule: true }).expect(200);
    expect(await matchesOf(t)).toHaveLength(0);
    await expectSanctionSurvives(t, ref, m.id);
  });

  it('quitar un cruce armado a mano', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const [a, b] = await teams(t, 4);
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 4 }).expect(201);
    await as().post(`/api/tournaments/${t}/phases/0/ties`).send({ round: 0, homeTeamId: a, awayTeamId: b, legs: [{ date: '2027-05-01', time: '18:00' }] }).expect(201);
    const m = (await matchesOf(t))[0];
    const ref = await sanction(t, await enrolled(t, a), a, m.id);
    await as().delete(`/api/tournaments/${t}/phases/0/ties/0/0`).expect(200);
    await expectSanctionSurvives(t, ref, m.id);
  });

  it('reacomodo automático de la eliminatoria (la final se borra al corregir una semifinal)', async () => {
    const t = await tournament({ system: 'KNOCKOUT', reseed: false });
    await teams(t, 4);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const semis = await matchesOf(t);
    for (const s of semis) await result(s.id, 1, 0).expect(200);
    const final = (await matchesOf(t)).find((x) => x.stage?.tie?.round === 1)!;
    expect(final).toBeDefined();
    const ref = await sanction(t, await enrolled(t, final.homeTeamId), final.homeTeamId, final.id);
    await result(semis[0].id, 0, 0).expect(200); // empate sin penales: la final pierde un equipo y se borra
    expect((await matchesOf(t)).some((x) => x.id === final.id)).toBe(false);
    await expectSanctionSurvives(t, ref, final.id);
  });

  it('cambiar el partido de inicio a uno que no es del torneo sigue rechazándose', async () => {
    const t = await tournament();
    const [a] = await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const [m] = await matchesOf(t);
    const ref = await sanction(t, await enrolled(t, a), a, m.id);
    await as()
      .patch(`/api/tournaments/${t}/discipline/sanctions/${ref}`)
      .send({ matchId: new Types.ObjectId().toHexString(), justification: 'Prueba' })
      .expect(400);
    void api;
  });
});

describe('5C — informe de referencias huérfanas (solo lectura)', () => {
  it('detecta referencias sembradas, clasifica las históricas como esperadas y no modifica la base', async () => {
    const t = await tournament();
    const [a, b] = await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const [m] = await matchesOf(t);
    const p = await enrolled(t, a);
    const ref = await sanction(t, p, a, m.id);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-03-06', replaceExisting: true }).expect(201); // la sanción queda «desde un partido eliminado»

    // Datos heredados como los de antes de 5B (insertados a mano: la API ya no lo permite).
    const ghostPlayer = new Types.ObjectId();
    const ghostMatch = new Types.ObjectId();
    const legacy = await db.collection('sanctions').insertOne({ tournamentId: oid(t), kind: 'MANUAL', key: null, playerId: ghostPlayer, teamId: oid(a), cause: 'MANUAL', matchId: ghostMatch, matches: 1, start: null, annulled: false, createdBy: oid(O.id) });
    const sheet = await db.collection('match_sheets').insertOne({ tournamentId: oid(t), matchId: ghostMatch, teams: [{ teamId: oid(b), players: [{ playerId: ghostPlayer }], substitutions: [] }] });

    const before = await Promise.all((await db.db!.listCollections().toArray()).map(async (c) => [c.name, await db.collection(c.name).countDocuments()] as const));
    const report = await orphanReport(db.db!);
    const after = await Promise.all(before.map(async ([name]) => [name, await db.collection(name).countDocuments()] as const));
    expect(after).toEqual(before);

    const find = (collection: string, field: string, severity: string) => report.find((f) => f.collection === collection && f.field === field && f.severity === severity);
    expect(find('sanctions', 'playerId', 'problem')?.sample).toContain(String(legacy.insertedId));
    expect(find('sanctions', 'matchId', 'problem')?.sample).toContain(String(legacy.insertedId)); // manual sin posición guardada
    expect(find('match_sheets', 'teams.players.playerId', 'problem')?.sample).toContain(String(sheet.insertedId));
    expect(find('match_sheets', 'matchId', 'problem')?.sample).toContain(String(sheet.insertedId));
    // La sanción creada por la API, cuyo partido borró la regeneración, es histórica esperada.
    expect(find('sanctions', 'matchId', 'expected')?.sample).toContain(ref);
    expect(report.filter((f) => f.severity === 'problem').flatMap((f) => f.sample)).not.toContain(ref);

    await db.collection('sanctions').deleteOne({ _id: legacy.insertedId });
    await db.collection('match_sheets').deleteOne({ _id: sheet.insertedId });
  });
});

describe('5C — concurrencia real del calendario', () => {
  const orphanStats = async (t: string) => {
    const ids = (await db.collection('matches').find({ tournamentId: oid(t) }).project({ _id: 1 }).toArray()).map((m) => m._id);
    return db.collection('player_match_stats').countDocuments({ tournamentId: oid(t), matchId: { $nin: ids } });
  };

  it('4 generaciones simultáneas del calendario → uno solo (sin partidos ni jornadas duplicados)', async () => {
    const t = await tournament();
    await teams(t, 4);
    const res = await Promise.all([1, 2, 3, 4].map(() => as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
    expect(await db.collection('matches').countDocuments({ tournamentId: oid(t) })).toBe(6); // 4 equipos, una vuelta
    expect(await db.collection('rounds').countDocuments({ tournamentId: oid(t) })).toBe(3);
  });

  it('regenerar ∥ capturar un resultado → o el resultado bloquea la regeneración o el partido ya no existe; nunca estadísticas huérfanas', async () => {
    for (let i = 0; i < 8; i++) {
      const t = await tournament();
      const [a] = await teams(t, 2);
      const p = await enrolled(t, a);
      await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
      const [m] = await matchesOf(t);
      const stat = { playerId: p, teamId: a, goals: 1, assists: 0, yellowCards: 0, redCards: 0, sendOff: null };
      // Las impares envían la regeneración 15 ms después (las peticiones se siguen solapando): así
      // se ejercitan los dos órdenes, gane la captura o gane la regeneración.
      const [regen, cap] = await Promise.all([
        new Promise((r) => setTimeout(r, (i % 2) * 15)).then(() => as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-03-06', replaceExisting: true })),
        as().put(`/api/matches/${m.id}/result`).send({ homeScore: m.homeTeamId === a ? 1 : 0, awayScore: m.homeTeamId === a ? 0 : 1, playerStats: [stat] }),
      ]);
      expect([regen.status, cap.status].filter((s) => s >= 500)).toEqual([]);
      if (cap.status === 200) expect(regen.status).toBe(409);
      else expect([regen.status, cap.status]).toEqual([201, 404]);
      expect(await orphanStats(t)).toBe(0);
    }
  });

  it('regenerar ∥ sancionar desde un partido del calendario viejo → la sanción conserva su posición o se rechaza', async () => {
    for (let i = 0; i < 4; i++) {
      const t = await tournament();
      const [a] = await teams(t, 2);
      const p = await enrolled(t, a);
      await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
      const [m] = await matchesOf(t);
      const [regen, sanc] = await Promise.all([
        as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-03-06', replaceExisting: true }),
        as().post(`/api/tournaments/${t}/discipline/sanctions`).send({ playerId: p, teamId: a, matchId: m.id, matches: 1, reason: 'Conducta' }),
      ]);
      expect(regen.status).toBe(201);
      expect([201, 400]).toContain(sanc.status);
      const saved = await db.collection('sanctions').find({ tournamentId: oid(t) }).toArray();
      expect(saved).toHaveLength(sanc.status === 201 ? 1 : 0);
      for (const s of saved) expect(s.start).toMatchObject({ date: expect.any(String), round: expect.any(Number) });
      const o = (await as().get(`/api/tournaments/${t}/discipline`).expect(200)).body;
      expect(o.sanctions).toHaveLength(saved.length);
    }
  });
});
