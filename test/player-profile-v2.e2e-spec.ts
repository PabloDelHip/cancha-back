/**
 * Player Profile V2: resultado oficial de cada competición (campeón, finalista, fase alcanzada,
 * goleador) con los formatos de la Etapa 5.5, honors con la regla de participación, lecturas de
 * carrera (por año, por equipo, hitos, récords, mejores actuaciones) y privacidad. API real.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
let A: Awaited<ReturnType<typeof registerOrganizer>>;
const as = () => authed(http, A.token);

let seq = 0;
async function tournament(settings: Record<string, unknown>, startDate = '2027-01-01') {
  seq++;
  return (
    await as()
      .post('/api/tournaments')
      .send({ name: `Copa V2-${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate, status: 'ACTIVE', settings })
      .expect(201)
  ).body.id as string;
}
/** Equipos con nombre ordenable: la siembra por defecto es alfabética (E1 = cabeza de serie 1). */
async function teams(t: string, n: number) {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    seq++;
    const id = (await as().post('/api/teams').send({ name: `E${i} v2-${seq}` }).expect(201)).body.id as string;
    await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    out.push(id);
  }
  return out;
}
async function newPlayer(extra: Record<string, unknown> = {}) {
  seq++;
  return (await as().post('/api/players').send({ confirmNew: true, firstName: 'Juan', lastName: `V2-${seq}`, position: 'FORWARD', birthDate: '2000-05-05', ...extra }).expect(201))
    .body.id as string;
}
const register = (t: string, player: string, team: string, jerseyNumber = 10) =>
  as().put(`/api/tournaments/${t}/players/${player}`).send({ teamId: team, jerseyNumber, startDate: '2027-01-01' }).expect(200);
const matchesOf = async (t: string) =>
  (await api().get(`/api/tournaments/${t}/matches`).expect(200)).body as { id: string; homeTeamId: string; awayTeamId: string; status: string; homeScore: number | null }[];
const profile = async (id: string) => (await api().get(`/api/players/${id}/profile`).expect(200)).body;

/**
 * Juega todo lo pendiente (ronda a ronda) hasta que no quedan partidos: gana el mejor de `order`
 * 2-0. `roster` = jugadores por equipo (todos juegan); `goals(player, match)` decide sus goles.
 */
async function playAll(t: string, order: string[], roster: Record<string, string[]>, goals: (player: string, n: number) => number = () => 0) {
  const rank = (x: string) => (order.includes(x) ? order.indexOf(x) : 99);
  let n = 0;
  for (let guard = 0; guard < 12; guard++) {
    const pending = (await matchesOf(t)).filter((m) => m.status === 'SCHEDULED' && m.homeScore === null);
    if (!pending.length) return;
    for (const m of pending) {
      n++;
      const homeWins = rank(m.homeTeamId) <= rank(m.awayTeamId);
      const winner = homeWins ? m.homeTeamId : m.awayTeamId;
      const lines = [m.homeTeamId, m.awayTeamId].flatMap((team) =>
        (roster[team] ?? []).map((playerId) => ({
          playerId, teamId: team, played: true, assists: 0, yellowCards: 0, redCards: 0,
          goals: team === winner ? Math.min(goals(playerId, n), 2) : 0,
        })),
      );
      // Marcador ≥ goles asignados; el ganador siempre gana por 2+.
      const wg = Math.max(2, ...lines.filter((l) => l.teamId === winner).map((l) => l.goals));
      await as().put(`/api/matches/${m.id}/result`).send({ homeScore: homeWins ? wg : 0, awayScore: homeWins ? 0 : wg, playerStats: lines }).expect(200);
    }
  }
}
const kinds = (p: { honors: { type: string; tournament: { id: string } }[] }, t: string) => p.honors.filter((h) => h.tournament.id === t).map((h) => h.type);
const outcomeIn = (p: { competitions: { tournament: { id: string }; teams: { outcome: unknown }[] }[] }, t: string) =>
  p.competitions.find((c) => c.tournament.id === t)!.teams[0].outcome;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Vera');
});
afterAll(async () => ctx?.close());

describe('Player Profile V2 · resultado oficial por formato', () => {
  it('KNOCKOUT: campeón (FINAL) y goleador, finalista, semifinalista, y plantilla sin jugar sin título', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const [e1, e2, e3, e4] = await teams(t, 4);
    const [champ, runner, semi, bench] = [await newPlayer(), await newPlayer(), await newPlayer(), await newPlayer()];
    await register(t, champ, e1);
    await register(t, bench, e1, 11);
    await register(t, runner, e2);
    await register(t, semi, e3);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    await playAll(t, [e1, e2, e3, e4], { [e1]: [champ], [e2]: [runner], [e3]: [semi] }, (p) => (p === champ ? 2 : 1));

    // Antes de finalizar el torneo: sin honors (el resultado aún no es oficial).
    expect((await profile(champ)).honors).toEqual([]);
    await as().post(`/api/tournaments/${t}/finish`).send({}).expect(200);

    const c = await profile(champ);
    expect(kinds(c, t)).toEqual(['CHAMPION', 'TOP_SCORER']);
    expect(c.honors[0]).toMatchObject({ decidedBy: 'FINAL', team: { id: e1 }, year: 2027 });
    expect(c.honors[1]).toMatchObject({ goals: 4, shared: false, team: null });
    expect(outcomeIn(c, t)).toEqual({ champion: true, runnerUp: false, reached: 'Campeón', finalPosition: null });
    expect(c.competitions[0]).toMatchObject({ system: 'KNOCKOUT', topScorer: { goals: 4, shared: false } });
    expect(c.career).toMatchObject({ appearances: 2, goals: 4, titles: 1, teams: 1, assistsPerMatch: 0 });

    const r = await profile(runner);
    expect(kinds(r, t)).toEqual(['RUNNER_UP']);
    expect(outcomeIn(r, t)).toMatchObject({ champion: false, runnerUp: true, reached: 'Final' });

    expect(outcomeIn(await profile(semi), t)).toMatchObject({ champion: false, runnerUp: false, reached: 'Semifinal' });
    expect(kinds(await profile(semi), t)).toEqual([]);

    // Estuvo en la plantilla del campeón pero nunca jugó: no hay título que atribuirle.
    const b = await profile(bench);
    expect(b.honors).toEqual([]);
    expect(outcomeIn(b, t)).toBeNull();
    expect(b.career.titles).toBe(0);
  });

  it('GROUPS_KNOCKOUT: eliminado en grupos → "Fase de grupos"; el campeón recibe CHAMPION', async () => {
    const t = await tournament({ system: 'GROUPS_KNOCKOUT', groupCount: 2, qualifiersPerGroup: 1 });
    const [e1, e2, e3, e4] = await teams(t, 4); // grupos: A = E1, E3 · B = E2, E4
    const [winner, out] = [await newPlayer(), await newPlayer()];
    await register(t, winner, e1);
    await register(t, out, e3);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const order = [e1, e2, e3, e4];
    await playAll(t, order, { [e1]: [winner], [e3]: [out] });
    await as().post(`/api/tournaments/${t}/phases/advance`).send({ startDate: '2027-04-01' }).expect(200);
    await playAll(t, order, { [e1]: [winner], [e3]: [out] });
    await as().post(`/api/tournaments/${t}/finish`).send({}).expect(200);

    expect(outcomeIn(await profile(out), t)).toMatchObject({ champion: false, runnerUp: false, reached: 'Fase de grupos' });
    expect(kinds(await profile(winner), t)).toContain('CHAMPION');
  });

  it('LEAGUE_PLAYOFFS: el líder de la fase regular que pierde la final es finalista, no campeón', async () => {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 });
    const [e1, e2, e3] = await teams(t, 3);
    const [leader, champ] = [await newPlayer(), await newPlayer()];
    await register(t, leader, e1);
    await register(t, champ, e2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    await playAll(t, [e1, e2, e3], { [e1]: [leader], [e2]: [champ] });
    await as().post(`/api/tournaments/${t}/phases/advance`).send({ startDate: '2027-04-01' }).expect(200);
    await playAll(t, [e2, e1], { [e1]: [leader], [e2]: [champ] }); // la final la gana el 2º
    await as().post(`/api/tournaments/${t}/finish`).send({}).expect(200);

    const l = await profile(leader);
    expect(kinds(l, t)).toEqual(['RUNNER_UP']);
    expect(l.career.titles).toBe(0);
    expect(kinds(await profile(champ), t)).toEqual(['CHAMPION']);
  });
});

describe('Player Profile V2 · carrera', () => {
  it('varios torneos y equipos: por año (fecha real), por equipo (equipo representado), hitos, récords y mejores actuaciones', async () => {
    const p = await newPlayer();
    const t1 = await tournament({ system: 'LEAGUE' }, '2026-10-01');
    const [a1, a2] = await teams(t1, 2);
    await as().put(`/api/tournaments/${t1}/players/${p}`).send({ teamId: a1, jerseyNumber: 9, startDate: '2026-10-01' }).expect(200);
    const m1 = (await as().post('/api/matches').send({ tournamentId: t1, round: 1, homeTeamId: a1, awayTeamId: a2, date: '2026-11-07', time: '18:00' }).expect(201)).body.id;
    await as().put(`/api/matches/${m1}/result`).send({ homeScore: 3, awayScore: 0, playerStats: [{ playerId: p, teamId: a1, played: true, goals: 3, assists: 0, yellowCards: 0, redCards: 0 }] }).expect(200);

    const t2 = await tournament({ system: 'LEAGUE' }, '2027-01-01');
    const [b1, b2] = await teams(t2, 2);
    await register(t2, p, b2, 7);
    const m2 = (await as().post('/api/matches').send({ tournamentId: t2, round: 1, homeTeamId: b1, awayTeamId: b2, date: '2027-01-16', time: '18:00' }).expect(201)).body.id;
    await as().put(`/api/matches/${m2}/result`).send({ homeScore: 1, awayScore: 2, playerStats: [{ playerId: p, teamId: b2, played: true, goals: 1, assists: 1, yellowCards: 0, redCards: 0 }] }).expect(200);

    const prof = await profile(p);
    expect(prof.byYear.map((y: { year: string; stats: { appearances: number; goals: number } }) => [y.year, y.stats.appearances, y.stats.goals])).toEqual([
      ['2027', 1, 1],
      ['2026', 1, 3],
    ]);
    expect(prof.byTeam.map((x: { team: { id: string }; stats: { goals: number } }) => [x.team.id, x.stats.goals]).sort()).toEqual([[a1, 3], [b2, 1]].sort());
    expect(prof.career).toMatchObject({ appearances: 2, goals: 4, assists: 1, assistsPerMatch: 0.5, goalsPerMatch: 2, teams: 2 });
    expect(prof.milestones.map((m: { type: string }) => m.type)).toEqual(['FIRST_ASSIST', 'FIRST_HAT_TRICK', 'FIRST_BRACE', 'FIRST_GOAL', 'FIRST_MATCH']);
    expect(prof.records).toMatchObject({ mostGoalsInMatch: { value: 3, match: { id: m1 } }, hatTricks: 1, longestScoringStreak: { value: 2 } });
    expect(prof.bestPerformances.map((m: { id: string }) => m.id)).toEqual([m1, m2]);
    expect(prof.currentParticipations[0]).toMatchObject({ team: { id: b2 }, stats: { appearances: 1, goals: 1, assists: 1 } });
  });

  it('privacidad: ninguna clave privada en todo el agregado V2', async () => {
    const p = await newPlayer({ birthDate: '2011-02-02' });
    const body = await profile(p);
    const FORBIDDEN = ['birthDate', 'email', 'phone', 'password', 'passwordHash', 'createdBy', 'organizerId', 'searchName', 'writeSeq', 'settings', 'phases'];
    const walk = (v: unknown): string[] =>
      Array.isArray(v) ? v.flatMap(walk) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) ? [k] : []), ...walk(x)]) : [];
    expect(walk(body)).toEqual([]);
    expect(body.player.age).toBeGreaterThan(0);
  });
});
