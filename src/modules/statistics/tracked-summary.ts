/**
 * Resumen público de los equipos EN SEGUIMIENTO de un torneo PARTIAL (6G,
 * GET /tournaments/:id/tracked-summary). Función pura: recibe lo leído en consultas fijas y arma
 * una tarjeta por equipo seguido, SOLO con sus partidos en ESTE torneo. Reutiliza las reglas del
 * Team Profile (recordOf, resultFor, teamMatch, rankContributors): no hay cálculos paralelos.
 *
 * No es una clasificación: no hay posiciones, puntos ni orden deportivo (se ordena por nombre).
 */
import type { PublicPlayer, TeamRef, TournamentRef } from '../../common/utils/public.js';
import { rankContributors, recordOf, resultFor, teamMatch, type TeamRecord, type TPMatch, type TPStat } from './team-profile.js';
import { MatchStatus } from '../../common/enums/index.js';

const FORM_LENGTH = 5;

export interface TrackedSummaryInput {
  tournament: TournamentRef;
  trackedTeamIds: string[];
  /** Partidos del torneo donde juega al menos un equipo seguido. */
  matches: TPMatch[];
  /** PlayerMatchStats oficiales (played, partido FINISHED) de los equipos seguidos, con su equipo. */
  stats: (Pick<TPStat, 'playerId' | 'goals' | 'assists'> & { teamId: string })[];
  teams: Map<string, TeamRef>;
  players: Map<string, PublicPlayer>;
  /** Jugadores con participación activa en ESTE torneo, por equipo (plantilla del torneo). */
  squadSizes: Map<string, number>;
}

type Played = TPMatch & { homeScore: number; awayScore: number };
const isPlayed = (m: TPMatch): m is Played => m.status === MatchStatus.FINISHED && m.homeScore !== null && m.awayScore !== null;
const byKickoff = (a: TPMatch, b: TPMatch) => `${a.date}${a.time}${a.id}`.localeCompare(`${b.date}${b.time}${b.id}`);

export function buildTrackedSummary(input: TrackedSummaryInput) {
  const tournaments = new Map([[input.tournament.id, input.tournament]]);
  const trackedTeams = input.trackedTeamIds
    .filter((id) => input.teams.has(id))
    .map((id) => {
      const own = input.matches.filter((m) => m.homeTeamId === id || m.awayTeamId === id).sort(byKickoff);
      const played = own.filter(isPlayed);
      const stats = input.stats.filter((s) => s.teamId === id);
      const record: TeamRecord = recordOf(id, own);
      const last = played.at(-1);
      const next = own.find((m) => m.status === MatchStatus.SCHEDULED || m.status === MatchStatus.LIVE);
      const [topScorer] = rankContributors(stats, input.players, 'goals', 1);
      const [topAssist] = rankContributors(stats, input.players, 'assists', 1);
      return {
        team: input.teams.get(id)!,
        /** Partidos registrados en Cancha (no una campaña completa): 0 = aún sin partidos. */
        record,
        form: played.slice(-FORM_LENGTH).map((m) => resultFor(m, id)),
        lastMatch: last ? teamMatch(last, id, tournaments, input.teams) : null,
        nextMatch: next ? teamMatch(next, id, tournaments, input.teams) : null,
        topScorer: topScorer ? { player: topScorer.player, goals: topScorer.goals } : null,
        topAssist: topAssist ? { player: topAssist.player, assists: topAssist.assists } : null,
        squadSize: input.squadSizes.get(id) ?? 0,
      };
    })
    .sort((a, b) => a.team.name.localeCompare(b.team.name) || a.team.id.localeCompare(b.team.id));
  return { tournamentId: input.tournament.id, dataCoverage: input.tournament.dataCoverage ?? 'FULL', trackedTeams };
}

export type TrackedSummary = ReturnType<typeof buildTrackedSummary>;
