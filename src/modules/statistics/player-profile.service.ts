import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, type PipelineStage } from 'mongoose';
import { Player } from '../players/schemas/player.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { CompetitionSystem, MatchStatus } from '../../common/enums/index.js';
import { toObjectId } from '../../common/utils/serialize.js';
import { publicPlayer, teamRef, tournamentRef } from '../../common/utils/public.js';
import { buildPlayerProfile, type ProfileEntry } from './player-profile.js';
import { pointsRuleOf } from './calculations.js';
import type { CompetitionContext } from './competition-outcome.js';
import type { StagedMatch } from '../competition/tables.js';

const MATCH_FIELDS = 'tournamentId round date time status homeTeamId awayTeamId homeScore awayScore stage penalties';
type LeanMatch = Pick<Match, 'round' | 'date' | 'time' | 'status' | 'homeScore' | 'awayScore' | 'stage' | 'penalties'> & {
  _id: Types.ObjectId;
  tournamentId: Types.ObjectId;
  homeTeamId: Types.ObjectId;
  awayTeamId: Types.ObjectId;
};

/** Fila del `$lookup` PlayerMatchStats ⋈ Match. */
export interface StatWithMatch {
  _id: Types.ObjectId;
  matchId: Types.ObjectId;
  playerId: Types.ObjectId;
  teamId: Types.ObjectId;
  played: boolean;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
  match: Match & { _id: Types.ObjectId };
}

/**
 * Partidos oficiales de un jugador, del más reciente al más antiguo: sus PlayerMatchStats
 * (índice playerId) unidos a su Match por _id, solo FINISHED y played = true. Una sola consulta,
 * sin importar cuántos partidos tenga. `page` pagina en la base ($facet con el total).
 */
export function officialMatchesPipeline(playerId: string, page?: { skip: number; limit: number }) {
  const pipeline: PipelineStage[] = [
    { $match: { playerId: toObjectId(playerId), played: true } },
    { $lookup: { from: 'matches', localField: 'matchId', foreignField: '_id', as: 'match' } },
    { $unwind: '$match' },
    { $match: { 'match.status': MatchStatus.FINISHED, 'match.homeScore': { $ne: null }, 'match.awayScore': { $ne: null } } },
    { $sort: { 'match.date': -1, 'match.time': -1, 'match._id': -1 } },
  ];
  if (page) {
    pipeline.push({
      $facet: { rows: [{ $skip: page.skip }, { $limit: page.limit }], total: [{ $count: 'n' }] },
    });
  }
  return pipeline;
}

export function toProfileEntry(row: StatWithMatch): ProfileEntry {
  return {
    matchId: row.match._id.toHexString(),
    tournamentId: row.match.tournamentId.toHexString(),
    round: row.match.round,
    date: row.match.date,
    time: row.match.time,
    homeTeamId: row.match.homeTeamId.toHexString(),
    awayTeamId: row.match.awayTeamId.toHexString(),
    homeScore: row.match.homeScore!,
    awayScore: row.match.awayScore!,
    teamId: row.teamId.toHexString(),
    goals: row.goals,
    assists: row.assists,
    yellowCards: row.yellowCards,
    redCards: row.redCards,
  };
}

/**
 * GET /players/:id/profile. Consultas fijas, independientes del tamaño del historial (sin N+1):
 *   fase 1 (paralelo): jugador · sus partidos oficiales ($lookup) · sus participaciones
 *   fase 2 (paralelo): sus torneos (con formato y fases) · todos los partidos de esos torneos ·
 *                      sus inscritos
 *   fase 3 (paralelo): equipos (de sus partidos y de esos torneos) · goleadores de los torneos
 *                      finalizados (solo filas con gol)
 * El coste crece con el tamaño de SUS torneos, no con la plataforma (como el perfil del equipo).
 */
@Injectable()
export class PlayerProfileService {
  constructor(
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
  ) {}

  async profile(playerId: string) {
    const [player, rows, memberships] = await Promise.all([
      this.players.findById(playerId).lean(),
      this.stats.aggregate<StatWithMatch>(officialMatchesPipeline(playerId)),
      this.memberships
        .find({ playerId: toObjectId(playerId) })
        .select('tournamentId teamId jerseyNumber startDate endDate active')
        .lean(),
    ]);
    if (!player) throw new NotFoundException(`Jugador ${playerId} no encontrado`);
    const entries = rows.map(toProfileEntry);

    const tournamentIds = [...new Set([...memberships.map((m) => m.tournamentId.toHexString()), ...entries.map((e) => e.tournamentId)])].map(toObjectId);
    const [tournaments, allMatches, enrolled] = await Promise.all([
      this.tournaments
        .find({ _id: { $in: tournamentIds } })
        .select('name status category format startDate endDate dataCoverage settings phases')
        .lean(),
      this.matches.find({ tournamentId: { $in: tournamentIds } }).select(MATCH_FIELDS).lean<LeanMatch[]>(),
      this.enrollments.find({ tournamentId: { $in: tournamentIds } }).select('tournamentId teamId').lean(),
    ]);
    const matches = allMatches.map(toStaged);
    const finishedTournaments = new Set(tournaments.filter((t) => t.status === 'FINISHED').map((t) => t._id.toHexString()));
    const finishedMatchIds = allMatches
      .filter((m) => finishedTournaments.has(m.tournamentId.toHexString()) && m.status === MatchStatus.FINISHED && m.homeScore !== null && m.awayScore !== null)
      .map((m) => m._id);
    const teamIds = new Set([
      ...memberships.map((m) => m.teamId.toHexString()),
      ...enrolled.map((e) => e.teamId.toHexString()),
      ...matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]),
      ...entries.map((e) => e.teamId),
    ]);
    const [teams, scorers] = await Promise.all([
      this.teams
        .find({ _id: { $in: [...teamIds].map(toObjectId) } })
        .select('name shortName logoUrl colors')
        .lean(),
      finishedMatchIds.length
        ? this.stats.find({ matchId: { $in: finishedMatchIds }, played: true, goals: { $gt: 0 } }).select('matchId playerId goals').lean()
        : Promise.resolve([]),
    ]);

    // Goles oficiales por jugador en cada torneo finalizado (goleador del torneo).
    const tournamentOf = new Map(allMatches.map((m) => [m._id.toHexString(), m.tournamentId.toHexString()]));
    const tournamentGoals = new Map<string, Map<string, number>>();
    for (const s of scorers) {
      const tid = tournamentOf.get(s.matchId.toHexString())!;
      const byPlayer = tournamentGoals.get(tid) ?? new Map<string, number>();
      tournamentGoals.set(tid, byPlayer);
      byPlayer.set(s.playerId.toHexString(), (byPlayer.get(s.playerId.toHexString()) ?? 0) + s.goals);
    }
    const byTournament = new Map<string, StagedMatch[]>();
    for (const m of matches) byTournament.set(m.tournamentId, [...(byTournament.get(m.tournamentId) ?? []), m]);
    const teamsIn = new Map<string, string[]>();
    for (const e of enrolled) {
      const tid = e.tournamentId.toHexString();
      teamsIn.set(tid, [...(teamsIn.get(tid) ?? []), e.teamId.toHexString()]);
    }
    const competitionContexts = new Map<string, CompetitionContext>(
      tournaments.map((t) => {
        const id = t._id.toHexString();
        return [
          id,
          {
            tournament: {
              ...tournamentRef(t),
              system: t.settings?.system ?? CompetitionSystem.LEAGUE,
              points: pointsRuleOf(t.settings),
              phases: t.phases ?? [],
              playoffTeams: t.settings?.playoffTeams ?? null,
              qualifiersPerGroup: t.settings?.qualifiersPerGroup ?? null,
              knockoutTiebreak: t.settings?.knockoutTiebreak,
              finalTiebreak: t.settings?.finalTiebreak ?? null,
            },
            matches: byTournament.get(id) ?? [],
            teamIds: teamsIn.get(id) ?? [],
          },
        ];
      }),
    );

    return buildPlayerProfile({
      player: publicPlayer(player),
      entries,
      memberships: memberships.map((m) => ({
        tournamentId: m.tournamentId.toHexString(),
        teamId: m.teamId.toHexString(),
        jerseyNumber: m.jerseyNumber,
        startDate: m.startDate,
        endDate: m.endDate,
        active: m.active,
      })),
      tournaments: new Map(tournaments.map((t) => [t._id.toHexString(), tournamentRef(t)])),
      teams: new Map(teams.map((t) => [t._id.toHexString(), teamRef(t)])),
      competitionContexts,
      tournamentGoals,
    });
  }
}

function toStaged(m: LeanMatch): StagedMatch {
  return {
    id: m._id.toHexString(),
    tournamentId: m.tournamentId.toHexString(),
    round: m.round,
    date: m.date,
    time: m.time,
    status: m.status,
    homeTeamId: m.homeTeamId.toHexString(),
    awayTeamId: m.awayTeamId.toHexString(),
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    stage: m.stage ?? null,
    penalties: m.penalties ?? null,
  };
}
