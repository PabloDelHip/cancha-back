/**
 * Estado derivado de la estructura de un torneo: tablas por fase y grupo, clasificados, bracket y
 * campeón oficial. Función pura: la usan la lectura pública (GET /tournaments/:id/structure), el
 * avance de fase, el cierre del torneo y los honors del perfil del equipo, así que todos ven lo mismo.
 */
import { CompetitionSystem, KnockoutTiebreak, PhaseType } from '../../common/enums/index.js';
import type { PointsRule, StandingRow } from '../statistics/calculations.js';
import { bracketSize, phaseRounds, reconcile, roundName, type TieState, type TiebreakRules } from './bracket.js';
import { phasesOf } from './formats.js';
import { groupMatches, leagueTable, pendingOf, phaseMatches, rankTable, roundRobinComplete, type StagedMatch } from './tables.js';
import type { KnockoutSeed, TiebreakDecision, TournamentPhase } from './types.js';

export interface StructureInput {
  system: CompetitionSystem;
  points: PointsRule;
  playoffTeams: number | null;
  qualifiersPerGroup: number | null;
  /** Llave igualada: regla general y la de la final (null = la misma). */
  knockoutTiebreak: KnockoutTiebreak;
  finalTiebreak: KnockoutTiebreak | null;
  phases: TournamentPhase[];
  matches: StagedMatch[];
  /** Equipos inscritos (filas de la liga). */
  teamIds: string[];
  nameOf: (teamId: string) => string;
}

export interface Qualification {
  /** Cuántos pasan desde esta tabla. */
  count: number;
  /** Clasificados en orden (solo si la fase terminó y no hay empates sin resolver). */
  teamIds: string[] | null;
  unresolved: { teamIds: string[]; positions: [number, number] }[];
}

export type PhaseView =
  | { index: number; type: PhaseType.LEAGUE; generated: boolean; complete: boolean; pending: number; table: StandingRow[]; qualification: Qualification | null }
  | {
      index: number;
      type: PhaseType.GROUPS;
      generated: boolean;
      complete: boolean;
      pending: number;
      groups: { key: string; teamIds: string[]; table: StandingRow[]; qualification: Qualification }[];
    }
  | {
      index: number;
      type: PhaseType.KNOCKOUT;
      generated: boolean;
      /** Cuadro armado a mano por el organizador. */
      manual: boolean;
      /** Reacomodo: tras la primera ronda, el mejor sembrado vivo enfrenta al peor. */
      reseed: boolean;
      complete: boolean;
      legs: 1 | 2;
      seeds: KnockoutSeed[];
      rounds: { round: number; name: string; ties: TieState[] }[];
      championTeamId: string | null;
    };

export interface StructureView {
  system: CompetitionSystem;
  phases: PhaseView[];
  /** Fase siguiente por generar (liga/grupos → eliminatoria) y qué la bloquea. */
  next: { index: number; type: PhaseType; ready: boolean; blockers: string[]; seeds: KnockoutSeed[] | null } | null;
  /** Campeón según el resultado real del formato (no implica torneo finalizado). */
  championTeamId: string | null;
}

function qualify(rows: StandingRow[], count: number, complete: boolean, decisions: TiebreakDecision[], scope: string): Qualification {
  const ranked = rankTable(rows, count, decisions, scope);
  return {
    count,
    teamIds: complete && !ranked.unresolved.length ? ranked.rows.slice(0, count).map((r) => r.teamId) : null,
    unresolved: ranked.unresolved,
  };
}

/**
 * Reglas de desempate de las eliminatorias. Para BETTER_POSITION, la posición de cada equipo es la
 * de la tabla de la fase regular (LEAGUE_PLAYOFFS) con los desempates del organizador aplicados:
 * vale igual para un cuadro automático que para uno armado a mano.
 */
export function tiebreakRules(input: StructureInput): TiebreakRules {
  const rules: TiebreakRules = { tiebreak: input.knockoutTiebreak, finalTiebreak: input.finalTiebreak };
  const usesPosition = [input.knockoutTiebreak, input.finalTiebreak].includes(KnockoutTiebreak.BETTER_POSITION);
  if (!usesPosition || input.system !== CompetitionSystem.LEAGUE_PLAYOFFS) return rules;
  const table = leagueTable(input.teamIds, phaseMatches(input.matches, 0), input.nameOf, input.points);
  const stored = input.phases.find((p) => p.index === 0);
  const ranked = rankTable(table, table.length, stored?.tiebreaks ?? [], 'LEAGUE');
  // Empate deportivo sin decidir: esos equipos comparten posición (la llave irá a penales).
  const unresolved = new Map(ranked.unresolved.flatMap((u) => u.teamIds.map((id) => [id, u.positions[0]] as const)));
  rules.rank = new Map(ranked.rows.map((r) => [r.teamId, unresolved.get(r.teamId) ?? r.position]));
  return rules;
}

export function buildStructure(input: StructureInput): StructureView {
  const plan = phasesOf(input.system);
  const phases: PhaseView[] = [];

  // Liga clásica (V1): sin fases guardadas, todos sus partidos son la fase 0.
  if (input.system === CompetitionSystem.LEAGUE) {
    const matches = phaseMatches(input.matches, 0);
    const table = leagueTable(input.teamIds, matches, input.nameOf, input.points);
    const complete = roundRobinComplete(matches);
    const top = rankTable(table, 1);
    phases.push({ index: 0, type: PhaseType.LEAGUE, generated: matches.length > 0, complete, pending: pendingOf(matches), table, qualification: null });
    return {
      system: input.system,
      phases,
      next: null,
      // Líder verificable: liga completa y primer lugar sin empate deportivo.
      championTeamId: complete && table.length && !top.unresolved.length ? table[0].teamId : null,
    };
  }

  let seedsForNext: KnockoutSeed[] | null = null;
  let blockers: string[] = [];
  for (let i = 0; i < plan.length; i++) {
    const stored = input.phases.find((p) => p.index === i);
    const type = plan[i];
    const matches = phaseMatches(input.matches, i);
    if (type === PhaseType.LEAGUE) {
      const table = leagueTable(input.teamIds, matches, input.nameOf, input.points);
      const complete = !!stored && roundRobinComplete(matches);
      const count = input.playoffTeams ?? 0;
      const qualification = qualify(table, count, complete, stored?.tiebreaks ?? [], 'LEAGUE');
      phases.push({ index: i, type, generated: !!stored, complete, pending: pendingOf(matches), table, qualification });
      seedsForNext = qualification.teamIds?.map((teamId, k) => ({ seed: k + 1, teamId, origin: `${k + 1}º fase regular` })) ?? null;
      blockers = !stored ? ['La fase regular aún no se genera'] : !complete ? [`Faltan ${pendingOf(matches)} partidos de la fase regular`] : unresolvedMsg(qualification.unresolved, 'la tabla');
    } else if (type === PhaseType.GROUPS) {
      const complete = !!stored && roundRobinComplete(matches);
      const q = input.qualifiersPerGroup ?? 0;
      const groups = (stored?.groups ?? []).map((g) => {
        const table = leagueTable(g.teamIds, groupMatches(input.matches, i, g.key), input.nameOf, input.points);
        return { key: g.key, teamIds: g.teamIds, table, qualification: qualify(table, q, complete, stored?.tiebreaks ?? [], g.key) };
      });
      phases.push({ index: i, type, generated: !!stored, complete, pending: pendingOf(matches), groups });
      // Cabezas de serie: primero todos los 1º (A, B, C…), luego todos los 2º… → con el orden estándar
      // del cuadro, un primero cruza con un segundo de otro grupo.
      const ok = groups.every((g) => g.qualification.teamIds);
      seedsForNext = ok && groups.length
        ? Array.from({ length: q }, (_, pos) => groups.map((g) => ({ teamId: g.qualification.teamIds![pos], origin: `${g.key}${pos + 1}` }))).flat().map((s, k) => ({ seed: k + 1, ...s }))
        : null;
      blockers = !stored
        ? ['La fase de grupos aún no se genera']
        : !complete
          ? [`Faltan ${pendingOf(matches)} partidos de la fase de grupos`]
          : groups.flatMap((g) => unresolvedMsg(g.qualification.unresolved, `el grupo ${g.key}`));
    } else {
      if (!stored) {
        phases.push({ index: i, type, generated: false, manual: false, reseed: false, complete: false, legs: 1, seeds: seedsForNext ?? [], rounds: [], championTeamId: null });
        return {
          system: input.system,
          phases,
          next: { index: i, type, ready: blockers.length === 0 && !!seedsForNext, blockers, seeds: seedsForNext },
          championTeamId: null,
        };
      }
      const state = reconcile(stored, input.matches, tiebreakRules(input));
      const size = bracketSize(stored);
      const rounds = Array.from({ length: phaseRounds(stored) }, (_, r) => ({
        round: r,
        name: roundName(size / 2 ** r),
        ties: state.ties.filter((t) => t.round === r),
      }));
      phases.push({ index: i, type, generated: true, manual: !!stored.manual, reseed: !!stored.reseed, complete: state.complete, legs: stored.legs, seeds: stored.seeds ?? [], rounds, championTeamId: state.championTeamId });
    }
  }
  const last = phases.at(-1);
  return {
    system: input.system,
    phases,
    next: null,
    championTeamId: last?.type === PhaseType.KNOCKOUT ? last.championTeamId : null,
  };
}

function unresolvedMsg(list: Qualification['unresolved'], where: string) {
  return list.map(
    (u) => `Empate sin criterio deportivo en ${where} (posiciones ${u.positions[0]}–${u.positions[1]}): el organizador debe decidir el orden`,
  );
}
