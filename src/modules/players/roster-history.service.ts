import { withPlayerName, withTeamName, type HistoricalNames } from '../../common/history/identity.js';
import { TournamentIdentityService } from '../../common/history/tournament-identity.service.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TeamMembership } from './schemas/team-membership.schema.js';
import { PlayerBlock } from './schemas/player-block.schema.js';
import { Player } from './schemas/player.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { RemovedEnrollment } from '../tournaments/schemas/removed-enrollment.schema.js';
import { MatchLog } from '../match-log/schemas/match-log.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { MatchLogAction } from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import { toObjectId } from '../../common/utils/serialize.js';
import { assignBlockTeams, deriveHistory, filterHistory, sortHistory, type HistorySources, type MembershipRecord } from './roster-history.js';
import type { RosterHistoryQueryDto } from './dto/player.dto.js';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * 3E — GET /tournaments/:id/roster-history: altas, cambios de equipo (y sus anulaciones), bajas,
 * reincorporaciones, excepciones, dorsales, bloqueos y retiros de equipos del torneo. Solo
 * propietario y administradores (permiso TEAMS): los motivos pueden ser sensibles. También con el
 * torneo finalizado. Solo lectura y siempre acotado al torneo: nada de otros torneos entra.
 */
@Injectable()
export class RosterHistoryService {
  constructor(
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(PlayerBlock.name) private readonly blocks: Model<PlayerBlock>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(RemovedEnrollment.name) private readonly removed: Model<RemovedEnrollment>,
    @InjectModel(MatchLog.name) private readonly logs: Model<MatchLog>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly ownership: OwnershipService,
    private readonly identity: TournamentIdentityService,
  ) {}

  async list(tournamentId: string, query: RosterHistoryQueryDto, user: AuthUser) {
    await this.ownership.ownedTournament(tournamentId, user, Permission.TEAMS);
    const tid = toObjectId(tournamentId);
    // El filtro por jugador se aplica ya en la consulta (todas sus participaciones: hacen falta
    // para distinguir una reincorporación). El de equipo no: un cambio involucra a dos equipos.
    const byPlayer = query.playerId ? { playerId: toObjectId(query.playerId) } : {};
    const [memberships, blocks, enrollments, removed, overrides] = await Promise.all([
      this.memberships.find({ tournamentId: tid, ...byPlayer }).select('playerId teamId startDate endDate active endReason audit').lean(),
      this.blocks.find({ tournamentId: tid, ...byPlayer }).lean(),
      query.playerId ? [] : this.enrollments.find({ tournamentId: tid, 'audit.0': { $exists: true } }).select('teamId audit').lean(),
      this.removed.find({ tournamentId: tid }).lean(),
      this.logs.find({ tournamentId: tid, action: MatchLogAction.ELIGIBILITY_OVERRIDE }).select('matchId actorId actorRole reason createdAt changes').lean(),
    ]);
    const archived = removed.map((r) => ({
      ...r,
      memberships: (r.memberships as unknown as MembershipRecord[]).filter((m) => !query.playerId || String(m.playerId) === query.playerId),
    }));
    const sources = { memberships, blocks, enrollments, removed: archived, overrides } as unknown as HistorySources;
    const events = deriveHistory(sources);
    // Un bloqueo es del jugador en el torneo: se muestra (y se filtra) con el equipo en que estaba.
    assignBlockTeams(events, [...sources.memberships, ...sources.removed.flatMap((r) => r.memberships)]);
    const shown = sortHistory(filterHistory(events, { playerId: query.playerId, teamId: query.teamId, actions: query.action, from: query.from, to: query.to }));
    const page = shown.slice(skipFor(query), skipFor(query) + query.limit);
    return { ...paginated(page, shown.length, query), refs: await this.refs(page, await this.identity.names(tid)) };
  }

  /** Nombres que cita la página (jugadores, equipos y autores). Sin datos personales extra. */
  private async refs(page: ReturnType<typeof deriveHistory>, hist: HistoricalNames | null) {
    const ids = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))].map(toObjectId);
    const [players, teams, users] = await Promise.all([
      this.players.find({ _id: { $in: ids(page.map((e) => e.playerId)) } }).select('firstName lastName').lean(),
      this.teams.find({ _id: { $in: ids(page.flatMap((e) => [e.teamId, e.fromTeamId])) } }).select('name').lean(),
      this.users.find({ _id: { $in: ids(page.map((e) => e.by?.userId)) } }).select('firstName lastName').lean(),
    ]);
    return {
      // 10C: en un torneo finalizado, los nombres con que se jugó (los autores son usuarios: actuales).
      players: Object.fromEntries(players.map((p) => ((n) => [p._id.toHexString(), `${n.firstName} ${n.lastName}`.trim()])(withPlayerName(p, p._id.toHexString(), hist)))),
      teams: Object.fromEntries(teams.map((t) => [t._id.toHexString(), withTeamName({ name: t.name }, t._id.toHexString(), hist).name])),
      users: Object.fromEntries(users.map((u) => [u._id.toHexString(), `${u.firstName} ${u.lastName}`.trim()])),
    };
  }
}
