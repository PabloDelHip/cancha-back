import type { PhaseType } from '../../common/enums/index.js';

/**
 * Estructura de un torneo por fases. Se guarda embebida en Tournament.phases (ids como string) y
 * solo la escribe el servidor dentro del cerrojo del torneo.
 */

/**
 * De dónde sale cada lado de una eliminatoria: cabeza de serie, ganador de otra llave (cuadro
 * automático) o un equipo elegido por el organizador (cuadro armado a mano).
 */
export type SlotSource = { type: 'SEED'; seed: number } | { type: 'WINNER'; round: number; slot: number } | { type: 'TEAM'; teamId: string };

/** Una llave del bracket: ronda (0 = primera), posición y el origen de sus dos lados. */
export interface BracketTie {
  round: number;
  slot: number;
  home: SlotSource;
  away: SlotSource;
}

/** Cabeza de serie de una fase eliminatoria y su procedencia ("A1", "3º liga", "sorteo 5"). */
export interface KnockoutSeed {
  seed: number;
  teamId: string;
  origin: string;
}

export interface PhaseSchedule {
  startDate: string;
  daysBetweenRounds: number;
  firstKickoff: string;
  minutesBetweenMatches: number;
  venue: string | null;
}

/** Orden decidido por el organizador para romper un empate sin criterio deportivo. */
export interface TiebreakDecision {
  scope: string; // 'LEAGUE' o la clave del grupo
  order: string[];
}

export interface TournamentPhase {
  index: number;
  type: PhaseType;
  /** Vueltas (todos contra todos) o partidos por llave (eliminatoria). */
  legs: 1 | 2;
  /** GROUPS */
  groups?: { key: string; teamIds: string[] }[];
  /** KNOCKOUT */
  /**
   * Cuadro armado a mano: el organizador crea cada cruce (ronda y equipos) y sus partidos. Nada se
   * siembra ni se crea solo; ganadores y campeón se siguen derivando de los resultados.
   */
  manual?: boolean;
  /**
   * Reacomodo (liguilla tipo Liga MX): la primera ronda sale de la siembra (1-8, 4-5…) y las
   * siguientes las arma el ORGANIZADOR a mano (mejor vs peor, o como decida): nada se cruza solo.
   * Se fija al generar la fase.
   */
  reseed?: boolean;
  /** Cuadro a mano: equipos de la primera ronda (2, 4, 8…; 8 = empieza en cuartos). */
  size?: number;
  seeds?: KnockoutSeed[];
  bracket?: BracketTie[];
  /** Match.round de la primera ronda eliminatoria; ronda r, partido l → roundBase + r·legs + l. */
  roundBase?: number;
  schedule?: PhaseSchedule;
  /** Desempates decididos por el organizador al clasificar desde esta fase. */
  tiebreaks?: TiebreakDecision[];
}

/** Lugar de un partido en la estructura. */
export interface MatchStage {
  phase: number;
  group: string | null;
  tie: { round: number; slot: number; leg: number } | null;
}
