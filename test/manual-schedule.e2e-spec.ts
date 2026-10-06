/**
 * Calendario armado a mano en cualquier formato (con cobertura FULL). El organizador programa sus
 * jornadas como quiera y cuentan en la tabla de su fase (o de su grupo); en la eliminatoria puede
 * armar él cada cruce (ronda y equipos). Ganadores y campeón se siguen derivando de los resultados.
 * API real: estructura, reglas de escritura, campeón, cierre, concurrencia y permisos.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type Org = Awaited<ReturnType<typeof registerOrganizer>>;
let A: Org, B: Org;
const as = (u: Org = A) => authed(http, u.token);

let seq = 0;
async function tournament(settings: Record<string, unknown>) {
  seq++;
  return (
    await as()
      .post('/api/tournaments')
      .send({ name: `Copa M${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', settings })
      .expect(201)
  ).body.id as string;
}
async function teams(t: string, n: number) {
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    seq++;
    const id = (await as().post('/api/teams').send({ name: `M${String(i).padStart(2, '0')} ${seq}` }).expect(201)).body.id as string;
    await as().post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    out.push(id);
  }
  return out;
}
type M = { id: string; round: number; homeTeamId: string; awayTeamId: string; stage: { phase: number; group: string | null; tie: { round: number; slot: number; leg: number } | null } | null };
const structure = async (t: string) => (await api().get(`/api/tournaments/${t}/structure`).expect(200)).body;
const matchesOf = async (t: string) => (await api().get(`/api/tournaments/${t}/matches`).expect(200)).body as M[];
const match = (t: string, round: number, home: string, away: string) =>
  as().post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date: '2027-02-06', time: '18:00' });
const result = (m: string, hs: number, aw: number, extra: Record<string, unknown> = {}) =>
  as().put(`/api/matches/${m}/result`).send({ homeScore: hs, awayScore: aw, playerStats: [], ...extra });
const leg = (date = '2027-05-01') => ({ date, time: '18:00' });
const tie = (t: string, phase: number, round: number, home: string, away: string, legs = [leg()]) =>
  as().post(`/api/tournaments/${t}/phases/${phase}/ties`).send({ round, homeTeamId: home, awayTeamId: away, legs });
const ko = (s: { phases: { type: string }[] }) =>
  s.phases.find((p) => p.type === 'KNOCKOUT') as unknown as {
    manual: boolean;
    generated: boolean;
    rounds: { round: number; name: string; ties: { slot: number; homeTeamId: string | null; awayTeamId: string | null; winnerTeamId: string | null; status: string }[] }[];
    championTeamId: string | null;
  };

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Manual');
  B = await registerOrganizer(http, 'Ajeno');
});
afterAll(async () => ctx?.close());

describe('Jornadas a mano que cuentan en la tabla', () => {
  it('Liga + playoffs: partidos a mano sin generar nada → fase regular con su tabla; se editan y se borran mientras sigue abierta', async () => {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 });
    const [a, b, c] = await teams(t, 3);
    const m1 = (await match(t, 1, a, b).expect(201)).body;
    expect(m1.stage).toEqual({ phase: 0, group: null, tie: null });
    await match(t, 1, c, a).expect(409); // a ya juega la jornada 1 (regla de siempre)
    const m2 = (await match(t, 3, c, a).expect(201)).body; // la jornada la elige el organizador
    await result(m1.id, 2, 0).expect(200);
    let table = (await structure(t)).phases[0].table as { teamId: string; points: number; played: number }[];
    expect(table.find((r) => r.teamId === a)).toMatchObject({ points: 3, played: 1 });
    // Cambiar equipos de un partido sin resultado y borrar uno: es su calendario.
    await as().patch(`/api/matches/${m2.id}`).send({ homeTeamId: b, awayTeamId: c }).expect(200);
    const m3 = (await match(t, 4, a, c).expect(201)).body;
    await as().delete(`/api/matches/${m3.id}`).expect(204);
    await result(m2.id, 1, 1).expect(200);
    table = (await structure(t)).phases[0].table;
    expect(table.find((r) => r.teamId === b)).toMatchObject({ points: 1, played: 2 });
    expect(table.find((r) => r.teamId === c)).toMatchObject({ points: 1, played: 1 });
  });

  it('Grupos: se arman a mano (sin partidos); un partido cuenta en el grupo de sus equipos; entre grupos → 409', async () => {
    const t = await tournament({ system: 'GROUPS_KNOCKOUT', groupCount: 2, qualifiersPerGroup: 1 });
    const [a, b, c, d] = await teams(t, 4);
    await match(t, 1, a, b).expect(409); // aún no hay grupos
    const gen = (await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, groups: [[a, c], [b, d]] }).expect(201)).body;
    expect(gen.matches).toEqual([]);
    expect((await structure(t)).phases[0].groups.map((g: { key: string; teamIds: string[] }) => [g.key, g.teamIds])).toEqual([['A', [a, c]], ['B', [b, d]]]);
    const ac = (await match(t, 1, a, c).expect(201)).body;
    expect(ac.stage).toEqual({ phase: 0, group: 'A', tie: null });
    const cross = await match(t, 2, a, b).expect(409);
    expect(cross.body.message).toMatch(/grupos distintos/);
    await as().patch(`/api/matches/${ac.id}`).send({ awayTeamId: b }).expect(409); // pasaría a ser entre grupos
    await result(ac.id, 0, 3).expect(200);
    const groupA = (await structure(t)).phases[0].groups[0];
    expect(groupA.table[0]).toMatchObject({ teamId: c, points: 3 });
  });

  it('Liga clásica: sin cambios (sin estructura)', async () => {
    const t = await tournament({ system: 'LEAGUE' });
    const [a, b] = await teams(t, 2);
    expect((await match(t, 1, a, b).expect(201)).body.stage).toBeNull();
  });
});

describe('Eliminatoria armada a mano', () => {
  it('Eliminación directa: cuadro vacío, el organizador elige cada cruce; campeón solo con la final', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const [a, b, c, d, e] = await teams(t, 5);
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 16 }).expect(400); // con 5 inscritos, máximo 8
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true }).expect(400); // falta la ronda inicial
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 4 }).expect(201);
    let k = ko(await structure(t));
    expect(k).toMatchObject({ manual: true, generated: true, championTeamId: null });
    expect(k.rounds.map((r) => r.name)).toEqual(['Semifinal', 'Final']); // la final existe aunque aún no tenga cruces
    await match(t, 1, a, b).expect(409); // en eliminación los partidos van por cruce

    const s1 = (await tie(t, 0, 0, a, b).expect(201)).body;
    expect(ko(s1).rounds[0].ties[0]).toMatchObject({ homeTeamId: a, awayTeamId: b, status: 'READY' });
    expect((await tie(t, 0, 0, a, c).expect(409)).body.message).toMatch(/ya tiene cruce en esta ronda/);
    await tie(t, 0, 0, c, c).expect(400);
    await tie(t, 0, 0, c, d).expect(201);
    await tie(t, 0, 0, e, d).expect(409); // semifinal llena (2 cruces) — y d ya juega
    await tie(t, 0, 2, a, c).expect(400); // solo hay 2 rondas
    await tie(t, 0, 0, c, e, [leg(), leg()]).expect(400); // es a partido único

    const semis = (await matchesOf(t)).filter((m) => m.stage?.tie?.round === 0);
    expect(semis.map((m) => [m.homeTeamId, m.awayTeamId])).toEqual([[a, b], [c, d]]);
    await result(semis[0].id, 2, 1).expect(200); // gana a
    await result(semis[1].id, 0, 0, { penalties: { home: 3, away: 4 } }).expect(200); // gana d por penales
    k = ko(await structure(t));
    expect(k.rounds[0].ties.map((x) => x.winnerTeamId)).toEqual([a, d]);
    expect(k.championTeamId).toBeNull(); // ganar una semifinal no es ser campeón
    expect((await as().post(`/api/tournaments/${t}/finish`).send({})).status).toBe(409);
    expect((await matchesOf(t)).length).toBe(2); // nada se creó solo

    // La final la arma él, con quien quiera (aquí, e: decisión del organizador).
    await tie(t, 0, 1, d, e).expect(201);
    const final = (await matchesOf(t)).find((m) => m.stage?.tie?.round === 1)!;
    expect([final.homeTeamId, final.awayTeamId]).toEqual([d, e]);
    // Quitar un cruce: con resultado no; sin resultado sí (y sus partidos).
    await as().delete(`/api/tournaments/${t}/phases/0/ties/0/0`).expect(409);
    await as().delete(`/api/tournaments/${t}/phases/0/ties/1/0`).expect(200);
    expect((await matchesOf(t)).some((m) => m.id === final.id)).toBe(false);
    await tie(t, 0, 1, a, d).expect(201);
    const final2 = (await matchesOf(t)).find((m) => m.stage?.tie?.round === 1)!;
    await result(final2.id, 1, 3).expect(200);
    expect(ko(await structure(t)).championTeamId).toBe(d);
    await as().post(`/api/tournaments/${t}/finish`).send({}).expect(200);
  });

  it('Ronda llena: la final admite un solo cruce aunque haya equipos libres', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const [a, b, c, d] = await teams(t, 4);
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 2 }).expect(201);
    await tie(t, 0, 0, a, b).expect(201);
    expect((await tie(t, 0, 0, c, d).expect(409)).body.message).toMatch(/Final ya tiene sus 1 cruces/);
  });

  it('Ida y vuelta: dos fechas, el local de la ida es el elegido, decide el global', async () => {
    const t = await tournament({ system: 'KNOCKOUT', knockoutLegs: 2 });
    const [a, b] = await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 2 }).expect(201);
    await tie(t, 0, 0, a, b).expect(400); // faltan las dos fechas
    await tie(t, 0, 0, a, b, [leg('2027-05-01'), leg('2027-05-08')]).expect(201);
    const [ida, vuelta] = (await matchesOf(t)).sort((x, y) => x.stage!.tie!.leg - y.stage!.tie!.leg);
    expect([ida.homeTeamId, ida.awayTeamId, vuelta.homeTeamId, vuelta.awayTeamId]).toEqual([a, b, b, a]);
    await result(ida.id, 3, 0).expect(200);
    await result(vuelta.id, 1, 0).expect(200); // b gana la vuelta, a gana el global 3-1
    expect(ko(await structure(t)).championTeamId).toBe(a);
  });

  it('Liga + playoffs: playoffs a mano con partidos pendientes; la fase regular NO se congela', async () => {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 });
    const [a, b, c] = await teams(t, 3);
    const ab = (await match(t, 1, a, b).expect(201)).body;
    const pendiente = (await match(t, 2, b, c).expect(201)).body;
    await result(ab.id, 1, 0).expect(200);
    // Automático: exige la fase completa.
    await as().post(`/api/tournaments/${t}/phases/advance`).send({ startDate: '2027-05-01' }).expect(409);
    // A mano: no (siempre quedan partidos pendientes).
    await as().post(`/api/tournaments/${t}/phases/advance`).send({ manual: true, bracketSize: 2 }).expect(200);
    await as().post(`/api/tournaments/${t}/phases/advance`).send({ manual: true, bracketSize: 2 }).expect(409); // ya existe
    await tie(t, 1, 0, a, c).expect(201);
    // La fase regular sigue abierta: se juega el pendiente y se programan más.
    await result(pendiente.id, 2, 2).expect(200);
    await match(t, 9, a, c).expect(201);
    const final = (await matchesOf(t)).find((m) => m.stage?.tie)!;
    expect(final.round).toBeGreaterThan(2); // jornada siguiente a lo programado al crear la fase
    await result(final.id, 0, 1).expect(200);
    expect((await structure(t)).championTeamId).toBe(c);
  });

  it('Cuadro automático: sus cruces no se eligen a mano; y el automático congela la fase anterior', async () => {
    const t = await tournament({ system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 });
    const [a, b] = await teams(t, 2);
    await as().post(`/api/tournaments/${t}/schedule`).send({ startDate: '2027-02-06' }).expect(201);
    for (const m of await matchesOf(t)) await result(m.id, 1, 0).expect(200);
    await as().post(`/api/tournaments/${t}/phases/advance`).send({ startDate: '2027-05-01' }).expect(200);
    const res = await tie(t, 1, 0, a, b).expect(409);
    expect(res.body.message).toMatch(/automáticamente/);
    expect((await match(t, 20, a, b).expect(409)).body.message).toMatch(/definió los clasificados/);
  });

  it('Concurrencia: dos cruces simultáneos con el mismo equipo en la misma ronda → uno solo', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const [a, b, c, d] = await teams(t, 4);
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 4 }).expect(201);
    const res = await Promise.all([tie(t, 0, 0, a, b), tie(t, 0, 0, a, c), tie(t, 0, 0, d, a)]);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(2);
    expect((await matchesOf(t)).length).toBe(1);
    expect(ko(await structure(t)).rounds[0].ties).toHaveLength(1);
  });

  it('Permisos: solo el organizador del torneo; sin sesión 401', async () => {
    const t = await tournament({ system: 'KNOCKOUT' });
    const [a, b] = await teams(t, 2);
    await as(B).post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 2 }).expect(403);
    await as().post(`/api/tournaments/${t}/schedule`).send({ manual: true, bracketSize: 2 }).expect(201);
    await as(B).post(`/api/tournaments/${t}/phases/0/ties`).send({ round: 0, homeTeamId: a, awayTeamId: b, legs: [leg()] }).expect(403);
    await api().post(`/api/tournaments/${t}/phases/0/ties`).send({ round: 0, homeTeamId: a, awayTeamId: b, legs: [leg()] }).expect(401);
    await tie(t, 0, 0, a, b).expect(201);
    await as(B).delete(`/api/tournaments/${t}/phases/0/ties/0/0`).expect(403);
  });
});
