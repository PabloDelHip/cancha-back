import { MatchStatus } from '../../common/enums/index.js';
import {
  computeStandings,
  computeTopScorers,
  sumTotals,
  type MatchLike,
  type StatLike,
} from './calculations.js';

let seq = 0;
function match(
  home: string,
  away: string,
  hs: number | null,
  as: number | null,
  status = MatchStatus.FINISHED,
): MatchLike {
  seq++;
  return {
    id: `m${seq}`,
    homeTeamId: home,
    awayTeamId: away,
    homeScore: hs,
    awayScore: as,
    status,
    date: `2027-01-${String(seq).padStart(2, '0')}`,
    time: '18:00',
  };
}
function stat(
  matchId: string,
  playerId: string,
  teamId: string,
  goals: number,
  extra: Partial<StatLike> = {},
): StatLike {
  return {
    matchId,
    playerId,
    teamId,
    goals,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
    played: true,
    ...extra,
  };
}

describe('computeStandings', () => {
  it('calcula la tabla del criterio de aceptación (Tigres 3-2 Halcones)', () => {
    const [tigres, halcones] = computeStandings(
      ['halcones', 'tigres'],
      [match('tigres', 'halcones', 3, 2)],
    );
    expect(tigres).toMatchObject({
      position: 1,
      teamId: 'tigres',
      played: 1,
      wins: 1,
      goalsFor: 3,
      goalsAgainst: 2,
      goalDifference: 1,
      points: 3,
    });
    expect(halcones).toMatchObject({
      position: 2,
      teamId: 'halcones',
      played: 1,
      losses: 1,
      goalsFor: 2,
      goalsAgainst: 3,
      goalDifference: -1,
      points: 0,
    });
  });

  it('ignora partidos que no están finalizados', () => {
    const rows = computeStandings(
      ['a', 'b'],
      [
        match('a', 'b', 1, 0, MatchStatus.LIVE),
        match('a', 'b', null, null, MatchStatus.SCHEDULED),
        match('a', 'b', 2, 0, MatchStatus.CANCELLED),
      ],
    );
    expect(rows.every((r) => r.played === 0 && r.points === 0)).toBe(true);
  });

  it('empate suma un punto a cada equipo', () => {
    const rows = computeStandings(['a', 'b'], [match('a', 'b', 2, 2)]);
    expect(rows.map((r) => [r.draws, r.points])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  it('desempata por diferencia de goles y luego por goles a favor', () => {
    const rows = computeStandings(
      ['a', 'b', 'c', 'd'],
      [
        match('a', 'd', 1, 0), // a: 3 pts, DG +1, GF 1
        match('b', 'd', 3, 1), // b: 3 pts, DG +2, GF 3
        match('c', 'd', 4, 2), // c: 3 pts, DG +2, GF 4
      ],
    );
    expect(rows.map((r) => r.teamId)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('incluye equipos inscritos sin partidos', () => {
    const rows = computeStandings(['a', 'b', 'c'], [match('a', 'b', 1, 0)]);
    expect(rows.find((r) => r.teamId === 'c')).toMatchObject({
      played: 0,
      points: 0,
    });
  });
});

describe('computeTopScorers', () => {
  it('ordena por goles y solo cuenta partidos finalizados', () => {
    const m1 = match('a', 'b', 3, 1);
    const m2 = match('a', 'b', 2, 0, MatchStatus.LIVE);
    const rows = computeTopScorers(
      [m1, m2],
      [
        stat(m1.id, 'p1', 'a', 2),
        stat(m1.id, 'p2', 'a', 1),
        stat(m1.id, 'p3', 'b', 1),
        stat(m2.id, 'p2', 'a', 2), // partido en juego: no cuenta
      ],
    );
    expect(rows.map((r) => [r.playerId, r.goals])).toEqual([
      ['p1', 2],
      ['p2', 1],
      ['p3', 1],
    ]);
    expect(rows[0]).toMatchObject({ position: 1, matchesPlayed: 1 });
  });

  it('comparte posición con mismos goles y partidos; menos partidos va primero', () => {
    const m1 = match('a', 'b', 2, 2);
    const m2 = match('a', 'b', 1, 0);
    const rows = computeTopScorers(
      [m1, m2],
      [
        stat(m1.id, 'p1', 'a', 2),
        stat(m2.id, 'p1', 'a', 0),
        stat(m1.id, 'p2', 'b', 2),
        stat(m1.id, 'p3', 'a', 0),
        stat(m2.id, 'p3', 'a', 1),
      ],
    );
    expect(rows.map((r) => [r.playerId, r.position])).toEqual([
      ['p2', 1],
      ['p1', 2],
      ['p3', 3],
    ]);
  });

  it('asigna el equipo del partido más reciente (jugador transferido)', () => {
    const m1 = match('a', 'b', 1, 0);
    const m2 = match('c', 'b', 1, 0);
    const rows = computeTopScorers(
      [m2, m1],
      [stat(m2.id, 'p1', 'c', 1), stat(m1.id, 'p1', 'a', 1)],
    );
    expect(rows[0]).toMatchObject({ teamId: 'c', goals: 2, matchesPlayed: 2 });
  });
});

describe('sumTotals', () => {
  it('no cuenta participaciones con played = false', () => {
    const totals = sumTotals([
      stat('m1', 'p', 'a', 2, { assists: 1, yellowCards: 1 }),
      stat('m2', 'p', 'a', 0, { played: false }),
      stat('m3', 'p', 'a', 1, { redCards: 1 }),
    ]);
    expect(totals).toEqual({
      matchesPlayed: 2,
      goals: 3,
      assists: 1,
      yellowCards: 1,
      redCards: 1,
    });
  });
});

describe('computeStandings · puntuación del torneo y desempates', () => {
  it('usa la puntuación recibida (2/1/0) en lugar de 3/1/0', () => {
    const matches = [match('x', 'y', 1, 0), match('x', 'y', 1, 1)];
    const classic = computeStandings(['x', 'y'], matches);
    expect(classic.map((r) => [r.teamId, r.points])).toEqual([['x', 4], ['y', 1]]);
    const custom = computeStandings(['x', 'y'], matches, undefined, { win: 2, draw: 1, loss: 0 });
    expect(custom.map((r) => [r.teamId, r.points])).toEqual([['x', 3], ['y', 1]]);
    const withLoss = computeStandings(['x', 'y'], matches, undefined, { win: 3, draw: 2, loss: 1 });
    expect(withLoss.map((r) => [r.teamId, r.points])).toEqual([['x', 5], ['y', 3]]);
  });

  it('desempata por puntos → diferencia de goles → goles a favor', () => {
    const rows = computeStandings(
      ['t1', 't2', 't3', 't4'],
      [match('t1', 't4', 3, 0), match('t2', 't4', 4, 1), match('t3', 't4', 1, 0)],
    );
    // t1 y t2: 3 pts y DG +3 → decide GF (4 > 3); t3: 3 pts con DG +1
    expect(rows.map((r) => r.teamId)).toEqual(['t2', 't1', 't3', 't4']);
  });

  it('solo cuentan partidos FINISHED (no SCHEDULED, LIVE, POSTPONED ni CANCELLED)', () => {
    const rows = computeStandings(
      ['a', 'b'],
      [
        match('a', 'b', 2, 0, MatchStatus.LIVE),
        match('a', 'b', null, null, MatchStatus.POSTPONED),
        match('a', 'b', null, null, MatchStatus.CANCELLED),
        match('a', 'b', null, null, MatchStatus.SCHEDULED),
      ],
    );
    expect(rows.every((r) => r.played === 0 && r.points === 0)).toBe(true);
  });
});

