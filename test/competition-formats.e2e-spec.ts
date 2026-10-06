/**
 * Etapa 5.5 — Formatos de competición: liga, eliminación directa, grupos + eliminación y liga +
 * playoffs. Todo contra la API real: generación, avance, bracket, desempates, campeón oficial,
 * cierre, honors, reglas de escritura, concurrencia y privacidad.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type Org = Awaited<ReturnType<typeof registerOrganizer>>;
let A: Org;
const as = () => authed(http, A.token);

let seq = 0;
async function tournament(settings: Record<string, unknown>) {
  seq++;
  return (
    await as()
      .post('/api/tournaments')
      .send({ name: `Copa F${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', settings })
      .expect(201)
  ).body.id as string;
}
/** Equipos con nombre ordenable: la siembra por defecto es alfabética (E01 = cabeza de serie 1). */
async function teams(t: string, n: number) {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    seq++;
    const id = (await as().post('/api/teams').send({ name: `E${String(i).padStart(2, '0')} ${seq}` }).expect(201)).body.id as string;
    await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    out.push(id);
  }
  return out;
}
const schedule = (t: string, body: Record<string, unknown> = {}) =>
  as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06', ...body });
const structure = async (t: string) => (await api().get(`/api/tournaments/${t}/structure`).expect(200)).body;
const matchesOf = async (t: string) =>
  (await api().get(`/api/tournaments/${t}/matches`).expect(200)).body as {
    id: string;
    homeTeamId: string;
    awayTeamId: string;
    status: string;
    homeScore: number | null;
    stage: { phase: number; group: string | null; tie: { round: number; slot: number; leg: number } | null } | null;
  }[];
const result = (m: string, hs: number, as_: number, extra: Record<string, unknown> = {}) =>
  as().put(`/api/matches/${m}/result`).send({ homeScore: hs, awayScore: as_, playerStats: [], ...extra });
const advance = (t: string, body: Record<string, unknown> = {}) =>
  as().post(`/api/tournaments/${t}/phases/advance`).send({ startDate: '2027-05-01', ...body });
const finish = (t: string) => as().post(`/api/tournaments/${t}/finish`).send({});

/** Juega todos los partidos pendientes: gana `pick(home, away)` 1-0. */
async function playPending(t: string, pick: (home: string, away: string) => string, filter = (_m: { stage: unknown }) => true) {
  for (const m of await matchesOf(t)) {
    if (m.homeScore !== null || m.status !== 'SCHEDULED' || !filter(m)) continue;
    const winner = pick(m.homeTeamId, m.awayTeamId);
    await result(m.id, winner === m.homeTeamId ? 1 : 0, winner === m.homeTeamId ? 0 : 1).expect(200);
  }
}
/** Juega el cuadro ronda a ronda hasta que no quedan partidos por jugar. */
async function playBracket(t: string, pick: (home: string, away: string) => string) {
  for (let guard = 0; guard < 10; guard++) {
    const pending = (await matchesOf(t)).filter((m) => m.homeScore === null && m.status === 'SCHEDULED');
    if (!pending.length) return;
    await playPending(t, pick);
  }
}
/** Gana el que aparece antes en `order`; los que no aparecen, después de todos (y entre ellos, el local). */
const better = (order: string[]) => (h: string, a: string) => {
  const rank = (x: string) => (order.includes(x) ? order.indexOf(x) : Infinity);
  return rank(a) < rank(h) ? a : h;
};
const koPhase = (s: { phases: { type: string }[] }) => s.phases.find((p) => p.type === 'KNOCKOUT') as unknown as {
  rounds: { name: string; ties: { homeTeamId: string | null; awayTeamId: string | null; winnerTeamId: string | null; bye: boolean; status: string; aggregate: unknown }[] }[];
  championTeamId: string | null;
  seeds: { seed: number; teamId: string; origin: string }[];
};

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Fer');
});
afterAll(async () => ctx?.close());

describe('LEAGUE (compatibilidad V1)', () => {
  it('ida y vuelta, campeón = líder verificable de la tabla final', async () => {
    const t = await tournament({ system: 'LEAGUE' });
    const tm = await teams(t, 3);
    await schedule(t, { legs: 2 }).expect(201);
    expect((await matchesOf(t)).every((m) => m.stage === null)).toBe(true); // liga clásica sin estructura
    await playPending(t, better(tm));
    const s = await structure(t);
    expect(s.phases).toHaveLength(1);
    expect(s.championTeamId).toBe(tm[0]);
    await finish(t).expect(200);
    const profile = (await api().get(`/api/teams/${tm[0]}/profile`).expect(200)).body;
    expect(profile.honors.map((h: { tournament: { id: string } }) => h.tournament.id)).toEqual([t]);
  });
});

describe('KNOCKOUT', () => {
  it('4 equipos (cuadro fijo): semifinales 1-4 y 2-3, la final se crea sola, campeón = ganador de la final', async () => {
    const t = await tournament({ system: 'KNOCKOUT', reseed: false });
    const tm = await teams(t, 4);
    const gen = await schedule(t).expect(201);
    expect(gen.body.rounds.map((r: { name: string }) => r.name)).toEqual(['Semifinal', 'Final']);
    const semis = gen.body.matches.map((m: { homeTeamId: string; awayTeamId: string }) => [m.homeTeamId, m.awayTeamId]);
    expect(semis).toEqual([
      [tm[0], tm[3]],
      [tm[1], tm[2]],
    ]);
    await playPending(t, better([tm[3], tm[2], tm[1], tm[0]])); // ganan los peor sembrados
    const s1 = koPhase(await structure(t));
    expect(s1.rounds[1].ties[0]).toMatchObject({ homeTeamId: tm[3], awayTeamId: tm[2], status: 'READY' });
    await finish(t).expect(409); // la final no tiene ganador
    await playBracket(t, better([tm[2]]));
    const s2 = await structure(t);
    expect(s2.championTeamId).toBe(tm[2]);
    await finish(t).expect(200);
    const champ = (await api().get(`/api/teams/${tm[2]}/profile`).expect(200)).body;
    expect(champ.honors).toEqual([{ type: 'CHAMPION', tournament: { id: t, name: expect.any(String) }, year: 2027, decidedBy: 'FINAL' }]);
    expect(champ.career.matchesPlayed).toBe(2); // los partidos de eliminatoria cuentan en el historial
    const finalist = (await api().get(`/api/teams/${tm[3]}/profile`).expect(200)).body;
    expect(finalist.honors).toEqual([]); // finalista: no es un título
    expect(finalist.runnerUps).toEqual([{ tournament: { id: t, name: expect.any(String) }, year: 2027 }]);
    expect(champ.runnerUps).toEqual([]);
  });

  it('8 equipos: cuartos → semifinal → final; el mejor sembrado gana todo', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const tm = await teams(t, 8);
    const gen = await schedule(t).expect(201);
    expect(gen.body.rounds.map((r: { name: string }) => r.name)).toEqual(['Cuartos de final', 'Semifinal', 'Final']);
    expect(gen.body.matches.map((m: { homeTeamId: string; awayTeamId: string }) => [tm.indexOf(m.homeTeamId) + 1, tm.indexOf(m.awayTeamId) + 1])).toEqual([
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6],
    ]);
    await playBracket(t, better(tm));
    expect((await structure(t)).championTeamId).toBe(tm[0]);
    expect(await matchesOf(t)).toHaveLength(7);
  });

  it('6 equipos: BYE para las cabezas 1 y 2, sin inventar equipos', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const tm = await teams(t, 6);
    const gen = await schedule(t).expect(201);
    expect(gen.body.matches).toHaveLength(2); // 4-5 y 3-6
    const ko = koPhase(await structure(t));
    expect(ko.rounds[0].ties.filter((x) => x.bye).map((x) => x.winnerTeamId)).toEqual([tm[0], tm[1]]);
    await playBracket(t, better(tm));
    expect((await structure(t)).championTeamId).toBe(tm[0]);
    expect(await matchesOf(t)).toHaveLength(5); // 2 + 2 semis + final
  });

  it('empate sin penales: la llave no avanza y el torneo no se finaliza; penales solo donde corresponde', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const [a, b] = await teams(t, 2);
    const [final] = await matchesOf(t).then(async () => ((await schedule(t).expect(201)).body.matches as { id: string }[]));
    await result(final.id, 1, 0, { penalties: { home: 5, away: 4 } }).expect(400); // no hubo empate
    await result(final.id, 1, 1).expect(200);
    expect(koPhase(await structure(t)).rounds[0].ties[0]).toMatchObject({ status: 'NEEDS_PENALTIES', winnerTeamId: null });
    expect((await finish(t).expect(409)).body.message).toMatch(/final/);
    await result(final.id, 1, 1, { penalties: { home: 3, away: 3 } }).expect(400);
    await result(final.id, 1, 1, { penalties: { home: 3, away: 4 } }).expect(200);
    const s = await structure(t);
    expect(s.championTeamId).toBe(b);
    expect(a).not.toBe(b);
    await finish(t).expect(200);
  });

  it('ida y vuelta: marcador global; penales solo en la vuelta', async () => {
    const t = await tournament({ system: 'KNOCKOUT', knockoutLegs: 2 });
    const [a, b] = await teams(t, 2);
    const gen = (await schedule(t).expect(201)).body;
    expect(gen.rounds.map((r: { name: string }) => r.name)).toEqual(['Final · ida', 'Final · vuelta']);
    const [ida, vuelta] = gen.matches as { id: string; homeTeamId: string }[];
    expect([ida.homeTeamId, vuelta.homeTeamId]).toEqual([b, a]); // la vuelta, en casa del mejor sembrado
    await result(ida.id, 2, 1).expect(200); // b 2-1 a
    await result(ida.id, 2, 1, { penalties: { home: 4, away: 2 } }).expect(400); // la ida no cierra la llave
    await result(vuelta.id, 1, 0).expect(200); // a 1-0 b → global 2-2
    expect(koPhase(await structure(t)).rounds[0].ties[0]).toMatchObject({ aggregate: { home: 2, away: 2 }, status: 'NEEDS_PENALTIES' });
    await result(vuelta.id, 2, 0).expect(200); // a 2-0 → global 3-2
    expect((await structure(t)).championTeamId).toBe(a);
  });
});

describe('GROUPS_KNOCKOUT', () => {
  it('2 grupos × 2 clasificados: tablas independientes, cruces 1º vs 2º de otro grupo, campeón de la final', async () => {
    const t = await tournament({ system: 'GROUPS_KNOCKOUT', groupCount: 2, qualifiersPerGroup: 2 });
    const tm = await teams(t, 8);
    await schedule(t).expect(201);
    const s0 = await structure(t);
    const groups = s0.phases[0].groups as { key: string; teamIds: string[] }[];
    expect(groups.map((g) => g.teamIds)).toEqual([
      [tm[0], tm[2], tm[4], tm[6]],
      [tm[1], tm[3], tm[5], tm[7]],
    ]);
    expect((await matchesOf(t)).every((m) => m.stage?.group && groups.find((g) => g.key === m.stage!.group)!.teamIds.includes(m.homeTeamId))).toBe(true);
    // Antes de terminar los grupos no se genera la eliminatoria.
    await advance(t).expect(409);
    await playPending(t, better(tm));
    const s1 = await structure(t);
    expect(s1.phases[0].groups.map((g: { table: { teamId: string }[] }) => g.table.map((r) => r.teamId))).toEqual([
      [tm[0], tm[2], tm[4], tm[6]],
      [tm[1], tm[3], tm[5], tm[7]],
    ]);
    expect(s1.next).toMatchObject({ ready: true });
    const adv = (await advance(t).expect(200)).body;
    const ko = koPhase(adv);
    expect(ko.seeds.map((x) => x.origin)).toEqual(['A1', 'B1', 'A2', 'B2']);
    expect(ko.rounds[0].ties.map((x) => [x.homeTeamId, x.awayTeamId])).toEqual([
      [tm[0], tm[3]], // A1 vs B2
      [tm[1], tm[2]], // B1 vs A2
    ]);
    await advance(t).expect(409); // la fase ya existe
    // Los grupos ya cerraron: su resultado no cambia.
    const groupMatch = (await matchesOf(t)).find((m) => m.stage?.group === 'A')!;
    await result(groupMatch.id, 0, 5).expect(409);
    await playBracket(t, better([tm[3], tm[1]]));
    const s2 = await structure(t);
    expect(s2.championTeamId).toBe(tm[3]); // el 2º del grupo B gana todo
    await finish(t).expect(200);
    expect((await api().get(`/api/tournaments/${t}/standings`).expect(200)).body).toEqual([]); // no hay tabla global
  });

  it('empate sin criterio deportivo en la línea de corte: bloquea hasta que el organizador decide', async () => {
    const t = await tournament({ system: 'GROUPS_KNOCKOUT', groupCount: 2, qualifiersPerGroup: 1 });
    const tm = await teams(t, 4); // A: tm0, tm2 · B: tm1, tm3
    await schedule(t).expect(201);
    for (const m of await matchesOf(t)) await result(m.id, 1, 1).expect(200); // todos empatan
    const blocked = await advance(t).expect(409);
    expect(blocked.body.blockers.join(' ')).toMatch(/grupo A.*grupo B|Empate/);
    const ok = await advance(t, {
      tiebreaks: [
        { scope: 'A', order: [tm[2], tm[0]] },
        { scope: 'B', order: [tm[1], tm[3]] },
      ],
    }).expect(200);
    expect(koPhase(ok.body).seeds.map((x) => [x.teamId, x.origin])).toEqual([
      [tm[2], 'A1'],
      [tm[1], 'B1'],
    ]);
    expect(ok.body.tiebreaks).toHaveLength(2); // la decisión queda registrada
  });
});

describe('LEAGUE_PLAYOFFS', () => {
  it('top 4: 1-4 / 2-3; el líder de la tabla regular no es campeón si pierde los playoffs', async () => {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 4 });
    const tm = await teams(t, 5);
    await schedule(t).expect(201);
    await playPending(t, better(tm)); // tabla: tm0 > tm1 > tm2 > tm3 > tm4
    const adv = (await advance(t).expect(200)).body;
    const ko = koPhase(adv);
    expect(ko.seeds.map((x) => [x.teamId, x.origin])).toEqual([
      [tm[0], '1º fase regular'],
      [tm[1], '2º fase regular'],
      [tm[2], '3º fase regular'],
      [tm[3], '4º fase regular'],
    ]);
    expect(ko.rounds[0].ties.map((x) => [x.homeTeamId, x.awayTeamId])).toEqual([
      [tm[0], tm[3]],
      [tm[1], tm[2]],
    ]);
    await playBracket(t, better([tm[1], tm[3], tm[2], tm[0]]));
    const s = await structure(t);
    expect(s.phases[0].table[0].teamId).toBe(tm[0]);
    expect(s.phases[0].table[0].played).toBe(4); // la tabla regular no incluye playoffs
    expect(s.championTeamId).toBe(tm[1]);
    await finish(t).expect(200);
    const regular = (await api().get(`/api/tournaments/${t}/standings`).expect(200)).body;
    expect(regular[0]).toMatchObject({ teamId: tm[0], played: 4 });
    expect((await api().get(`/api/teams/${tm[0]}/profile`).expect(200)).body.honors).toEqual([]);
    expect((await api().get(`/api/teams/${tm[1]}/profile`).expect(200)).body.honors).toHaveLength(1);
  });
});

describe('Configuración y reglas de escritura', () => {
  it('configuraciones imposibles se rechazan con explicación', async () => {
    const bad = await as()
      .post('/api/tournaments')
      .send({ name: 'X', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', settings: { system: 'GROUPS_KNOCKOUT', groupCount: 3, qualifiersPerGroup: 1 } })
      .expect(400);
    expect(JSON.stringify(bad.body.message)).toMatch(/Clasificarían 3/);
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 8 });
    await teams(t, 6);
    const r = await schedule(t).expect(400);
    expect(JSON.stringify(r.body.message)).toMatch(/solo hay 6/);
  });

  it('partidos de la estructura: sin altas manuales, sin cambiar equipos, sin borrar, sin cancelar llaves', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const [a, b, c, d] = await teams(t, 4);
    const m = ((await schedule(t).expect(201)).body.matches as { id: string }[])[0].id;
    await as().post('/api/matches').send({ tournamentId: t, round: 9, homeTeamId: a, awayTeamId: b, date: '2027-03-01', time: '18:00' }).expect(409);
    await as().patch(`/api/matches/${m}`).send({ homeTeamId: c }).expect(409);
    await as().delete(`/api/matches/${m}`).expect(409);
    await as().patch(`/api/matches/${m}`).send({ status: 'CANCELLED' }).expect(409);
    await as().patch(`/api/matches/${m}`).send({ status: 'POSTPONED' }).expect(200); // reprogramar sí
    await as().patch(`/api/matches/${m}`).send({ status: 'SCHEDULED', date: '2027-03-08' }).expect(200);
    expect(d).toBeDefined();
  });

  it('el formato no cambia con un calendario generado salvo confirmación explícita y sin partidos jugados', async () => {
    const t = await tournament({ system: 'LEAGUE' });
    await teams(t, 4);
    await schedule(t).expect(201);
    await as().patch(`/api/tournaments/${t}`).send({ settings: { system: 'KNOCKOUT' } }).expect(409);
    await as().patch(`/api/tournaments/${t}`).send({ settings: { system: 'KNOCKOUT' }, resetSchedule: true }).expect(200);
    expect(await matchesOf(t)).toHaveLength(0);
    await schedule(t).expect(201);
    await playPending(t, (h) => h);
    await as().patch(`/api/tournaments/${t}`).send({ settings: { system: 'LEAGUE' }, resetSchedule: true }).expect(409);
    // la puntuación sí puede cambiar
    await as().patch(`/api/tournaments/${t}`).send({ settings: { pointsForWin: 2 } }).expect(200);
  });
});

describe('Concurrencia', () => {
  it('dos avances simultáneos: se genera una sola eliminatoria', async () => {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 });
    const tm = await teams(t, 3);
    await schedule(t).expect(201);
    await playPending(t, better(tm));
    const [r1, r2] = await Promise.all([advance(t), advance(t)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((await matchesOf(t)).filter((m) => m.stage?.tie)).toHaveLength(1);
  });

  it('resultados simultáneos de las dos semifinales: la final se crea exactamente una vez', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    await teams(t, 4);
    const semis = (await schedule(t).expect(201)).body.matches as { id: string }[];
    const res = await Promise.all(semis.map((m) => result(m.id, 1, 0)));
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    const finals = (await matchesOf(t)).filter((m) => m.stage?.tie?.round === 1);
    expect(finals).toHaveLength(1);
  });

  it('finalizar a la vez que se captura la final: nunca queda FINISHED sin campeón', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    await teams(t, 2);
    const [final] = (await schedule(t).expect(201)).body.matches as { id: string }[];
    const [res, fin] = await Promise.all([result(final.id, 2, 0), finish(t)]);
    expect(res.status).toBe(200);
    const s = await structure(t);
    if (fin.status === 200) expect(s.championTeamId).not.toBeNull();
    else expect(fin.status).toBe(409);
    expect(s.status === 'FINISHED' ? !!s.championTeamId : true).toBe(true);
  });
});

describe('Privacidad de la estructura pública', () => {
  it('GET /structure no expone datos internos ni personales', async () => {
    const t = await tournament({ system: 'GROUPS_KNOCKOUT', groupCount: 2, qualifiersPerGroup: 1 });
    await teams(t, 4);
    await schedule(t).expect(201);
    const body = (await api().get(`/api/tournaments/${t}/structure`).expect(200)).body;
    const FORBIDDEN = ['birthDate', 'email', 'phone', 'password', 'createdBy', 'organizerId', 'searchName', 'writeSeq'];
    const leaks = (v: unknown, path = '$'): string[] =>
      Array.isArray(v)
        ? v.flatMap((x, i) => leaks(x, `${path}[${i}]`))
        : v && typeof v === 'object'
          ? Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) ? [`${path}.${k}`] : []), ...leaks(x, `${path}.${k}`)])
          : [];
    expect(leaks(body)).toEqual([]);
    await api().get('/api/tournaments/64b000000000000000000000/structure').expect(404);
  });
});
