/**
 * Resultado oficial de un equipo en un torneo FINALIZADO, derivado de la estructura real del formato
 * (competition/structure.ts): campeón, finalista, fase alcanzada y posición final verificable. Y el
 * goleador del torneo. Funciones puras: las usa el perfil del jugador; nada se guarda.
 *
 * Nunca se deduce de torneos en curso ni se elige por nombre: si la estructura no lo determina, es null.
 */
import { CompetitionSystem, KnockoutTiebreak, MatchStatus, PhaseType } from '../../common/enums/index.js';
import { buildStructure, type StructureView } from '../competition/structure.js';
import { phaseMatches, type StagedMatch } from '../competition/tables.js';
import { computeStandings } from './calculations.js';
import { verifiableFinal, type TPTournament } from './team-profile.js';

export interface CompetitionContext {
  tournament: TPTournament;
  /** Todos los partidos del torneo (tablas, cuadro, pendientes). */
  matches: StagedMatch[];
  /** Equipos inscritos (filas de la tabla). */
  teamIds: string[];
}

export interface TeamOutcome {
  champion: boolean;
  runnerUp: boolean;
  /** Formatos con eliminatoria: "Final", "Semifinal"…, o "Fase de grupos" / "Fase regular" si no entró al cuadro. */
  reached: string | null;
  /** Solo liga clásica, con la regla verificable del perfil del equipo. */
  finalPosition: { position: number; teams: number } | null;
}

export function structureOf(ctx: CompetitionContext, nameOf: (id: string) => string): StructureView {
  const t = ctx.tournament;
  return buildStructure({
    system: t.system as CompetitionSystem,
    points: t.points,
    playoffTeams: t.playoffTeams ?? null,
    qualifiersPerGroup: t.qualifiersPerGroup ?? null,
    knockoutTiebreak: t.knockoutTiebreak ?? KnockoutTiebreak.PENALTIES,
    finalTiebreak: t.finalTiebreak ?? null,
    phases: t.phases ?? [],
    matches: ctx.matches,
    teamIds: ctx.teamIds,
    nameOf,
  });
}

/** null si el torneo no terminó: un resultado parcial no es un resultado oficial. */
export function teamOutcome(teamId: string, ctx: CompetitionContext, structure: StructureView, nameOf: (id: string) => string): TeamOutcome | null {
  if (ctx.tournament.status !== 'FINISHED') return null;
  const champion = structure.championTeamId === teamId;
  if (ctx.tournament.system === CompetitionSystem.LEAGUE) {
    const hasResults = ctx.matches.some((m) => m.status === MatchStatus.FINISHED);
    const rows = hasResults ? computeStandings(ctx.teamIds, phaseMatches(ctx.matches, 0), nameOf, ctx.tournament.points) : [];
    const final = hasResults ? verifiableFinal(teamId, ctx.tournament, ctx.matches, rows) : null;
    return { champion, runnerUp: false, reached: null, finalPosition: final ? { position: final.position, teams: final.teams } : null };
  }
  const ko = structure.phases.find((p) => p.type === PhaseType.KNOCKOUT);
  let reached: string | null = null;
  let runnerUp = false;
  if (ko?.type === PhaseType.KNOCKOUT && ko.generated) {
    const inTie = (t: { homeTeamId: string | null; awayTeamId: string | null }) => t.homeTeamId === teamId || t.awayTeamId === teamId;
    const last = [...ko.rounds].reverse().find((r) => r.ties.some(inTie));
    if (last) reached = champion ? 'Campeón' : last.name;
    const final = ko.rounds.at(-1)?.ties[0];
    runnerUp = !!final?.winnerTeamId && final.winnerTeamId !== teamId && inTie(final);
  }
  if (!reached) {
    const first = structure.phases[0];
    if (first?.type === PhaseType.GROUPS && first.groups.some((g) => g.teamIds.includes(teamId))) reached = 'Fase de grupos';
    else if (first?.type === PhaseType.LEAGUE && ctx.teamIds.includes(teamId)) reached = 'Fase regular';
  }
  return { champion, runnerUp, reached, finalPosition: null };
}

/**
 * Goleador de un torneo FINALIZADO: máximo de goles oficiales (> 0). `goalsByPlayer` = goles de
 * PlayerMatchStats played=true en partidos FINISHED del torneo. Empate en el máximo → compartido.
 */
export function topScorerOf(playerId: string, goalsByPlayer: Map<string, number> | undefined): { goals: number; shared: boolean } | null {
  if (!goalsByPlayer) return null;
  const max = Math.max(0, ...goalsByPlayer.values());
  const own = goalsByPlayer.get(playerId) ?? 0;
  if (max === 0 || own !== max) return null;
  return { goals: own, shared: [...goalsByPlayer.values()].filter((g) => g === max).length > 1 };
}
