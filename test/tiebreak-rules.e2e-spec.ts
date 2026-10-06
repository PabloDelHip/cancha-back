/**
 * Desempates configurables (2026-10-04): penales en empates de liga con punto extra al ganador, y
 * regla para llaves igualadas (penales, tiempos extra + penales, o pasa el mejor de la tabla), con
 * regla propia opcional para la final. API real.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
let token: string;
const as = () => authed(http, token);
let seq = 0;

const create = (settings: Record<string, unknown>) =>
  as().post('/api/tournaments').send({ name: `Copa D${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', settings });
async function tournament(settings: Record<string, unknown>) {
  return (await create(settings).expect(201)).body.id as string;
}
async function teams(t: string, n: number) {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = (await as().post('/api/teams').send({ name: `E${String(i).padStart(2, '0')} ${++seq}` }).expect(201)).body.id as string;
    await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    out.push(id);
  }
  return out;
}
type M = { id: string; homeTeamId: string; awayTeamId: string; status: string; homeScore: number | null; stage: { tie: { round: number } | null } | null };
const matchesOf = async (t: string) => (await api().get(`/api/tournaments/${t}/matches`).expect(200)).body as M[];
const result = (m: string, hs: number, as_: number, extra: Record<string, unknown> = {}) =>
  as().put(`/api/matches/${m}/result`).send({ homeScore: hs, awayScore: as_, playerStats: [], ...extra });
const structure = async (t: string) => (await api().get(`/api/tournaments/${t}/structure`).expect(200)).body;
const ko = async (t: string) => (await structure(t)).phases.find((p: { type: string }) => p.type === 'KNOCKOUT');
/** Liga: gana el que aparece antes en `order` (1-0). */
async function playLeague(t: string, order: string[]) {
  for (const m of await matchesOf(t)) {
    if (m.stage?.tie || m.homeScore !== null) continue;
    const homeWins = order.indexOf(m.homeTeamId) < order.indexOf(m.awayTeamId);
    await result(m.id, homeWins ? 1 : 0, homeWins ? 0 : 1).expect(200);
  }
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  token = (await registerOrganizer(http, 'Desempates')).token;
});
afterAll(async () => ctx?.close());

describe('Configuración', () => {
  it('se guarda; "mejor de la tabla" solo en Liga + playoffs; null desactiva los penales de liga', async () => {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 4, pointsForShootoutWin: 1, knockoutTiebreak: 'BETTER_POSITION', finalTiebreak: 'EXTRA_TIME' });
    expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.settings).toMatchObject({ pointsForShootoutWin: 1, knockoutTiebreak: 'BETTER_POSITION', finalTiebreak: 'EXTRA_TIME' });
    await as().patch(`/api/tournaments/${t}`).send({ settings: { pointsForShootoutWin: null, finalTiebreak: null } }).expect(200);
    expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.settings).toMatchObject({ pointsForShootoutWin: null, knockoutTiebreak: 'BETTER_POSITION', finalTiebreak: null });

    expect((await create({ system: 'KNOCKOUT', knockoutTiebreak: 'BETTER_POSITION' }).expect(400)).body.message).toMatch(/mejor de la tabla/);
    await create({ system: 'GROUPS_KNOCKOUT', groupCount: 2, qualifiersPerGroup: 2, finalTiebreak: 'BETTER_POSITION' }).expect(400);
    await create({ pointsForShootoutWin: 0 }).expect(400);
  });
});

describe('Liga: penales en empates (punto extra)', () => {
  it('empate + penales: ambos suman el empate y el ganador de la tanda el extra', async () => {
    const t = await tournament({ pointsForShootoutWin: 1 });
    const [a, b] = await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const [m] = await matchesOf(t);
    await result(m.id, 1, 2, { penalties: { home: 4, away: 3 } }).expect(400); // no fue empate
    await result(m.id, 1, 1, { penalties: { home: 3, away: 3 } }).expect(400); // tanda empatada
    await result(m.id, 1, 1, { extraTime: true }).expect(400); // no hay prórroga en liga
    await result(m.id, 1, 1, { penalties: { home: 5, away: 4 } }).expect(200);
    const table = (await api().get(`/api/tournaments/${t}/standings`).expect(200)).body as { teamId: string; points: number; draws: number }[];
    const winner = m.homeTeamId;
    expect(table.find((r) => r.teamId === winner)).toMatchObject({ points: 2, draws: 1 });
    expect(table.find((r) => r.teamId !== winner)).toMatchObject({ points: 1, draws: 1 });
    expect([a, b]).toContain(winner);
  });

  it('sin la regla, un empate de liga no admite penales', async () => {
    const t = await tournament({});
    await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const [m] = await matchesOf(t);
    expect((await result(m.id, 0, 0, { penalties: { home: 4, away: 3 } }).expect(400)).body.message).toMatch(/no define los empates en penales/);
  });
});

describe('Playoffs: llaves igualadas', () => {
  it('liga + playoffs: semis igualadas pasan los mejores de la tabla; la final (regla propia) va a penales', async () => {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 4, knockoutTiebreak: 'BETTER_POSITION', finalTiebreak: 'PENALTIES' });
    const ids = await teams(t, 4);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    await playLeague(t, ids); // tabla: ids[0] > ids[1] > ids[2] > ids[3]
    await as().post(`/api/tournaments/${t}/phases/advance`).send({ startDate: '2027-05-01' }).expect(200);

    const semis = (await matchesOf(t)).filter((m) => m.stage?.tie?.round === 0);
    expect((await result(semis[0].id, 1, 1, { penalties: { home: 4, away: 3 } }).expect(400)).body.message).toMatch(/mejor posicionado/);
    for (const m of semis) await result(m.id, 2, 2).expect(200);
    let k = await ko(t);
    expect(k.rounds[0].ties.map((x: { decidedBy: string; winnerTeamId: string }) => [x.decidedBy, x.winnerTeamId])).toEqual([
      ['POSITION', ids[0]],
      ['POSITION', ids[1]],
    ]);

    const final = (await matchesOf(t)).find((m) => m.stage?.tie?.round === 1)!;
    await result(final.id, 0, 0).expect(200);
    k = await ko(t);
    expect(k.rounds[1].ties[0]).toMatchObject({ tiebreak: 'PENALTIES', status: 'NEEDS_PENALTIES' });
    await result(final.id, 0, 0, { penalties: { home: 2, away: 4 } }).expect(200);
    expect((await structure(t)).championTeamId).toBe(final.awayTeamId);
  });

  it('tiempos extra: se marcan en la llave (solo con esa regla) y si sigue igualada, penales', async () => {
    const t = await tournament({ system: 'KNOCKOUT', knockoutTiebreak: 'EXTRA_TIME' });
    await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const [m] = await matchesOf(t);
    await result(m.id, 2, 2, { extraTime: true }).expect(200);
    let k = await ko(t);
    expect(k.rounds[0].ties[0]).toMatchObject({ tiebreak: 'EXTRA_TIME', status: 'NEEDS_PENALTIES' });
    expect(k.rounds[0].ties[0].legs[0].extraTime).toBe(true);
    await result(m.id, 3, 2, { extraTime: true }).expect(200);
    k = await ko(t);
    expect(k.rounds[0].ties[0]).toMatchObject({ decidedBy: 'SCORE', winnerTeamId: m.homeTeamId });

    const p = await tournament({ system: 'KNOCKOUT' }); // regla: penales directo
    await teams(p, 2);
    await as().post(`/api/tournaments/${p}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    const [n] = await matchesOf(p);
    expect((await result(n.id, 1, 1, { extraTime: true }).expect(400)).body.message).toMatch(/no hay tiempos extra/);
  });

  it('con llaves ya jugadas, la regla de desempate no cambia (cambiaría quién pasó)', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    await as().patch(`/api/tournaments/${t}`).send({ settings: { knockoutTiebreak: 'EXTRA_TIME' } }).expect(200); // aún sin jugar
    const [m] = await matchesOf(t);
    await result(m.id, 1, 0).expect(200);
    await as().patch(`/api/tournaments/${t}`).send({ settings: { knockoutTiebreak: 'PENALTIES' } }).expect(409);
    await as().patch(`/api/tournaments/${t}`).send({ settings: { pointsForShootoutWin: 1 } }).expect(200); // lo demás sí
  });
});

describe('Reacomodo de llaves (liguilla)', () => {
  /** Liga de 8 con playoffs de 8: tabla = orden de `ids`; en cuartos ganan los sembrados `winners`. */
  async function liguilla(settings: Record<string, unknown>, winners: number[]) {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 8, ...settings });
    const ids = await teams(t, 8);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    await playLeague(t, ids);
    await as().post(`/api/tournaments/${t}/phases/advance`).send({ startDate: '2027-05-01' }).expect(200);
    const k = await ko(t);
    const seedOf = new Map<string, number>(k.seeds.map((s: { seed: number; teamId: string }) => [s.teamId, s.seed]));
    const bySeed = new Map<number, string>(k.seeds.map((s: { seed: number; teamId: string }) => [s.seed, s.teamId]));
    const quarters = k.rounds[0].ties.map((x: { homeTeamId: string; awayTeamId: string }) => [seedOf.get(x.homeTeamId), seedOf.get(x.awayTeamId)]);
    for (const m of (await matchesOf(t)).filter((x) => x.stage?.tie?.round === 0)) {
      const homeWins = winners.includes(seedOf.get(m.homeTeamId) as number);
      await result(m.id, homeWins ? 2 : 0, homeWins ? 0 : 2).expect(200);
    }
    return { t, k: await ko(t), seedOf, bySeed, quarters };
  }
  const leg = { date: '2027-06-01', time: '18:00', venue: null };
  const tie = (t: string, round: number, home: string, away: string) =>
    as().post(`/api/tournaments/${t}/phases/1/ties`).send({ round, homeTeamId: home, awayTeamId: away, legs: [leg] });

  it('con reacomodo: cuartos por siembra (1-8, 4-5, 2-7, 3-6) y las semis NO se arman solas; el organizador las arma (1 vs 7, 5 vs 6)', async () => {
    const { t, k, seedOf, bySeed, quarters } = await liguilla({ reseed: true }, [1, 5, 7, 6]);
    expect(quarters).toEqual([[1, 8], [4, 5], [2, 7], [3, 6]]);
    expect(k.rounds[1].ties).toEqual([]); // vacías: las arma el organizador
    expect((await matchesOf(t)).filter((x) => x.stage?.tie?.round === 1)).toEqual([]);

    // La primera ronda no se toca a mano.
    expect((await tie(t, 0, bySeed.get(1)!, bySeed.get(7)!).expect(409)).body.message).toMatch(/primera ronda/);
    await tie(t, 1, bySeed.get(1)!, bySeed.get(7)!).expect(201);
    await tie(t, 1, bySeed.get(5)!, bySeed.get(6)!).expect(201);
    const semis = (await ko(t)).rounds[1].ties.map((x: { homeTeamId: string; awayTeamId: string }) => [seedOf.get(x.homeTeamId), seedOf.get(x.awayTeamId)]);
    expect(semis).toEqual([[1, 7], [5, 6]]);
    expect((await matchesOf(t)).filter((x) => x.stage?.tie?.round === 1)).toHaveLength(2);

    // Semis: ganan 1 y 5 → la final también la arma el organizador y define al campeón.
    for (const m of (await matchesOf(t)).filter((x) => x.stage?.tie?.round === 1)) await result(m.id, 1, 0).expect(200);
    expect((await ko(t)).rounds[2].ties).toEqual([]);
    await tie(t, 2, bySeed.get(1)!, bySeed.get(5)!).expect(201);
    const [final] = (await matchesOf(t)).filter((x) => x.stage?.tie?.round === 2);
    await result(final.id, 0, 2).expect(200);
    expect((await structure(t)).championTeamId).toBe(bySeed.get(5));
  });

  it('cuadro fijo (por defecto): ganan 1, 5, 7 y 6 → semis 1 vs 5 y 7 vs 6 solas, como en el Mundial; no se arman a mano', async () => {
    const { t, k, seedOf, bySeed } = await liguilla({}, [1, 5, 7, 6]);
    expect(k.rounds[1].ties.map((x: { homeTeamId: string; awayTeamId: string }) => [seedOf.get(x.homeTeamId), seedOf.get(x.awayTeamId)])).toEqual([[1, 5], [7, 6]]);
    await tie(t, 1, bySeed.get(1)!, bySeed.get(7)!).expect(409);
  });
});
