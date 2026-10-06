/**
 * Tablas de las fases todos contra todos (LEAGUE y GROUPS) y quién clasifica desde ellas.
 * Funciones puras sobre partidos ya leídos. La tabla es la misma de GET /standings
 * (computeStandings: puntos → diferencia → goles a favor), pero SOLO con los partidos de la fase
 * (y del grupo): los playoffs nunca ensucian la tabla regular.
 *
 * Empates: si dos equipos igualan en puntos, diferencia y goles a favor, computeStandings los
 * ordena por nombre, que NO es un criterio deportivo. Cuando ese orden decide algo (un pase o una
 * cabeza de serie), no se usa: el organizador debe decidirlo explícitamente (TiebreakDecision).
 */
import { MatchStatus } from '../../common/enums/index.js';
import { computeStandings, type MatchLike, type PointsRule, type StandingRow } from '../statistics/calculations.js';
import type { MatchStage, TiebreakDecision } from './types.js';

export interface StagedMatch extends MatchLike {
  tournamentId: string;
  round: number;
  stage: MatchStage | null;
  penalties: { home: number; away: number } | null;
  /** Se jugaron tiempos extra (solo informativo: el marcador ya los incluye). */
  extraTime?: boolean;
}

const OPEN = new Set<string>([MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.POSTPONED]);

/** Partidos de una fase (sin stage = fase 0: liga clásica de V1). */
export const phaseMatches = <T extends { stage: MatchStage | null }>(matches: T[], phase: number) =>
  matches.filter((m) => (m.stage?.phase ?? 0) === phase);

export const groupMatches = <T extends { stage: MatchStage | null }>(matches: T[], phase: number, group: string) =>
  phaseMatches(matches, phase).filter((m) => m.stage?.group === group);

/** Fase todos contra todos terminada: tiene partidos y ninguno sigue pendiente. */
export const roundRobinComplete = (matches: MatchLike[]) => matches.length > 0 && !matches.some((m) => OPEN.has(m.status));

export const pendingOf = (matches: MatchLike[]) => matches.filter((m) => OPEN.has(m.status)).length;

const sameMarks = (a: StandingRow, b: StandingRow) =>
  a.points === b.points && a.goalDifference === b.goalDifference && a.goalsFor === b.goalsFor;

/** Grupos de ≥2 equipos empatados en todos los criterios deportivos (en orden de tabla). */
export function tiedClusters(rows: StandingRow[]): StandingRow[][] {
  const clusters: StandingRow[][] = [];
  let current: StandingRow[] = [];
  for (const row of rows) {
    if (current.length && sameMarks(current[0], row)) current.push(row);
    else {
      if (current.length > 1) clusters.push(current);
      current = [row];
    }
  }
  if (current.length > 1) clusters.push(current);
  return clusters;
}

export interface RankedTable {
  rows: StandingRow[];
  /** Empates que afectan a las primeras `decisive` posiciones y nadie resolvió. */
  unresolved: { teamIds: string[]; positions: [number, number] }[];
}

/**
 * Tabla con los desempates del organizador aplicados y los empates que siguen sin resolver entre
 * las posiciones que deciden algo (1..decisive; un empate que cruza la línea de corte también).
 */
export function rankTable(rows: StandingRow[], decisive: number, decisions: TiebreakDecision[] = [], scope = 'LEAGUE'): RankedTable {
  const byTeam = new Map(rows.map((r) => [r.teamId, r]));
  const result = [...rows];
  const unresolved: RankedTable['unresolved'] = [];
  for (const cluster of tiedClusters(rows)) {
    const first = cluster[0].position;
    const last = cluster[cluster.length - 1].position;
    if (first > decisive) continue; // empate que no decide nada
    const ids = cluster.map((r) => r.teamId).sort();
    const decision = decisions.find((d) => d.scope === scope && [...d.order].sort().join() === ids.join());
    if (!decision) {
      unresolved.push({ teamIds: cluster.map((r) => r.teamId), positions: [first, last] });
      continue;
    }
    decision.order.forEach((teamId, i) => (result[first - 1 + i] = byTeam.get(teamId)!));
  }
  return { rows: result.map((r, i) => ({ ...r, position: i + 1 })), unresolved };
}

export function leagueTable(teamIds: string[], matches: MatchLike[], nameOf: (id: string) => string, points: PointsRule) {
  return computeStandings(teamIds, matches, nameOf, points);
}
