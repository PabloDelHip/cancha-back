import { CompetitionSystem, KnockoutTiebreak, MatchStatus, PhaseType } from '../../common/enums/index.js';
import { bracketOrder, buildBracket, reconcile, roundName } from './bracket.js';
import { groupSizes, validateFormatForTeams, validateFormatSettings } from './formats.js';
import { dealGroups, planInitialPhase, planKnockout } from './planner.js';
import { buildStructure } from './structure.js';
import { rankTable, type StagedMatch } from './tables.js';
import type { TournamentPhase } from './types.js';
import { computeStandings } from '../statistics/calculations.js';

const schedule = { startDate: '2027-01-02', daysBetweenRounds: 7, firstKickoff: '18:00', minutesBetweenMatches: 60, venue: null };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${String(i + 1).padStart(2, '0')}`);
let seq = 0;
const M = (home: string, away: string, hs: number | null, as: number | null, stage: StagedMatch['stage'], extra: Partial<StagedMatch> = {}): StagedMatch => ({
  id: `m${++seq}`,
  tournamentId: 't',
  round: 1,
  date: '2027-01-01',
  time: '18:00',
  status: hs === null ? MatchStatus.SCHEDULED : MatchStatus.FINISHED,
  homeTeamId: home,
  awayTeamId: away,
  homeScore: hs,
  awayScore: as,
  stage,
  penalties: null,
  ...extra,
});
const tieStage = (round: number, slot: number, leg = 0, phase = 0) => ({ phase, group: null, tie: { round, slot, leg } });

describe('bracket: estructura', () => {
  it('orden estándar de cabezas de serie: 1-4/2-3 y 1-8/4-5/2-7/3-6', () => {
    expect(bracketOrder(4)).toEqual([1, 4, 2, 3]);
    expect(bracketOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(bracketOrder(16).slice(0, 4)).toEqual([1, 16, 8, 9]);
  });

  it('8 equipos: cuartos → semifinal → final, cada llave alimenta a la siguiente', () => {
    const b = buildBracket(8);
    expect(b.filter((t) => t.round === 0)).toHaveLength(4);
    expect(b.filter((t) => t.round === 1)).toHaveLength(2);
    expect(b.filter((t) => t.round === 2)).toEqual([
      { round: 2, slot: 0, home: { type: 'WINNER', round: 1, slot: 0 }, away: { type: 'WINNER', round: 1, slot: 1 } },
    ]);
    expect([8, 4, 2].map(roundName)).toEqual(['Cuartos de final', 'Semifinal', 'Final']);
  });

  it('6 equipos: cuadro de 8 con BYE para las cabezas 1 y 2, sin equipos inventados', () => {
    const seeds = ids(6).map((teamId, i) => ({ seed: i + 1, teamId, origin: '' }));
    const plan = planKnockout(0, seeds, 1, schedule, 1);
    const state = reconcile(plan.phase!, []);
    const r0 = state.ties.filter((t) => t.round === 0);
    expect(r0.filter((t) => t.bye).map((t) => t.winnerTeamId)).toEqual(['t01', 't02']);
    // solo se juegan 4-5 y 3-6 en la primera ronda
    expect(plan.matches.map((m) => [m.homeTeamId, m.awayTeamId])).toEqual([
      ['t04', 't05'],
      ['t03', 't06'],
    ]);
    expect(new Set(plan.matches.flatMap((m) => [m.homeTeamId, m.awayTeamId])).size).toBe(4);
  });

  it('5 equipos: las llaves con dos BYE-ganadores ya definidas se programan al generar', () => {
    const seeds = ids(5).map((teamId, i) => ({ seed: i + 1, teamId, origin: '' }));
    const plan = planKnockout(0, seeds, 1, schedule, 1);
    // 1ª ronda: solo 4 vs 5; semifinal 2: ganador BYE (2) vs ganador BYE (3) ya se conoce
    expect(plan.matches.map((m) => [m.stage!.tie!.round, m.homeTeamId, m.awayTeamId])).toEqual([
      [0, 't04', 't05'],
      [1, 't02', 't03'],
    ]);
  });
});

describe('bracket: reconcile', () => {
  const four = () => planKnockout(0, ids(4).map((teamId, i) => ({ seed: i + 1, teamId, origin: '' })), 1, schedule, 1).phase!;

  it('avance por marcador y creación del partido siguiente; campeón = ganador de la final', () => {
    const phase = four();
    const sf = [M('t01', 't04', 2, 0, tieStage(0, 0)), M('t02', 't03', 0, 1, tieStage(0, 1))];
    let r = reconcile(phase, sf);
    expect(r.ties.filter((t) => t.round === 0).map((t) => t.winnerTeamId)).toEqual(['t01', 't03']);
    expect(r.create).toEqual([{ round: 1, slot: 0, leg: 0, homeTeamId: 't01', awayTeamId: 't03' }]);
    expect(r.championTeamId).toBeNull();
    r = reconcile(phase, [...sf, M('t01', 't03', 1, 2, tieStage(1, 0))]);
    expect(r.championTeamId).toBe('t03');
    expect(r.complete).toBe(true);
  });

  it('empate a partido único: sin penales la llave queda pendiente; con penales decide', () => {
    const phase = four();
    const drawn = M('t01', 't04', 1, 1, tieStage(0, 0));
    expect(reconcile(phase, [drawn]).ties[0]).toMatchObject({ status: 'NEEDS_PENALTIES', winnerTeamId: null });
    const pens = { ...drawn, penalties: { home: 3, away: 4 } };
    expect(reconcile(phase, [pens]).ties[0]).toMatchObject({ status: 'DECIDED', winnerTeamId: 't04', decidedBy: 'PENALTIES' });
  });

  it('ida y vuelta: global (ida en casa del peor sembrado, vuelta en casa del mejor)', () => {
    const phase = planKnockout(0, ids(2).map((teamId, i) => ({ seed: i + 1, teamId, origin: '' })), 2, schedule, 1).phase!;
    const initial = reconcile(phase, []);
    expect(initial.create).toEqual([
      { round: 0, slot: 0, leg: 0, homeTeamId: 't02', awayTeamId: 't01' },
      { round: 0, slot: 0, leg: 1, homeTeamId: 't01', awayTeamId: 't02' },
    ]);
    // ida 2-1 para t02; vuelta 1-0 para t01 → global 2-2 → penales en la vuelta
    const ida = M('t02', 't01', 2, 1, tieStage(0, 0, 0));
    const vuelta = M('t01', 't02', 1, 0, tieStage(0, 0, 1));
    expect(reconcile(phase, [ida, vuelta]).ties[0]).toMatchObject({ aggregate: { home: 2, away: 2 }, status: 'NEEDS_PENALTIES' });
    const vuelta2 = { ...vuelta, homeScore: 2 };
    expect(reconcile(phase, [ida, vuelta2]).ties[0]).toMatchObject({ aggregate: { home: 3, away: 2 }, winnerTeamId: 't01', decidedBy: 'SCORE' });
  });

  it('corregir una semifinal: la final sin jugar se actualiza; la final jugada genera conflicto', () => {
    const phase = four();
    const sf1 = M('t01', 't04', 2, 0, tieStage(0, 0));
    const sf2 = M('t02', 't03', 0, 1, tieStage(0, 1));
    const final = M('t01', 't03', null, null, tieStage(1, 0));
    const corrected = { ...sf1, homeScore: 0, awayScore: 2 }; // ahora gana t04
    expect(reconcile(phase, [corrected, sf2, final]).update).toEqual([{ matchId: final.id, homeTeamId: 't04', awayTeamId: 't03' }]);
    const playedFinal = { ...final, homeScore: 1, awayScore: 0, status: MatchStatus.FINISHED };
    expect(reconcile(phase, [corrected, sf2, playedFinal]).conflicts).toHaveLength(1);
    // si la semifinal vuelve a quedar sin decidir, la final sin jugar se retira
    const undecided = { ...sf1, homeScore: 1, awayScore: 1 };
    expect(reconcile(phase, [undecided, sf2, final]).remove).toEqual([final.id]);
  });
});

describe('formatos: configuración', () => {
  it('grupos: los clasificados deben formar un cuadro (potencia de 2); playoffs 2/4/8/16', () => {
    expect(validateFormatSettings({ system: CompetitionSystem.GROUPS_KNOCKOUT, groupCount: 4, qualifiersPerGroup: 2 })).toEqual([]);
    expect(validateFormatSettings({ system: CompetitionSystem.GROUPS_KNOCKOUT, groupCount: 3, qualifiersPerGroup: 1 })[0]).toMatch(/Clasificarían 3/);
    expect(validateFormatSettings({ system: CompetitionSystem.LEAGUE_PLAYOFFS, playoffTeams: 6 })).toHaveLength(1);
    expect(validateFormatSettings({ system: CompetitionSystem.LEAGUE_PLAYOFFS, playoffTeams: 8 })).toEqual([]);
  });

  it('con equipos: grupos suficientes, clasificados ≤ tamaño del grupo, playoffs ≤ inscritos', () => {
    const groups = { system: CompetitionSystem.GROUPS_KNOCKOUT, groupCount: 4, qualifiersPerGroup: 2 };
    expect(validateFormatForTeams(groups, 16)).toEqual([]);
    expect(validateFormatForTeams(groups, 7)[0]).toMatch(/no alcanzan/);
    expect(validateFormatForTeams({ ...groups, qualifiersPerGroup: 4 }, 12)[0]).toMatch(/grupo más pequeño/);
    expect(validateFormatForTeams({ system: CompetitionSystem.LEAGUE_PLAYOFFS, playoffTeams: 8 }, 6)[0]).toMatch(/solo hay 6/);
    expect(groupSizes(10, 3)).toEqual([4, 3, 3]);
  });
});

describe('tablas: empates sin criterio deportivo', () => {
  it('un empate en la línea de corte bloquea; el orden del organizador lo resuelve', () => {
    // a y b empatan en todo; c gana; d pierde
    const matches = [M('a', 'x', 1, 0, null), M('b', 'y', 1, 0, null), M('c', 'x', 5, 0, null)];
    const rows = computeStandings(['a', 'b', 'c', 'x', 'y'], matches, (id) => id, { win: 3, draw: 1, loss: 0 });
    const blocked = rankTable(rows, 2);
    expect(blocked.unresolved).toEqual([{ teamIds: ['a', 'b'], positions: [2, 3] }]);
    const decided = rankTable(rows, 2, [{ scope: 'LEAGUE', order: ['b', 'a'] }]);
    expect(decided.unresolved).toEqual([]);
    expect(decided.rows.slice(0, 3).map((r) => r.teamId)).toEqual(['c', 'b', 'a']);
    // un empate por debajo del corte no importa
    expect(rankTable(rows, 1).unresolved).toEqual([]);
  });
});

describe('fases: grupos y liga + playoffs', () => {
  it('reparto alternado en grupos y round robin dentro de cada grupo', () => {
    expect(dealGroups(ids(8), 2).map((g) => g.teamIds)).toEqual([
      ['t01', 't03', 't05', 't07'],
      ['t02', 't04', 't06', 't08'],
    ]);
    const plan = planInitialPhase({
      system: CompetitionSystem.GROUPS_KNOCKOUT,
      legs: 1,
      knockoutLegs: 1,
      groupCount: 2,
      teamIds: ids(8),
      schedule,
    });
    expect(plan.matches).toHaveLength(12); // 2 grupos × 6 partidos
    for (const m of plan.matches) {
      const g = plan.phase!.groups!.find((x) => x.key === m.stage!.group)!;
      expect(g.teamIds).toContain(m.homeTeamId);
      expect(g.teamIds).toContain(m.awayTeamId);
    }
    for (const r of plan.rounds) {
      const playing = plan.matches.filter((m) => m.round === r.number).flatMap((m) => [m.homeTeamId, m.awayTeamId]);
      expect(new Set(playing).size).toBe(playing.length);
    }
  });

  it('grupos → cuadro: primeros contra segundos de otro grupo; tabla independiente por grupo', () => {
    const phase: TournamentPhase = { index: 0, type: PhaseType.GROUPS, legs: 1, groups: [{ key: 'A', teamIds: ['a1', 'a2', 'a3'] }, { key: 'B', teamIds: ['b1', 'b2', 'b3'] }] };
    const g = (group: string) => ({ phase: 0, group, tie: null });
    const matches = [
      M('a1', 'a2', 2, 0, g('A')), M('a1', 'a3', 2, 0, g('A')), M('a2', 'a3', 1, 0, g('A')),
      M('b1', 'b2', 3, 0, g('B')), M('b1', 'b3', 3, 0, g('B')), M('b2', 'b3', 2, 1, g('B')),
    ];
    const view = buildStructure({
      system: CompetitionSystem.GROUPS_KNOCKOUT, points: { win: 3, draw: 1, loss: 0 }, playoffTeams: null, qualifiersPerGroup: 2, knockoutTiebreak: KnockoutTiebreak.PENALTIES, finalTiebreak: null,
      phases: [phase], matches, teamIds: [...phase.groups![0].teamIds, ...phase.groups![1].teamIds], nameOf: (id) => id,
    });
    const groups = view.phases[0].type === PhaseType.GROUPS ? view.phases[0].groups : [];
    expect(groups.map((x) => x.table.map((r) => r.teamId))).toEqual([['a1', 'a2', 'a3'], ['b1', 'b2', 'b3']]);
    expect(view.next).toMatchObject({ ready: true, seeds: [
      { seed: 1, teamId: 'a1', origin: 'A1' }, { seed: 2, teamId: 'b1', origin: 'B1' },
      { seed: 3, teamId: 'a2', origin: 'A2' }, { seed: 4, teamId: 'b2', origin: 'B2' },
    ] });
    // cuadro de 4 con orden 1-4 / 2-3 → A1 vs B2, B1 vs A2
  });

  it('liga + playoffs: el campeón es el ganador de la final aunque otro lidere la tabla', () => {
    const regular: TournamentPhase = { index: 0, type: PhaseType.LEAGUE, legs: 1 };
    const l = { phase: 0, group: null, tie: null };
    const league = [M('a', 'b', 3, 0, l), M('a', 'c', 3, 0, l), M('a', 'd', 3, 0, l), M('b', 'c', 1, 0, l), M('b', 'd', 1, 0, l), M('c', 'd', 1, 0, l)];
    const ko = planKnockout(1, ['a', 'b', 'c', 'd'].map((teamId, i) => ({ seed: i + 1, teamId, origin: '' })), 1, schedule, 7).phase!;
    const playoff = [
      M('a', 'd', 0, 1, tieStage(0, 0, 0, 1)), // el líder cae en semifinal
      M('b', 'c', 2, 0, tieStage(0, 1, 0, 1)),
      M('d', 'b', 0, 1, tieStage(1, 0, 0, 1)),
    ];
    const view = buildStructure({
      system: CompetitionSystem.LEAGUE_PLAYOFFS, points: { win: 3, draw: 1, loss: 0 }, playoffTeams: 4, qualifiersPerGroup: null, knockoutTiebreak: KnockoutTiebreak.PENALTIES, finalTiebreak: null,
      phases: [regular, ko], matches: [...league, ...playoff], teamIds: ['a', 'b', 'c', 'd'], nameOf: (id) => id,
    });
    const table = view.phases[0].type === PhaseType.LEAGUE ? view.phases[0].table : [];
    expect(table[0].teamId).toBe('a');
    expect(table[0].played).toBe(3); // los playoffs no ensucian la tabla regular
    expect(view.championTeamId).toBe('b');
  });
});

describe('desempates configurables', () => {
  const l = { phase: 0, group: null, tie: null };

  it('liga: el ganador de los penales tras un empate suma el punto extra (no cuenta como victoria)', () => {
    const matches = [M('a', 'b', 1, 1, l, { penalties: { home: 4, away: 3 } }), M('c', 'd', 0, 0, l, { penalties: { home: 2, away: 5 } })];
    const rows = computeStandings(['a', 'b', 'c', 'd'], matches, (id) => id, { win: 3, draw: 1, loss: 0, shootoutWin: 1 });
    const pts = Object.fromEntries(rows.map((r) => [r.teamId, [r.points, r.wins, r.draws]]));
    expect(pts).toEqual({ a: [2, 0, 1], b: [1, 0, 1], c: [1, 0, 1], d: [2, 0, 1] });
    // Sin la regla, los penales no dan puntos.
    const plain = computeStandings(['a', 'b'], matches, (id) => id, { win: 3, draw: 1, loss: 0, shootoutWin: null });
    expect(plain.map((r) => r.points)).toEqual([1, 1]);
  });

  // Liga + playoffs de 4: tabla a > b > c > d; semifinales a–d y b–c.
  function playoffs(knockoutTiebreak: KnockoutTiebreak, finalTiebreak: KnockoutTiebreak | null, playoff: StagedMatch[]) {
    const regular: TournamentPhase = { index: 0, type: PhaseType.LEAGUE, legs: 1 };
    const league = [M('a', 'b', 3, 0, l), M('a', 'c', 3, 0, l), M('a', 'd', 3, 0, l), M('b', 'c', 1, 0, l), M('b', 'd', 1, 0, l), M('c', 'd', 1, 0, l)];
    const ko = planKnockout(1, ['a', 'b', 'c', 'd'].map((teamId, i) => ({ seed: i + 1, teamId, origin: '' })), 1, schedule, 7).phase!;
    const view = buildStructure({
      system: CompetitionSystem.LEAGUE_PLAYOFFS, points: { win: 3, draw: 1, loss: 0 }, playoffTeams: 4, qualifiersPerGroup: null,
      knockoutTiebreak, finalTiebreak, phases: [regular, ko], matches: [...league, ...playoff], teamIds: ['a', 'b', 'c', 'd'], nameOf: (id) => id,
    });
    const k = view.phases[1];
    return { view, ties: k.type === PhaseType.KNOCKOUT ? k.rounds.flatMap((r) => r.ties) : [] };
  }

  it('pasa el mejor de la tabla: semifinal igualada sin penales → avanza el mejor posicionado', () => {
    const { ties } = playoffs(KnockoutTiebreak.BETTER_POSITION, null, [M('a', 'd', 1, 1, tieStage(0, 0, 0, 1)), M('b', 'c', 0, 0, tieStage(0, 1, 0, 1))]);
    expect(ties[0]).toMatchObject({ winnerTeamId: 'a', decidedBy: 'POSITION', status: 'DECIDED', tiebreak: 'BETTER_POSITION' });
    expect(ties[1]).toMatchObject({ winnerTeamId: 'b', decidedBy: 'POSITION' });
  });

  it('regla propia de la final: semis por posición, la final va a penales', () => {
    const { ties, view } = playoffs(KnockoutTiebreak.BETTER_POSITION, KnockoutTiebreak.PENALTIES, [
      M('a', 'd', 1, 1, tieStage(0, 0, 0, 1)),
      M('b', 'c', 0, 0, tieStage(0, 1, 0, 1)),
      M('a', 'b', 2, 2, tieStage(1, 0, 0, 1)),
    ]);
    const final = ties.find((t) => t.round === 1)!;
    expect(final).toMatchObject({ tiebreak: 'PENALTIES', status: 'NEEDS_PENALTIES', winnerTeamId: null });
    expect(view.championTeamId).toBeNull();
    const decided = playoffs(KnockoutTiebreak.BETTER_POSITION, KnockoutTiebreak.PENALTIES, [
      M('a', 'd', 1, 1, tieStage(0, 0, 0, 1)),
      M('b', 'c', 0, 0, tieStage(0, 1, 0, 1)),
      M('a', 'b', 2, 2, tieStage(1, 0, 0, 1), { penalties: { home: 3, away: 4 } }),
    ]);
    expect(decided.view.championTeamId).toBe('b');
  });

  it('tiempos extra: el marcador final (con la prórroga) decide; si sigue igualada, penales', () => {
    const { ties } = playoffs(KnockoutTiebreak.EXTRA_TIME, null, [
      M('a', 'd', 2, 1, tieStage(0, 0, 0, 1), { extraTime: true }),
      M('b', 'c', 1, 1, tieStage(0, 1, 0, 1), { extraTime: true }),
    ]);
    expect(ties[0]).toMatchObject({ winnerTeamId: 'a', decidedBy: 'SCORE', tiebreak: 'EXTRA_TIME' });
    expect(ties[0].legs[0].extraTime).toBe(true);
    expect(ties[1]).toMatchObject({ status: 'NEEDS_PENALTIES' });
  });
});

