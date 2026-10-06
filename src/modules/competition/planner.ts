/**
 * Planificación de fases: qué jornadas y partidos genera cada tipo de fase. Funciones puras; los
 * services las ejecutan dentro del cerrojo del torneo.
 *
 * - LEAGUE: round robin actual (método del círculo, ver rounds/round-robin.ts).
 * - GROUPS: el mismo round robin DENTRO de cada grupo; la jornada N reúne la jornada N de todos
 *   los grupos (un equipo está en un solo grupo, así que nunca juega dos veces por jornada).
 * - KNOCKOUT: bracket con cabezas de serie (bracket.ts); se crean solo los partidos de las llaves
 *   cuyos dos equipos ya se conocen. Las siguientes se crean al decidirse las anteriores.
 */
import { Types } from 'mongoose';
import { CompetitionSystem, MatchStatus, PhaseType } from '../../common/enums/index.js';
import { addDays, addMinutes, generateRoundRobin } from '../rounds/round-robin.js';
import { buildBracket, knockoutRoundNumber, phaseRounds, reconcile, roundName, roundsOf, nextPowerOfTwo } from './bracket.js';
import { groupSizes, phasesOf } from './formats.js';
import type { KnockoutSeed, MatchStage, PhaseSchedule, TournamentPhase } from './types.js';

export interface PlannedRound {
  number: number;
  name: string | null;
  date: string;
}

export interface PlannedMatch {
  round: number;
  homeTeamId: string;
  awayTeamId: string;
  date: string;
  time: string;
  venue: string | null;
  stage: MatchStage | null;
}

export interface PhasePlan {
  phase: TournamentPhase | null;
  rounds: PlannedRound[];
  matches: PlannedMatch[];
}

export const GROUP_KEYS = 'ABCDEFGH'.split('');

/** Todos contra todos (liga o grupos). `phase = null` → liga clásica V1 (sin stage). */
export function planRoundRobin(
  phaseIndex: number | null,
  groups: { key: string | null; teamIds: string[] }[],
  legs: 1 | 2,
  schedule: PhaseSchedule,
  roundStart = 1,
): { rounds: PlannedRound[]; matches: PlannedMatch[] } {
  const perGroup = groups.map((g) => ({ key: g.key, rounds: generateRoundRobin(g.teamIds, legs) }));
  const total = Math.max(0, ...perGroup.map((g) => g.rounds.length));
  const rounds: PlannedRound[] = [];
  const matches: PlannedMatch[] = [];
  for (let r = 0; r < total; r++) {
    const number = roundStart + r;
    const date = addDays(schedule.startDate, r * schedule.daysBetweenRounds);
    rounds.push({ number, name: null, date });
    let i = 0;
    for (const g of perGroup) {
      for (const [home, away] of g.rounds[r]?.pairs ?? []) {
        matches.push({
          round: number,
          homeTeamId: home,
          awayTeamId: away,
          date,
          time: addMinutes(schedule.firstKickoff, i++ * schedule.minutesBetweenMatches),
          venue: schedule.venue,
          stage: phaseIndex === null ? null : { phase: phaseIndex, group: g.key, tie: null },
        });
      }
    }
  }
  return { rounds, matches };
}

/** Fase eliminatoria desde cabezas de serie ya ordenadas (1 = mejor). */
export function planKnockout(phaseIndex: number, seeds: KnockoutSeed[], legs: 1 | 2, schedule: PhaseSchedule, roundBase: number, reseed = false): PhasePlan {
  const bracket = buildBracket(seeds.length, reseed);
  const phase: TournamentPhase = { index: phaseIndex, type: PhaseType.KNOCKOUT, legs, seeds, bracket, roundBase, schedule, ...(reseed ? { reseed } : {}) };
  const size = nextPowerOfTwo(seeds.length);
  const rounds: PlannedRound[] = [];
  for (let r = 0; r < phaseRounds(phase); r++) {
    for (let l = 0; l < legs; l++) {
      const name = roundName(size / 2 ** r) + (legs === 2 ? (l === 0 ? ' · ida' : ' · vuelta') : '');
      rounds.push({ number: knockoutRoundNumber(phase, r, l), name, date: knockoutDate(phase, r, l) });
    }
  }
  // Los BYE se resuelven solos; se crean los partidos de las llaves ya definidas.
  const matches = reconcile(phase, []).create.map((spec) => knockoutMatch(phase, spec));
  return { phase, rounds, matches };
}

export function knockoutDate(phase: TournamentPhase, round: number, leg: number) {
  const s = phase.schedule!;
  return addDays(s.startDate, (round * phase.legs + leg) * s.daysBetweenRounds);
}

export function knockoutMatch(
  phase: TournamentPhase,
  spec: { round: number; slot: number; leg: number; homeTeamId: string; awayTeamId: string },
): PlannedMatch {
  const s = phase.schedule!;
  return {
    round: knockoutRoundNumber(phase, spec.round, spec.leg),
    homeTeamId: spec.homeTeamId,
    awayTeamId: spec.awayTeamId,
    date: knockoutDate(phase, spec.round, spec.leg),
    time: addMinutes(s.firstKickoff, spec.slot * s.minutesBetweenMatches),
    venue: s.venue,
    stage: { phase: phase.index, group: null, tie: { round: spec.round, slot: spec.slot, leg: spec.leg } },
  };
}

/** Reparte equipos (en orden de siembra) en grupos A, B, C… alternando: 1→A, 2→B, …, luego vuelve a A. */
export function dealGroups(teamIds: string[], groupCount: number) {
  const sizes = groupSizes(teamIds.length, groupCount);
  const groups = sizes.map((_, g) => ({ key: GROUP_KEYS[g], teamIds: [] as string[] }));
  teamIds.forEach((id, i) => groups[i % groupCount].teamIds.push(id));
  return groups;
}

export interface InitialPlanInput {
  system: CompetitionSystem;
  legs: 1 | 2;
  knockoutLegs: 1 | 2;
  /** Reacomodo de llaves (ver TournamentPhase.reseed). */
  reseed?: boolean;
  groupCount: number | null;
  /** Equipos en orden de siembra (por defecto, por nombre). */
  teamIds: string[];
  /** Grupos explícitos del organizador (opcional). */
  groups?: string[][];
  schedule: PhaseSchedule;
}

/** Primera fase de cada formato. La liga clásica conserva exactamente el comportamiento de V1. */
export function planInitialPhase(input: InitialPlanInput): PhasePlan {
  const first = phasesOf(input.system)[0];
  if (first === PhaseType.KNOCKOUT) {
    const seeds = input.teamIds.map((teamId, i) => ({ seed: i + 1, teamId, origin: `Cabeza de serie ${i + 1}` }));
    return planKnockout(0, seeds, input.knockoutLegs, input.schedule, 1, input.reseed ?? false);
  }
  if (first === PhaseType.GROUPS) {
    const groups = input.groups
      ? input.groups.map((teamIds, g) => ({ key: GROUP_KEYS[g], teamIds }))
      : dealGroups(input.teamIds, input.groupCount!);
    const plan = planRoundRobin(0, groups, input.legs, input.schedule);
    return { phase: { index: 0, type: PhaseType.GROUPS, legs: input.legs, groups }, ...plan };
  }
  // LEAGUE: liga clásica sin estructura (V1) o fase regular de LEAGUE_PLAYOFFS.
  const classic = input.system === CompetitionSystem.LEAGUE;
  const plan = planRoundRobin(classic ? null : 0, [{ key: null, teamIds: input.teamIds }], input.legs, input.schedule);
  return { phase: classic ? null : { index: 0, type: PhaseType.LEAGUE, legs: input.legs }, ...plan };
}

/** Cuadro vacío armado a mano: el organizador crea cada cruce con sus partidos. */
export function manualKnockoutPhase(index: number, legs: 1 | 2, size: number, roundBase: number): TournamentPhase {
  return { index, type: PhaseType.KNOCKOUT, legs, manual: true, size, seeds: [], bracket: [], roundBase };
}

/**
 * Primera fase armada a mano: la estructura (grupos o cuadro vacío) sin jornadas ni partidos; el
 * organizador programa los suyos. Liga clásica: sin estructura (como siempre).
 */
export function planManualStart(input: Omit<InitialPlanInput, 'schedule'> & { bracketSize: number | null }): PhasePlan {
  const first = phasesOf(input.system)[0];
  const empty = { rounds: [], matches: [] };
  if (first === PhaseType.KNOCKOUT) return { phase: manualKnockoutPhase(0, input.knockoutLegs, input.bracketSize!, 1), ...empty };
  if (first === PhaseType.GROUPS) {
    const groups = input.groups
      ? input.groups.map((teamIds, g) => ({ key: GROUP_KEYS[g], teamIds }))
      : dealGroups(input.teamIds, input.groupCount!);
    return { phase: { index: 0, type: PhaseType.GROUPS, legs: input.legs, groups }, ...empty };
  }
  return { phase: input.system === CompetitionSystem.LEAGUE ? null : { index: 0, type: PhaseType.LEAGUE, legs: input.legs }, ...empty };
}

/** Tamaños válidos de un cuadro a mano con `teamCount` inscritos (de la final al cuadro que los cubre a todos). */
export function manualBracketSizes(teamCount: number) {
  const out: number[] = [];
  for (let s = 2; s <= Math.min(64, nextPowerOfTwo(teamCount)); s *= 2) out.push(s);
  return out;
}

/** Documento Mongo de un partido planificado. */
export function matchDoc(tournamentId: Types.ObjectId, m: PlannedMatch) {
  return {
    tournamentId,
    round: m.round,
    homeTeamId: new Types.ObjectId(m.homeTeamId),
    awayTeamId: new Types.ObjectId(m.awayTeamId),
    date: m.date,
    time: m.time,
    venue: m.venue,
    status: MatchStatus.SCHEDULED,
    homeScore: null,
    awayScore: null,
    stage: m.stage,
    penalties: null,
  };
}
