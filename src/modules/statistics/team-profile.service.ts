import { Injectable, NotFoundException } from '@nestjs/common';
import { pointsRuleOf } from './calculations.js';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Team } from '../teams/schemas/team.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { TeamRoster } from '../teams/schemas/team-roster.schema.js';
import { CompetitionSystem, MatchStatus, TeamRosterStatus } from '../../common/enums/index.js';
import { toObjectId } from '../../common/utils/serialize.js';
import { publicPlayer, teamRef, tournamentRef } from '../../common/utils/public.js';
import { paginated, PaginationQueryDto, skipFor } from '../../common/dto/pagination.dto.js';
import { buildTeamProfile, teamMatch, type TPMatch, type TPTournament } from './team-profile.js';

const MATCH_FIELDS = 'tournamentId round date time status homeTeamId awayTeamId homeScore awayScore stage penalties';

type LeanMatch = Pick<Match, 'round' | 'date' | 'time' | 'status' | 'homeScore' | 'awayScore' | 'stage' | 'penalties'> & {
  _id: Types.ObjectId;
  tournamentId: Types.ObjectId;
  homeTeamId: Types.ObjectId;
  awayTeamId: Types.ObjectId;
};

function toTPMatch(m: LeanMatch): TPMatch {
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

/**
 * GET /teams/:id/profile y GET /teams/:id/matches. Consultas fijas, sin importar cuántos torneos,
 * jugadores o partidos tenga el equipo (nada de una consulta por torneo, jugador o partido):
 *
 *   fase 1 (en paralelo): equipo · sus inscripciones · torneos donde jugó (distinct) · sus
 *                         participaciones · sus estadísticas oficiales ($lookup a Match FINISHED) ·
 *                         su plantilla global actual (TeamRoster ACTIVE)
 *   fase 2 (en paralelo): esos torneos · todos sus partidos (tablas) · sus inscripciones · jugadores
 *   fase 3:               equipos de esos torneos (nombres de la tabla y de los partidos)
 */
@Injectable()
export class TeamProfileService {
  constructor(
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(TeamRoster.name) private readonly globalRoster: Model<TeamRoster>,
  ) {}

  async profile(id: string) {
    const teamId = toObjectId(id);
    const plays = { $or: [{ homeTeamId: teamId }, { awayTeamId: teamId }] };
    const [team, enrolled, playedIn, memberships, stats, roster] = await Promise.all([
      this.teams.findById(teamId).lean(),
      this.enrollments.find({ teamId }).select('tournamentId').lean(),
      this.matches.distinct('tournamentId', plays) as Promise<Types.ObjectId[]>,
      this.memberships.find({ teamId }).select('playerId tournamentId jerseyNumber startDate active').lean(),
      this.stats.aggregate<{ matchId: Types.ObjectId; playerId: Types.ObjectId; goals: number; assists: number; yellowCards: number; redCards: number; tournamentId: Types.ObjectId }>([
        { $match: { teamId, played: true } },
        { $lookup: { from: 'matches', localField: 'matchId', foreignField: '_id', as: 'match' } },
        { $unwind: '$match' },
        { $match: { 'match.status': MatchStatus.FINISHED, 'match.homeScore': { $ne: null }, 'match.awayScore': { $ne: null } } },
        { $project: { matchId: 1, playerId: 1, goals: 1, assists: 1, yellowCards: 1, redCards: 1, tournamentId: '$match.tournamentId' } },
      ]),
      this.globalRoster.find({ teamId, status: TeamRosterStatus.ACTIVE }).select('playerId joinedAt').lean(),
    ]);
    if (!team) throw new NotFoundException(`Equipo ${id} no encontrado`);

    const tournamentIds = [...new Set([...enrolled.map((e) => e.tournamentId.toHexString()), ...playedIn.map(String)])].map(toObjectId);
    const playerIds = [
      ...new Set([...memberships.map((m) => m.playerId.toHexString()), ...stats.map((s) => s.playerId.toHexString()), ...roster.map((r) => r.playerId.toHexString())]),
    ].map(toObjectId);
    const [tournaments, allMatches, tournamentTeams, players] = await Promise.all([
      this.tournaments.find({ _id: { $in: tournamentIds } }).select('name status category format startDate endDate dataCoverage settings phases').lean(),
      this.matches.find({ tournamentId: { $in: tournamentIds } }).select(MATCH_FIELDS).lean<LeanMatch[]>(),
      this.enrollments.find({ tournamentId: { $in: tournamentIds } }).select('tournamentId teamId').lean(),
      this.players.find({ _id: { $in: playerIds } }).lean(),
    ]);
    const matches = allMatches.map(toTPMatch);
    const teamIds = new Set([...tournamentTeams.map((e) => e.teamId.toHexString()), ...matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]), id]);
    const teamDocs = await this.teams.find({ _id: { $in: [...teamIds].map(toObjectId) } }).select('name shortName logoUrl colors').lean();

    const byTournament = new Map<string, TPMatch[]>();
    for (const m of matches) byTournament.set(m.tournamentId, [...(byTournament.get(m.tournamentId) ?? []), m]);
    const enrolledIn = new Map<string, string[]>();
    for (const e of tournamentTeams) {
      const tid = e.tournamentId.toHexString();
      enrolledIn.set(tid, [...(enrolledIn.get(tid) ?? []), e.teamId.toHexString()]);
    }

    return buildTeamProfile({
      team: { ...teamRef(team), city: team.city ?? null, coverUrl: team.coverUrl ?? null, coverPosition: team.coverPosition ?? { x: 50, y: 50 } },
      tournaments: new Map(
        tournaments.map((t): [string, TPTournament] => [
          t._id.toHexString(),
          {
            ...tournamentRef(t),
            system: t.settings?.system ?? CompetitionSystem.LEAGUE,
            points: pointsRuleOf(t.settings),
            phases: t.phases ?? [],
            playoffTeams: t.settings?.playoffTeams ?? null,
            qualifiersPerGroup: t.settings?.qualifiersPerGroup ?? null,
            knockoutTiebreak: t.settings?.knockoutTiebreak,
            finalTiebreak: t.settings?.finalTiebreak ?? null,
          },
        ]),
      ),
      enrolledTournamentIds: new Set(enrolled.map((e) => e.tournamentId.toHexString())),
      tournamentMatches: byTournament,
      tournamentTeams: enrolledIn,
      stats: stats.map((s) => ({
        matchId: s.matchId.toHexString(),
        tournamentId: s.tournamentId.toHexString(),
        playerId: s.playerId.toHexString(),
        goals: s.goals,
        assists: s.assists,
        yellowCards: s.yellowCards ?? 0,
        redCards: s.redCards ?? 0,
      })),
      memberships: memberships.map((m) => ({
        playerId: m.playerId.toHexString(),
        tournamentId: m.tournamentId.toHexString(),
        jerseyNumber: m.jerseyNumber,
        startDate: m.startDate,
        active: m.active,
      })),
      players: new Map(players.map((p) => [p._id.toHexString(), publicPlayer(p)])),
      teams: new Map(teamDocs.map((t) => [t._id.toHexString(), teamRef(t)])),
      globalRoster: roster.map((r) => ({ playerId: r.playerId.toHexString(), joinedAt: r.joinedAt })),
    });
  }

  /** Partidos oficiales del equipo, más recientes primero, paginados en la base. */
  async matchesPage(id: string, query: PaginationQueryDto) {
    const teamId = toObjectId(id);
    if (!(await this.teams.exists({ _id: teamId }))) throw new NotFoundException(`Equipo ${id} no encontrado`);
    const filter = {
      $or: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
      status: MatchStatus.FINISHED,
      homeScore: { $ne: null },
      awayScore: { $ne: null },
    };
    const [rows, total] = await Promise.all([
      this.matches.find(filter).sort({ date: -1, time: -1, _id: -1 }).skip(skipFor(query)).limit(query.limit).select(MATCH_FIELDS).lean<LeanMatch[]>(),
      this.matches.countDocuments(filter),
    ]);
    const matches = rows.map(toTPMatch);
    const [teamDocs, tournaments] = await Promise.all([
      this.teams.find({ _id: { $in: [...new Set(matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]))].map(toObjectId) } }).select('name shortName logoUrl colors').lean(),
      this.tournaments.find({ _id: { $in: [...new Set(matches.map((m) => m.tournamentId))].map(toObjectId) } }).select('name status category format startDate endDate dataCoverage').lean(),
    ]);
    const teamsById = new Map(teamDocs.map((t) => [t._id.toHexString(), teamRef(t)]));
    const tournamentsById = new Map(tournaments.map((t) => [t._id.toHexString(), tournamentRef(t)]));
    return paginated(matches.map((m) => teamMatch(m, id, tournamentsById, teamsById)), total, query);
  }

}
