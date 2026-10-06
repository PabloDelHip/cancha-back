/**
 * Cálculos puros de estadísticas derivadas. No tocan la base de datos:
 * reciben partidos y participaciones y devuelven tablas. Nada de esto se persiste.
 *
 * Reglas:
 * - Solo cuentan partidos FINISHED con marcador.
 * - Solo cuentan participaciones con played = true.
 * - Puntos: los de Tournament.settings (por defecto victoria 3, empate 1, derrota 0).
 * - Orden de la tabla: puntos, diferencia de goles, goles a favor
 *   (y nombre del equipo solo para que el orden sea estable; no es un criterio deportivo).
 * - Goleadores: goles desc; empate → menos partidos jugados, luego más asistencias.
 */
import { MatchStatus } from '../../common/enums/index.js';

export interface PointsRule {
  win: number;
  draw: number;
  loss: number;
  /** Extra al ganador de los penales tras un empate (null/ausente = no hay penales en empates). */
  shootoutWin?: number | null;
}

/** Regla de puntos desde la configuración guardada del torneo (con los valores por defecto). */
export function pointsRuleOf(s?: { pointsForWin?: number; pointsForDraw?: number; pointsForLoss?: number; pointsForShootoutWin?: number | null } | null): PointsRule {
  return { win: s?.pointsForWin ?? 3, draw: s?.pointsForDraw ?? 1, loss: s?.pointsForLoss ?? 0, shootoutWin: s?.pointsForShootoutWin ?? null };
}

export const POINTS: PointsRule = { win: 3, draw: 1, loss: 0 };

export type Result = 'W' | 'D' | 'L';

export interface MatchLike {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  status: MatchStatus;
  homeScore: number | null;
  awayScore: number | null;
  date: string;
  time: string;
  /** Penales tras un empate (liga: punto extra; eliminatoria: los decide el bracket). */
  penalties?: { home: number; away: number } | null;
}

export interface StatLike {
  matchId: string;
  playerId: string;
  teamId: string;
  played: boolean;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
}

export interface StandingRow {
  position: number;
  teamId: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  /** Últimos 5 resultados, del más antiguo al más reciente. */
  form: Result[];
}

export interface Totals {
  matchesPlayed: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
}

export interface ScorerRow extends Totals {
  position: number;
  playerId: string;
  teamId: string;
}

type PlayedMatch = MatchLike & { homeScore: number; awayScore: number };

export function isFinished(m: MatchLike): m is PlayedMatch {
  return (
    m.status === MatchStatus.FINISHED &&
    m.homeScore !== null &&
    m.awayScore !== null
  );
}

export function byKickoff(
  a: Pick<MatchLike, 'date' | 'time'>,
  b: Pick<MatchLike, 'date' | 'time'>,
): number {
  return `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`);
}

export function resultFor(match: MatchLike, teamId: string): Result | null {
  if (!isFinished(match)) return null;
  const own = match.homeTeamId === teamId ? match.homeScore : match.awayScore;
  const rival = match.homeTeamId === teamId ? match.awayScore : match.homeScore;
  return own > rival ? 'W' : own < rival ? 'L' : 'D';
}

export function computeStandings(
  teamIds: string[],
  matches: MatchLike[],
  nameOf: (teamId: string) => string = (id) => id,
  points: PointsRule = POINTS,
): StandingRow[] {
  const rows = new Map<string, Omit<StandingRow, 'position'>>(
    teamIds.map((teamId) => [
      teamId,
      {
        teamId,
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0,
        form: [],
      },
    ]),
  );

  for (const m of matches.filter(isFinished).sort(byKickoff)) {
    const sides = [
      { id: m.homeTeamId, gf: m.homeScore, ga: m.awayScore },
      { id: m.awayTeamId, gf: m.awayScore, ga: m.homeScore },
    ];
    for (const side of sides) {
      const row = rows.get(side.id);
      if (!row) continue; // equipo ya no inscrito: no aparece en la tabla
      row.played++;
      row.goalsFor += side.gf;
      row.goalsAgainst += side.ga;
      if (side.gf > side.ga) {
        row.wins++;
        row.points += points.win;
        row.form.push('W');
      } else if (side.gf < side.ga) {
        row.losses++;
        row.points += points.loss;
        row.form.push('L');
      } else {
        row.draws++;
        row.points += points.draw;
        row.form.push('D');
        // Empate definido en penales: el ganador de la tanda suma el extra (no cuenta como victoria).
        const pen = m.penalties;
        if (points.shootoutWin && pen && pen.home !== pen.away && (side.id === m.homeTeamId) === pen.home > pen.away) {
          row.points += points.shootoutWin;
        }
      }
    }
  }

  return [...rows.values()]
    .map((r) => ({
      ...r,
      goalDifference: r.goalsFor - r.goalsAgainst,
      form: r.form.slice(-5),
    }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goalDifference - a.goalDifference ||
        b.goalsFor - a.goalsFor ||
        nameOf(a.teamId).localeCompare(nameOf(b.teamId)),
    )
    .map((r, i) => ({ ...r, position: i + 1 }));
}

export function emptyTotals(): Totals {
  return {
    matchesPlayed: 0,
    goals: 0,
    assists: 0,
    yellowCards: 0,
    redCards: 0,
  };
}

export function sumTotals(stats: StatLike[]): Totals {
  return stats
    .filter((s) => s.played)
    .reduce<Totals>(
      (acc, s) => ({
        matchesPlayed: acc.matchesPlayed + 1,
        goals: acc.goals + s.goals,
        assists: acc.assists + s.assists,
        yellowCards: acc.yellowCards + s.yellowCards,
        redCards: acc.redCards + s.redCards,
      }),
      emptyTotals(),
    );
}

/**
 * @param matches partidos del torneo (se filtran los finalizados aquí)
 * @param stats participaciones de esos partidos
 */
export function computeTopScorers(
  matches: MatchLike[],
  stats: StatLike[],
  limit = 20,
): ScorerRow[] {
  const finished = new Map(matches.filter(isFinished).map((m) => [m.id, m]));
  const byPlayer = new Map<string, StatLike[]>();
  for (const s of stats) {
    if (!s.played || !finished.has(s.matchId)) continue;
    byPlayer.set(s.playerId, [...(byPlayer.get(s.playerId) ?? []), s]);
  }

  const rows = [...byPlayer.entries()]
    .map(([playerId, list]) => {
      // Equipo del partido más reciente del jugador en este torneo.
      const latest = [...list].sort((a, b) =>
        byKickoff(finished.get(b.matchId)!, finished.get(a.matchId)!),
      )[0];
      return { playerId, teamId: latest.teamId, ...sumTotals(list) };
    })
    .filter((r) => r.goals > 0)
    .sort(
      (a, b) =>
        b.goals - a.goals ||
        a.matchesPlayed - b.matchesPlayed ||
        b.assists - a.assists,
    )
    .slice(0, limit);

  // Mismos goles y partidos → misma posición (1, 2, 2, 4…).
  return rows.map((row, i) => {
    let j = i;
    while (
      j > 0 &&
      rows[j - 1].goals === row.goals &&
      rows[j - 1].matchesPlayed === row.matchesPlayed
    )
      j--;
    return { ...row, position: j + 1 };
  });
}
