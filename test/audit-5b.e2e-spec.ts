/**
 * 5B (2026-10-18) — correcciones de la auditoría 5A (`docs/audit-5.md`). Cada caso reproduce un error
 * comprobado en 5A; las carreras son concurrentes de verdad (Promise.all contra la API real).
 *
 * - D1 / P1-1: la ficha de un jugador con historial (sanción, alineación, multa, solicitud pendiente)
 *   no se borra (409 PLAYER_HAS_HISTORY).
 * - P2-1: borrar una ficha y, a la vez, inscribirla (torneo o plantilla global) o sancionarla/multarla
 *   no deja referencias huérfanas ni responde 404 a un alta que sí se guardó.
 * - D2 / P2-2: un partido con multa vinculada no se borra (409 MATCH_HAS_FINANCE); sin resultado se
 *   borra con su ficha técnica e incidencias.
 * - D3 / P2-3: un equipo con historial en `removed_enrollments` no se borra (409 TEAM_HAS_HISTORY).
 * - D4 / P2-6: un torneo DRAFT solo lo ven su propietario y sus colaboradores.
 * - Corrección financiera: un vínculo histórico que ya no existe no impide corregir el movimiento.
 */
import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let db: Connection;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, CLUB: U, COLLAB: U, STRANGER: U;
const as = (u: U) => authed(http, u.token);
const anon = () => request(http);
let seq = 0;

async function tournament(status: 'ACTIVE' | 'DRAFT' = 'ACTIVE', by = O) {
  return (await as(by).post('/api/tournaments').send({ name: `Auditoría 5B ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status }).expect(201)).body.id as string;
}
const team = async (t: string | null, by = O) => {
  const id = (await as(by).post('/api/teams').send({ name: `Equipo 5B ${++seq}` }).expect(201)).body.id as string;
  if (t) await as(by).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  return id;
};
const player = async (by = O) =>
  (await as(by).post('/api/players').send({ firstName: 'Jugador', lastName: `Cinco B ${++seq}`, position: 'FORWARD', confirmNew: true }).expect(201)).body.id as string;
const register = (t: string, p: string, teamId: string) => as(O).put(`/api/tournaments/${t}/players/${p}`).send({ teamId });
const match = async (t: string, home: string, away: string, round = 1) =>
  (await as(O).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date: '2026-12-01', time: `1${round}:00` }).expect(201)).body.id as string;
const fine = (t: string, teamId: string, extra: Record<string, unknown>) =>
  as(O).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), teamId, kind: 'CHARGE', category: 'FINE', amount: 10_000, concept: 'Multa', reason: 'Conducta', ...extra });
const count = (collection: string, filter: Record<string, unknown>) => db.collection(collection).countDocuments(filter);
const oid = (id: string) => new Types.ObjectId(id);

/** Escenario: torneo ACTIVE, dos equipos, un jugador inscrito y un partido programado. */
async function scene() {
  const t = await tournament();
  const [a, b] = [await team(t), await team(t)];
  const p = await player();
  await register(t, p, a).expect(200);
  const m = await match(t, a, b);
  return { t, a, b, p, m };
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  db = ctx.app.get<Connection>(getConnectionToken());
  [O, CLUB, COLLAB, STRANGER] = [
    await registerOrganizer(http, 'Dueño5B'),
    await registerOrganizer(http, 'Club5B'),
    await registerOrganizer(http, 'Colab5B'),
    await registerOrganizer(http, 'Extraño5B'),
  ];
});
afterAll(async () => ctx?.close());

describe('D1 / P1-1 — la ficha de un jugador con historial no se borra', () => {
  it('con una sanción manual → 409 y la sanción conserva su jugador', async () => {
    const { t, a, p, m } = await scene();
    await as(O).post(`/api/tournaments/${t}/discipline/sanctions`).send({ playerId: p, teamId: a, matchId: m, matches: 1, reason: 'Conducta' }).expect(201);
    const res = await as(O).delete(`/api/players/${p}`).expect(409);
    expect(res.body.error).toBe('PLAYER_HAS_HISTORY');
    expect(await count('players', { _id: oid(p) })).toBe(1);
  });

  it('con una alineación guardada → 409', async () => {
    const { a, p, m } = await scene();
    await as(O).put(`/api/matches/${m}/sheet/teams/${a}`).send({ players: [{ playerId: p, starter: true }], substitutions: [] }).expect(200);
    expect((await as(O).delete(`/api/players/${p}`).expect(409)).body.error).toBe('PLAYER_HAS_HISTORY');
  });

  it('con una multa (aunque esté anulada) → 409', async () => {
    const { t, a, p } = await scene();
    const e = (await fine(t, a, { playerId: p }).expect(201)).body.entry;
    await as(O).post(`/api/tournaments/${t}/finance/entries/${e.id}/void`).send({ requestId: randomUUID(), reason: 'Error de captura', allowCredit: true }).expect(200);
    expect((await as(O).delete(`/api/players/${p}`).expect(409)).body.error).toBe('PLAYER_HAS_HISTORY');
  });

  it('en una solicitud de inscripción pendiente → 409; un borrador solo la suelta', async () => {
    const t = await tournament('DRAFT');
    await as(O).patch(`/api/tournaments/${t}/registration`).send({ enabled: true }).expect(200);
    const token = (await as(O).post(`/api/tournaments/${t}/registration-link`).expect(200)).body.link.token as string;
    const club = (await as(CLUB).post('/api/me/teams').send({ name: `Club solicitud ${++seq}` }).expect(201)).body.id as string;
    const add = () => as(CLUB).post(`/api/teams/${club}/global-roster/players`).send({ requestId: randomUUID(), firstName: 'Solicitado', lastName: `Cinco B ${++seq}`, position: 'DEFENDER', confirmNew: true }).expect(201);
    const [p1, p2] = [(await add()).body.player.id as string, (await add()).body.player.id as string];
    await as(CLUB).post(`/api/tournament-registration/${token}/requests`).send({ teamId: club, playerIds: [p1] }).expect(201);
    await as(CLUB).delete(`/api/teams/${club}/global-roster/${p1}`).expect(204);
    expect((await as(CLUB).delete(`/api/players/${p1}`).expect(409)).body.error).toBe('PLAYER_HAS_HISTORY');
    // Un borrador (inscripción a medias de otro torneo) no es historia: la ficha se borra y el borrador la suelta.
    const t2 = await tournament('DRAFT');
    await as(O).patch(`/api/tournaments/${t2}/registration`).send({ enabled: true }).expect(200);
    const token2 = (await as(O).post(`/api/tournaments/${t2}/registration-link`).expect(200)).body.link.token as string;
    await as(CLUB).put(`/api/tournament-registration/${token2}/draft`).send({ teamId: club, playerIds: [p2], step: 'players' }).expect(200);
    await as(CLUB).delete(`/api/teams/${club}/global-roster/${p2}`).expect(204);
    await as(CLUB).delete(`/api/players/${p2}`).expect(204);
    expect(await count('registration_drafts', { playerIds: oid(p2) })).toBe(0);
  });

  it('sin historial se sigue borrando, con sus participaciones', async () => {
    const t = await tournament();
    const a = await team(t);
    const p = await player();
    await register(t, p, a).expect(200);
    await as(O).delete(`/api/players/${p}`).expect(204);
    expect(await count('team_memberships', { playerId: oid(p) })).toBe(0);
  });
});

describe('P2-1 — carreras reales al borrar una ficha', () => {
  const orphans = async (p: string) => ((await count('players', { _id: oid(p) })) ? 0 : 1) * (
    (await count('team_memberships', { playerId: oid(p) })) +
    (await count('team_rosters', { playerId: oid(p) })) +
    (await count('sanctions', { playerId: oid(p) })) +
    (await count('finance_entries', { playerId: oid(p) })));

  it('borrar ∥ inscribir en un torneo: sin participaciones huérfanas y sin 404 de un alta guardada', async () => {
    const t = await tournament();
    const a = await team(t);
    let left = 0;
    for (let i = 0; i < 12; i++) {
      const p = await player();
      const [del, put] = await Promise.all([as(O).delete(`/api/players/${p}`), register(t, p, a)]);
      left += await orphans(p);
      if (put.status === 404) expect(await count('team_memberships', { playerId: oid(p) })).toBe(0);
      expect([del.status, put.status]).toEqual(expect.arrayContaining([204]));
    }
    expect(left).toBe(0);
  });

  it('borrar ∥ agregar a la plantilla global: sin periodos huérfanos', async () => {
    const club = await team(null);
    let left = 0;
    for (let i = 0; i < 12; i++) {
      const p = await player();
      await Promise.all([as(O).delete(`/api/players/${p}`), as(O).post(`/api/teams/${club}/global-roster`).send({ playerId: p })]);
      left += await orphans(p);
    }
    expect(left).toBe(0);
  });

  it('borrar ∥ sancionar o multar: o se borra sin historial, o queda la historia con su ficha', async () => {
    let left = 0;
    for (let i = 0; i < 8; i++) {
      const { t, a, p, m } = await scene();
      const [, sanction, charge] = await Promise.all([
        as(O).delete(`/api/players/${p}`),
        as(O).post(`/api/tournaments/${t}/discipline/sanctions`).send({ playerId: p, teamId: a, matchId: m, matches: 1, reason: 'Carrera' }),
        fine(t, a, { playerId: p }),
      ]);
      left += await orphans(p);
      if (sanction.status === 201 || charge.status === 201) expect(await count('players', { _id: oid(p) })).toBe(1);
    }
    expect(left).toBe(0);
  });
});

describe('D2 / P2-2 — borrar un partido', () => {
  it('con una multa vinculada → 409 MATCH_HAS_FINANCE', async () => {
    const { t, a, m } = await scene();
    await fine(t, a, { matchId: m }).expect(201);
    expect((await as(O).delete(`/api/matches/${m}`).expect(409)).body.error).toBe('MATCH_HAS_FINANCE');
    expect(await count('matches', { _id: oid(m) })).toBe(1);
  });

  it('sin resultado ni multa: se borra junto con su ficha técnica e incidencias (sin huérfanos)', async () => {
    const { a, p, m } = await scene();
    await as(O).put(`/api/matches/${m}/sheet/teams/${a}`).send({ players: [{ playerId: p, starter: true }], substitutions: [] }).expect(200);
    await as(O).post(`/api/matches/${m}/incidents`).send({ type: 'OTHER', description: 'Aviso previo' }).expect(201);
    await as(O).delete(`/api/matches/${m}`).expect(204);
    expect(await count('match_sheets', { matchId: oid(m) })).toBe(0);
    expect(await count('match_incidents', { matchId: oid(m) })).toBe(0);
    // El historial del partido (match_logs) sí se conserva: es la constancia del borrado.
    expect(await count('match_logs', { matchId: oid(m) })).toBeGreaterThan(0);
  });
});

describe('D3 / P2-3 — borrar un equipo', () => {
  it('quitado de un torneo con jugadores (historial en removed_enrollments) → 409 TEAM_HAS_HISTORY', async () => {
    const t = await tournament();
    const q = await team(t);
    const p = await player();
    await register(t, p, q).expect(200);
    await as(O).delete(`/api/tournaments/${t}/teams/${q}`).expect(204);
    expect((await as(O).delete(`/api/teams/${q}`).expect(409)).body.error).toBe('TEAM_HAS_HISTORY');
    const history = (await as(O).get(`/api/tournaments/${t}/roster-history`).expect(200)).body;
    expect(history.refs.teams[q]).toBeTruthy();
  });

  it('quitado aunque no tuviera jugadores (el historial registra que se quitó) → 409; uno nunca inscrito se borra', async () => {
    const t = await tournament();
    const q = await team(t);
    await as(O).delete(`/api/tournaments/${t}/teams/${q}`).expect(204);
    expect((await as(O).delete(`/api/teams/${q}`).expect(409)).body.error).toBe('TEAM_HAS_HISTORY');
    await as(O).delete(`/api/teams/${await team(null)}`).expect(204);
  });
});

describe('D4 / P2-6 — torneos en borrador', () => {
  it('sin sesión o sin acceso: no aparecen en listados y sus recursos responden 404', async () => {
    const t = await tournament('DRAFT');
    const [a, b] = [await team(t), await team(t)];
    const p = await player();
    await register(t, p, a).expect(200);
    const m = await match(t, a, b);
    const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role: 'SCORER' }).expect(201)).body;
    await as(COLLAB).post(`/api/invitations/${inv.token}/accept`).expect(200);

    const scoped = [`/api/tournaments/${t}`, `/api/tournaments/${t}/summary`, `/api/tournaments/${t}/teams`, `/api/tournaments/${t}/matches`, `/api/tournaments/${t}/rounds`, `/api/tournaments/${t}/players`, `/api/tournaments/${t}/standings`, `/api/tournaments/${t}/top-scorers`, `/api/tournaments/${t}/structure`, `/api/matches/${m}`, `/api/matches/${m}/stats`];
    const lists: [string, (body: any) => boolean][] = [
      ['/api/tournaments?limit=100', (bd) => bd.data.some((x: any) => x.id === t)],
      ['/api/tournaments?status=DRAFT&limit=100', (bd) => bd.data.some((x: any) => x.id === t)],
      [`/api/tournament-teams?tournamentId=${t}`, (bd) => bd.data.length > 0],
      [`/api/matches?tournamentId=${t}`, (bd) => bd.data.length > 0],
      [`/api/rounds?tournamentId=${t}`, (bd) => bd.data.length > 0],
      [`/api/memberships?tournamentId=${t}`, (bd) => bd.data.length > 0],
      [`/api/players/${p}/memberships`, (bd) => bd.some((x: any) => (x.tournamentId ?? x.tournament?.id) === t)],
      [`/api/teams/${a}/memberships`, (bd) => bd.some((x: any) => (x.tournamentId ?? x.tournament?.id) === t)],
    ];
    const seen = async (get: (u: string) => request.Test) => {
      const out: Record<string, number | boolean> = {};
      for (const u of scoped) out[u] = (await get(u)).status;
      for (const [u, has] of lists) out[u] = has((await get(u).expect(200)).body);
      return out;
    };
    const hidden = Object.fromEntries([...scoped.map((u) => [u, 404]), ...lists.map(([u]) => [u, false])]);
    const visible = Object.fromEntries([...scoped.map((u) => [u, 200]), ...lists.map(([u]) => [u, true])]);
    expect(await seen((u) => anon().get(u))).toEqual(hidden);
    expect(await seen((u) => as(STRANGER).get(u))).toEqual(hidden);
    expect(await seen((u) => as(O).get(u))).toEqual(visible);
    expect(await seen((u) => as(COLLAB).get(u))).toEqual(visible);

    // Iniciado deja de ser borrador: público (y ya no sale entre los DRAFT).
    await as(O).post(`/api/tournaments/${t}/start`).expect(200);
    expect(await seen((u) => anon().get(u))).toEqual({ ...visible, '/api/tournaments?status=DRAFT&limit=100': false });
  });

  it('un token inválido en una ruta pública responde 401 (el front renueva la sesión) en vez de ocultar el borrador', async () => {
    await anon().get('/api/tournaments').set('Authorization', 'Bearer no-es-un-token').expect(401);
  });
});

describe('Corrección financiera con un vínculo histórico que ya no existe', () => {
  it('conservar el jugador o partido original (borrados antes de 5B) no impide corregir; uno nuevo inexistente sí', async () => {
    const { t, a, p, m } = await scene();
    const e = (await fine(t, a, { playerId: p, matchId: m }).expect(201)).body.entry;
    // Datos heredados: fichas y partidos borrados antes de 5B dejaron multas con el vínculo roto.
    await db.collection('players').deleteOne({ _id: oid(p) });
    await db.collection('team_memberships').deleteMany({ playerId: oid(p) });
    await db.collection('matches').deleteOne({ _id: oid(m) });
    const correct = (entry: Record<string, unknown>) =>
      as(O).post(`/api/tournaments/${t}/finance/entries/${e.id}/correct`).send({ requestId: randomUUID(), reason: 'Monto equivocado', entry: { kind: 'CHARGE', category: 'FINE', amount: 15_000, concept: 'Multa', reason: 'Conducta', ...entry } });
    expect((await correct({ playerId: new Types.ObjectId().toHexString() }).expect(409)).body.error).toBe('FINE_PLAYER_INVALID');
    const ok = (await correct({ playerId: p, matchId: m }).expect(201)).body;
    expect(ok.entry).toMatchObject({ playerId: p, matchId: m, amount: 15_000, replaces: e.id });
  });
});
