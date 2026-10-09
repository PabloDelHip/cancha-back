/**
 * Control disciplinario (2026-10-09): reglamento por torneo, sanciones automáticas derivadas de
 * las tarjetas, manuales, ajustes con historial, elegibilidad al capturar y permisos. API real.
 */
import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
let token: string;
let otherToken: string;
const as = () => authed(http, token);

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  token = (await registerOrganizer(http, 'Disciplina')).token;
  otherToken = (await registerOrganizer(http, 'Ajeno')).token;
});
afterAll(async () => ctx?.close());

let seq = 0;
/** Torneo con dos equipos, un jugador por equipo y `rounds` partidos programados. */
async function setup(rounds = 4, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE') {
  seq++;
  const t = (await as().post('/api/tournaments').send({ name: `Disciplina ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status }).expect(201)).body.id as string;
  const home = (await as().post('/api/teams').send({ name: `Local D${seq}` }).expect(201)).body.id as string;
  const away = (await as().post('/api/teams').send({ name: `Visita D${seq}` }).expect(201)).body.id as string;
  for (const id of [home, away]) await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
  const player = (await as().post('/api/players').send({ firstName: 'Rudo', lastName: `Defensa${seq}`, position: 'DEFENDER', confirmNew: true }).expect(201)).body.id as string;
  const rival = (await as().post('/api/players').send({ firstName: 'Rival', lastName: `Visita${seq}`, position: 'FORWARD', confirmNew: true }).expect(201)).body.id as string;
  await as().put(`/api/tournaments/${t}/players/${player}`).send({ teamId: home }).expect(200);
  await as().put(`/api/tournaments/${t}/players/${rival}`).send({ teamId: away }).expect(200);
  const matches: string[] = [];
  for (let r = 1; r <= rounds; r++) {
    const date = `2027-01-${String(r * 7).padStart(2, '0')}`;
    matches.push((await as().post('/api/matches').send({ tournamentId: t, round: r, homeTeamId: home, awayTeamId: away, date, time: '18:00' }).expect(201)).body.id);
  }
  return { t, home, away, player, rival, matches };
}

type Cards = { yellowCards?: number; redCards?: number; sendOff?: 'DIRECT' | 'SECOND_YELLOW' | null; played?: boolean };
function result(s: Awaited<ReturnType<typeof setup>>, matchId: string, cards: Cards | null, status = 200) {
  const playerStats = [{ playerId: s.rival, teamId: s.away, goals: 0, assists: 0, yellowCards: 0, redCards: 0, sendOff: null }];
  if (cards) playerStats.push({ playerId: s.player, teamId: s.home, goals: 0, assists: 0, yellowCards: 0, redCards: 0, sendOff: null, ...cards } as never);
  return as().put(`/api/matches/${matchId}/result`).send({ homeScore: 0, awayScore: 0, playerStats }).expect(status);
}
const overview = async (t: string) => (await as().get(`/api/tournaments/${t}/discipline`).expect(200)).body;
const history = async (t: string) => (await as().get(`/api/tournaments/${t}/discipline/history`).expect(200)).body as { action: string; ref: string; justification: string | null }[];
const enable = (t: string, rules: Record<string, unknown> = {}) => as().put(`/api/tournaments/${t}/discipline/rules`).send({ enabled: true, ...rules }).expect(200);

it('roja directa: suspensión automática, sin duplicados al volver a guardar, cumplimiento e incidencia', async () => {
  const s = await setup();
  await enable(s.t);
  const red = { redCards: 1, sendOff: 'DIRECT' as const };
  await result(s, s.matches[0], red);
  await result(s, s.matches[0], red); // volver a guardar
  let o = await overview(s.t);
  expect(o.sanctions).toHaveLength(1);
  expect(o.sanctions[0]).toMatchObject({ cause: 'DIRECT_RED', status: 'ACTIVE', remaining: 1, upcomingMatchIds: [s.matches[1]] });
  expect(o.refs.players[s.player]).toMatchObject({ firstName: 'Rudo' });

  // Elegibilidad del siguiente partido.
  const elig = (await as().get(`/api/matches/${s.matches[1]}/eligibility`).expect(200)).body;
  expect(elig).toMatchObject({ mode: 'WARN', suspended: [{ playerId: s.player, remaining: 1 }] });

  // Modo aviso: se puede capturar, queda la incidencia y no cuenta como cumplida.
  await result(s, s.matches[1], {});
  await result(s, s.matches[1], {}); // volver a guardar no repite el registro
  o = await overview(s.t);
  expect(o.sanctions[0]).toMatchObject({ served: 0, incidentMatchIds: [s.matches[1]], upcomingMatchIds: [s.matches[2]], status: 'ACTIVE' });
  expect(o.incidents).toEqual([expect.objectContaining({ matchId: s.matches[1], playerId: s.player })]);
  expect((await history(s.t)).filter((e) => e.action === 'PLAYED_WHILE_SUSPENDED')).toHaveLength(1);

  // Modo bloqueo: rechaza alinearlo; sin él se guarda y la sanción se cumple.
  await as().put(`/api/tournaments/${s.t}/discipline/rules`).send({ eligibility: 'BLOCK', justification: 'Reglamento de liga' }).expect(200);
  const blocked = await result(s, s.matches[2], {}, 409);
  expect(blocked.body.message).toMatch(/suspendidos/);
  await result(s, s.matches[2], null);
  o = await overview(s.t);
  expect(o.sanctions[0]).toMatchObject({ served: 1, remaining: 0, status: 'SERVED' });
});

it('acumulación de amarillas: la doble amarilla no cuenta; reinicio por fase configurable', async () => {
  const s = await setup(4);
  await enable(s.t, { yellowsForSuspension: 2, accumulationMatches: 1, secondYellowMatches: 2 });
  await result(s, s.matches[0], { yellowCards: 1 });
  await result(s, s.matches[1], { yellowCards: 2, redCards: 1, sendOff: 'SECOND_YELLOW' });
  let o = await overview(s.t);
  expect(o.sanctions.map((x: { cause: string; matches: number }) => [x.cause, x.matches])).toEqual([['SECOND_YELLOW', 2]]);
  expect(o.players[0]).toMatchObject({ yellows: 1, towardNext: 1, secondYellows: 1 });
  await result(s, s.matches[2], { yellowCards: 1, redCards: 1, sendOff: 'DIRECT' });
  o = await overview(s.t);
  expect(o.sanctions.map((x: { cause: string }) => x.cause).sort()).toEqual(['ACCUMULATION', 'DIRECT_RED', 'SECOND_YELLOW']);
});

it('capturas nuevas: tarjetas coherentes con el tipo de expulsión; las anteriores quedan sin clasificar', async () => {
  const s = await setup(2);
  await enable(s.t);
  const bad = await result(s, s.matches[0], { yellowCards: 1, redCards: 1, sendOff: 'SECOND_YELLOW' }, 400);
  expect(JSON.stringify(bad.body.message)).toMatch(/doble amarilla/);
  await result(s, s.matches[0], { yellowCards: 2, redCards: 0, sendOff: null }, 400);
  await result(s, s.matches[0], { redCards: 1, sendOff: null }, 400);

  // Cliente que no envía sendOff (como las capturas históricas): no se interpreta.
  const playerStats = [{ playerId: s.player, teamId: s.home, goals: 0, assists: 0, yellowCards: 2, redCards: 0 }];
  await as().put(`/api/matches/${s.matches[0]}/result`).send({ homeScore: 0, awayScore: 0, playerStats }).expect(200);
  const o = await overview(s.t);
  expect(o.sanctions).toEqual([]);
  expect(o.unclassified).toEqual([expect.objectContaining({ matchId: s.matches[0], playerId: s.player, yellowCards: 2 })]);
  const stats = (await request(http).get(`/api/matches/${s.matches[0]}/stats`).expect(200)).body;
  expect(stats[0].sendOff).toBeUndefined();
});

it('ajustar y anular con justificación; corregir tarjetas conserva el ajuste y su historial', async () => {
  const s = await setup(3);
  await enable(s.t);
  await result(s, s.matches[0], { redCards: 1, sendOff: 'DIRECT' });
  const ref = (await overview(s.t)).sanctions[0].ref as string;

  await as().patch(`/api/tournaments/${s.t}/discipline/sanctions/${ref}`).send({ matches: 2 }).expect(400); // sin justificación
  let o = (await as().patch(`/api/tournaments/${s.t}/discipline/sanctions/${ref}`).send({ matches: 2, justification: 'Informe arbitral' }).expect(200)).body;
  expect(o.sanctions[0]).toMatchObject({ matches: 2, ruleMatches: 1, adjusted: true, upcomingMatchIds: [s.matches[1], s.matches[2]] });
  o = (await as().post(`/api/tournaments/${s.t}/discipline/sanctions/${ref}/annul`).send({ justification: 'Apelación aceptada' }).expect(200)).body;
  expect(o.sanctions[0].status).toBe('ANNULLED');
  expect((await as().get(`/api/matches/${s.matches[1]}/eligibility`).expect(200)).body.suspended).toEqual([]);
  o = (await as().post(`/api/tournaments/${s.t}/discipline/sanctions/${ref}/restore`).send({ justification: 'Error al anular' }).expect(200)).body;
  expect(o.sanctions[0]).toMatchObject({ status: 'ACTIVE', matches: 2 });

  // Se corrige la captura: ya no hubo roja. La sanción desaparece; el ajuste y el historial no.
  await result(s, s.matches[0], {});
  o = await overview(s.t);
  expect(o.sanctions).toEqual([]);
  expect(o.orphans).toEqual([expect.objectContaining({ ref, matches: 2 })]);
  const h = await history(s.t);
  expect(h.filter((e) => e.ref === ref).map((e) => e.action)).toEqual(['SANCTION_RESTORED', 'SANCTION_ANNULLED', 'SANCTION_UPDATED']);
  const gone = await as().patch(`/api/tournaments/${s.t}/discipline/sanctions/${ref}`).send({ matches: 1, justification: 'x'.repeat(5) }).expect(409);
  expect(gone.body.message).toMatch(/ya no existe/);

  // Si la roja vuelve, el ajuste vuelve a aplicar (misma clave).
  await result(s, s.matches[0], { redCards: 1, sendOff: 'DIRECT' });
  expect((await overview(s.t)).sanctions[0]).toMatchObject({ ref, matches: 2, adjusted: true });
});

it('sanción manual: jugador, equipo, motivo, duración y partido desde el que aplica', async () => {
  const s = await setup(3);
  const base = `/api/tournaments/${s.t}/discipline/sanctions`;
  await as().post(base).send({ playerId: s.player, teamId: s.away, matchId: s.matches[1], matches: 1, reason: 'Agresión' }).expect(400); // otro equipo
  let o = (await as().post(base).send({ playerId: s.player, teamId: s.home, matchId: s.matches[1], matches: 2, reason: 'Agresión al árbitro' }).expect(201)).body;
  const manual = o.sanctions.find((x: { kind: string }) => x.kind === 'MANUAL');
  expect(manual).toMatchObject({ cause: 'MANUAL', reason: 'Agresión al árbitro', coveredMatchIds: [s.matches[1], s.matches[2]], status: 'ACTIVE' });

  o = (await as().patch(`${base}/${manual.ref}`).send({ matches: 1, justification: 'Reducción por buena conducta' }).expect(200)).body;
  expect(o.sanctions[0]).toMatchObject({ matches: 1, coveredMatchIds: [s.matches[1]] });
  // Un partido referido por una sanción no se borra.
  await as().delete(`/api/matches/${s.matches[1]}`).expect(409);
  const h = await history(s.t);
  expect(h.map((e) => e.action)).toEqual(['SANCTION_UPDATED', 'SANCTION_CREATED']);
});

it('permisos y estados: solo el organizador; DRAFT sin sanciones; FINISHED solo lectura; nada público', async () => {
  const draft = await setup(1, 'DRAFT');
  await as().put(`/api/tournaments/${draft.t}/discipline/rules`).send({ enabled: true }).expect(200);
  await as().post(`/api/tournaments/${draft.t}/discipline/sanctions`).send({ playerId: draft.player, teamId: draft.home, matchId: draft.matches[0], matches: 1, reason: 'Prueba' }).expect(409);

  const s = await setup(2);
  await enable(s.t);
  await result(s, s.matches[0], { redCards: 1, sendOff: 'DIRECT' });
  await request(http).get(`/api/tournaments/${s.t}/discipline`).expect(401);
  await authed(http, otherToken).get(`/api/tournaments/${s.t}/discipline`).expect(403);
  await authed(http, otherToken).put(`/api/tournaments/${s.t}/discipline/rules`).send({ enabled: false }).expect(403);
  await authed(http, otherToken).get(`/api/matches/${s.matches[1]}/eligibility`).expect(403);
  const pub = (await request(http).get(`/api/tournaments/${s.t}`).expect(200)).body;
  expect(pub.discipline).toBeUndefined();

  await as().post(`/api/tournaments/${s.t}/finish`).send({ allowPendingMatches: true }).expect(200);
  const o = await overview(s.t);
  expect(o).toMatchObject({ readOnly: true });
  expect(o.sanctions[0]).toMatchObject({ status: 'PENDING', remaining: 1 }); // no se transfiere ni se da por cumplida
  await as().put(`/api/tournaments/${s.t}/discipline/rules`).send({ enabled: false }).expect(409);
  await as().post(`/api/tournaments/${s.t}/discipline/sanctions/${o.sanctions[0].ref}/annul`).send({ justification: 'Tarde' }).expect(409);
});

it('carrera: dos ajustes simultáneos de la misma automática crean un solo documento de ajuste', async () => {
  const s = await setup(3);
  await enable(s.t);
  await result(s, s.matches[0], { redCards: 1, sendOff: 'DIRECT' });
  const ref = (await overview(s.t)).sanctions[0].ref as string;
  const url = `/api/tournaments/${s.t}/discipline/sanctions/${ref}`;
  const responses = await Promise.all([
    as().patch(url).send({ matches: 2, justification: 'Primera decisión' }),
    as().patch(url).send({ matches: 3, justification: 'Segunda decisión' }),
  ]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  const db = ctx.app.get<Connection>(getConnectionToken());
  expect(await db.collection('sanctions').countDocuments({ key: ref })).toBe(1);
  expect((await history(s.t)).filter((e) => e.ref === ref)).toHaveLength(2);
});

describe('cierre del módulo', () => {
  it('cambio de equipo: la suspensión sigue al jugador y se cumple con el nuevo, sin retroactividad', async () => {
    const s = await setup(2);
    await enable(s.t);
    const third = (await as().post('/api/teams').send({ name: `Tercero D${seq}` }).expect(201)).body.id as string;
    await as().post(`/api/tournaments/${s.t}/teams/${third}`).expect(201);
    const before = (await as().post('/api/matches').send({ tournamentId: s.t, round: 5, homeTeamId: third, awayTeamId: s.away, date: '2027-01-10', time: '20:00' }).expect(201)).body.id;
    const after = (await as().post('/api/matches').send({ tournamentId: s.t, round: 6, homeTeamId: third, awayTeamId: s.away, date: '2027-01-30', time: '20:00' }).expect(201)).body.id;
    // Expulsado con su equipo el 7 ene; pasa al tercero el 12 ene (su equipo ya no juega después).
    await result(s, s.matches[0], { redCards: 1, sendOff: 'DIRECT' });
    await as().put(`/api/tournaments/${s.t}/players/${s.player}`).send({ teamId: third, startDate: '2027-01-12' }).expect(200);
    await as().patch(`/api/matches/${s.matches[1]}`).send({ reason: 'Motivo de prueba', status: 'CANCELLED' }).expect(200);

    // El partido del 10 ene (antes de llegar) no cuenta; el del 30 ene queda reservado.
    expect((await as().get(`/api/matches/${before}/eligibility`).expect(200)).body.suspended).toEqual([]);
    expect((await as().get(`/api/matches/${after}/eligibility`).expect(200)).body.suspended).toEqual([expect.objectContaining({ playerId: s.player })]);
    let o = await overview(s.t);
    expect(o.sanctions[0]).toMatchObject({ teamId: s.home, status: 'ACTIVE', upcomingMatchIds: [after] });

    // Se juega sin él: cumplida con su nuevo equipo.
    await as().put(`/api/matches/${after}/result`).send({ homeScore: 0, awayScore: 0, playerStats: [] }).expect(200);
    o = await overview(s.t);
    expect(o.sanctions[0]).toMatchObject({ status: 'SERVED', served: 1, coveredMatchIds: [after] });
  });

  it('expulsión antigua sin sendOff: sigue sin clasificar (no se interpreta), también con una sola roja', async () => {
    const s = await setup(2);
    await enable(s.t);
    const playerStats = [{ playerId: s.player, teamId: s.home, goals: 0, assists: 0, yellowCards: 0, redCards: 1 }];
    await as().put(`/api/matches/${s.matches[0]}/result`).send({ homeScore: 0, awayScore: 0, playerStats }).expect(200);
    const o = await overview(s.t);
    expect(o.sanctions).toEqual([]);
    expect(o.unclassified).toEqual([expect.objectContaining({ playerId: s.player, redCards: 1 })]);
  });

  it('pospuesto reprogramado con su fecha original: no cuenta, se avisa y cuenta al poner la fecha real', async () => {
    const s = await setup(3);
    await enable(s.t);
    await result(s, s.matches[0], { redCards: 1, sendOff: 'DIRECT' });
    await as().patch(`/api/matches/${s.matches[1]}`).send({ reason: 'Motivo de prueba', status: 'POSTPONED' }).expect(200);
    await as().patch(`/api/matches/${s.matches[1]}`).send({ reason: 'Motivo de prueba', status: 'SCHEDULED' }).expect(200); // misma fecha
    let o = await overview(s.t);
    expect(o.staleMatchIds).toEqual([s.matches[1]]);
    expect(o.sanctions[0]).toMatchObject({ upcomingMatchIds: [s.matches[2]], staleMatchIds: [s.matches[1]] });
    expect((await as().get(`/api/matches/${s.matches[1]}/eligibility`).expect(200)).body).toMatchObject({ staleDate: true, suspended: [] });

    // Fecha real (después de J3): ahora sí ocupa su lugar.
    await as().patch(`/api/matches/${s.matches[1]}`).send({ reason: 'Motivo de prueba', date: '2027-02-10' }).expect(200);
    o = await overview(s.t);
    expect(o.staleMatchIds).toEqual([]);
    expect(o.sanctions[0]).toMatchObject({ upcomingMatchIds: [s.matches[2]], staleMatchIds: [] });

    // Un pospuesto se sigue pudiendo capturar directamente (comportamiento existente), pero avisado.
    const t2 = await setup(3);
    await enable(t2.t);
    await result(t2, t2.matches[0], { redCards: 1, sendOff: 'DIRECT' });
    await as().patch(`/api/matches/${t2.matches[1]}`).send({ reason: 'Motivo de prueba', status: 'POSTPONED' }).expect(200);
    await result(t2, t2.matches[1], {});
    o = await overview(t2.t);
    expect(o.staleMatchIds).toEqual([t2.matches[1]]);
    expect(o.incidents).toEqual([]); // fecha no fiable: ni incidencia ni cumplido hasta corregirla
  });

  it('regenerar el calendario no hace desaparecer una sanción manual', async () => {
    const s = await setup(3);
    await as().post(`/api/tournaments/${s.t}/discipline/sanctions`).send({ playerId: s.player, teamId: s.home, matchId: s.matches[1], matches: 1, reason: 'Conducta antideportiva' }).expect(201);
    await as().post(`/api/tournaments/${s.t}/schedule`).send({ startDate: '2027-01-07', legs: 2, replaceExisting: true }).expect(201);
    const o = await overview(s.t);
    expect(o.sanctions).toHaveLength(1);
    expect(o.sanctions[0]).toMatchObject({ kind: 'MANUAL', status: 'ACTIVE', remaining: 1 });
    expect(o.sanctions[0].upcomingMatchIds).toHaveLength(1);
  });

  it('eliminar un torneo borra sus sanciones e historial en la misma transacción', async () => {
    const draft = (await as().post('/api/tournaments').send({ name: `Borrable ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01' }).expect(201)).body.id as string;
    await as().put(`/api/tournaments/${draft}/discipline/rules`).send({ enabled: true, justification: 'Antes de borrar' }).expect(200);
    const db = ctx.app.get<Connection>(getConnectionToken());
    const { Types } = await import('mongoose');
    const tid = new Types.ObjectId(draft);
    expect(await db.collection('discipline_log').countDocuments({ tournamentId: tid })).toBe(1);
    await as().delete(`/api/tournaments/${draft}`).expect(204);
    expect(await db.collection('discipline_log').countDocuments({ tournamentId: tid })).toBe(0);
    expect(await db.collection('sanctions').countDocuments({ tournamentId: tid })).toBe(0);
  });
});
