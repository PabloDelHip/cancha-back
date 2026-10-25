import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { TournamentStatus } from '../enums/index.js';
import { toObjectId } from '../utils/serialize.js';
import { Permission } from '../authorization/permissions.js';
import { OwnershipService } from '../authorization/ownership.service.js';
import { TournamentAccessService } from '../authorization/tournament-access.service.js';
import { Tournament } from '../../modules/tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../../modules/tournaments/schemas/tournament-team.schema.js';
import type { TournamentIdentity } from '../../modules/tournaments/schemas/tournament-identity.schema.js';
import { Team } from '../../modules/teams/schemas/team.schema.js';
import { Player } from '../../modules/players/schemas/player.schema.js';
import { TeamMembership } from '../../modules/players/schemas/team-membership.schema.js';
import { Match } from '../../modules/matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../../modules/matches/schemas/player-match-stats.schema.js';
import { League } from '../../modules/leagues/schemas/league.schema.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';
import { namesOf, type HistoricalNames } from './identity.js';

export interface IdentityCorrectionInput {
  kind: 'TEAM' | 'PLAYER' | 'LEAGUE';
  refId?: string | null;
  name?: string;
  shortName?: string;
  firstName?: string;
  lastName?: string;
  nickname?: string | null;
  reason: string;
}

/**
 * 10C — foto de identidad de los torneos finalizados (ver tournament-identity.schema.ts).
 * - `capture`: dentro de la transacción del cierre (mismo cerrojo); qué equipos (inscritos o con
 *   partidos), qué jugadores (con participación en el torneo o con estadísticas) y la liga.
 * - `names` / `namesFor`: lo que leen las consultas para sobreponer los nombres históricos.
 *   null = sin foto (en curso, borrador o finalizado antes de 10C): nombres actuales.
 * - `correct`: única forma de cambiar un nombre histórico, explícita y auditada.
 */
@Injectable()
export class TournamentIdentityService {
  constructor(
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(League.name) private readonly leagues: Model<League>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
  ) {}

  /** Arma la foto con los nombres de hoy. Solo lee: quien la guarda es el cierre (misma sesión). */
  async build(tournamentId: string | Types.ObjectId, session: ClientSession | null = null): Promise<TournamentIdentity> {
    const tid = toObjectId(tournamentId);
    const [t, enrolled, matches, members] = await Promise.all([
      this.tournaments.findById(tid).select('leagueId').session(session).lean(),
      this.enrollments.find({ tournamentId: tid }).select('teamId').session(session).lean(),
      this.matches.find({ tournamentId: tid }).select('_id homeTeamId awayTeamId').session(session).lean(),
      this.memberships.find({ tournamentId: tid }).select('playerId').session(session).lean(),
    ]);
    if (!t) throw new NotFoundException(`Torneo ${String(tournamentId)} no encontrado`);
    const statPlayers = matches.length ? await this.stats.distinct('playerId', { matchId: { $in: matches.map((m) => m._id) } }).session(session) : [];
    const teamIds = [...new Set([...enrolled.map((e) => e.teamId.toHexString()), ...matches.flatMap((m) => [m.homeTeamId.toHexString(), m.awayTeamId.toHexString()])])];
    const playerIds = [...new Set([...members.map((m) => m.playerId.toHexString()), ...statPlayers.map(String)])];
    const [teams, players, league] = await Promise.all([
      this.teams.find({ _id: { $in: teamIds.map(toObjectId) } }).select('name shortName logoUrl colors').session(session).lean(),
      this.players.find({ _id: { $in: playerIds.map(toObjectId) } }).select('firstName lastName nickname').session(session).lean(),
      t.leagueId ? this.leagues.findById(t.leagueId).select('name').session(session).lean() : Promise.resolve(null),
    ]);
    return {
      takenAt: new Date(),
      leagueName: league?.name ?? null,
      teams: teams.map((x) => ({ teamId: x._id, name: x.name, shortName: x.shortName, logoUrl: x.logoUrl ?? null, colors: { primary: x.colors.primary, secondary: x.colors.secondary } })),
      players: players.map((x) => ({ playerId: x._id, firstName: x.firstName, lastName: x.lastName, nickname: x.nickname ?? null })),
      corrections: [],
    };
  }

  /** Nombres históricos de un torneo (null si no está finalizado o no tiene foto). */
  async names(tournamentId: string | Types.ObjectId, session: ClientSession | null = null): Promise<HistoricalNames | null> {
    const t = await this.tournaments.findById(tournamentId).select('status +identity').session(session).lean();
    return t?.status === TournamentStatus.FINISHED ? namesOf(t.identity) : null;
  }

  /** Igual que `names` para varios torneos (historial de liga, perfiles): una sola consulta. */
  async namesFor(ids: (string | Types.ObjectId)[]): Promise<Map<string, HistoricalNames>> {
    const unique = [...new Set(ids.map(String))];
    if (!unique.length) return new Map();
    const rows = await this.tournaments.find({ _id: { $in: unique.map(toObjectId) }, status: TournamentStatus.FINISHED, identity: { $ne: null } }).select('+identity').lean();
    return new Map(rows.flatMap((t) => ((n) => (n ? [[t._id.toHexString(), n] as const] : []))(namesOf(t.identity))));
  }

  /**
   * GET /tournaments/:id/identity — los nombres con que se jugó (solo nombres deportivos, los
   * mismos que ya publican las plantillas). `historical: false` en un finalizado = nombres actuales.
   */
  async publicView(tournamentId: string, viewer: AuthUser | null) {
    await this.access.assertVisible(tournamentId, viewer);
    const t = await this.tournaments.findById(tournamentId).select('status +identity').lean();
    if (!t) throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);
    const identity = t.status === TournamentStatus.FINISHED ? t.identity : null;
    return {
      tournamentId,
      status: t.status,
      historical: !!identity,
      takenAt: identity?.takenAt ?? null,
      leagueName: identity?.leagueName ?? null,
      corrections: identity?.corrections?.length ?? 0,
      teams: (identity?.teams ?? []).map((x) => ({ id: x.teamId.toHexString(), name: x.name, shortName: x.shortName, logoUrl: x.logoUrl ?? null, colors: { primary: x.colors.primary, secondary: x.colors.secondary } })),
      players: (identity?.players ?? []).map((x) => ({ id: x.playerId.toHexString(), firstName: x.firstName, lastName: x.lastName, nickname: x.nickname ?? null })),
    };
  }

  /**
   * POST /tournaments/:id/identity/corrections — corrige un nombre histórico (p. ej. una errata del
   * nombre del equipo tal como se jugó). Quien puede finalizar (LIFECYCLE), con motivo, en el cerrojo
   * del torneo y con auditoría (antes, después, quién, rol, cuándo). Renombrar un equipo o un jugador
   * en su ficha NO pasa por aquí: no toca los torneos finalizados.
   */
  async correct(tournamentId: string, input: IdentityCorrectionInput, user: AuthUser) {
    return this.ownership.inAnyTournament(tournamentId, { user, permission: Permission.LIFECYCLE }, async (session) => {
      const t = await this.tournaments.findById(tournamentId).select('status +identity').session(session).lean();
      if (t?.status !== TournamentStatus.FINISHED) throw new ConflictException('Solo se corrigen nombres históricos de torneos finalizados');
      if (!t.identity) throw new ConflictException('Este torneo se finalizó antes de conservar nombres históricos: muestra los nombres actuales');
      const identity = t.identity;
      const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => (input as unknown as Record<string, unknown>)[k] !== undefined).map((k) => [k, (input as unknown as Record<string, string | null>)[k]]));
      let before: Record<string, string | null>;
      let after: Record<string, string | null>;
      if (input.kind === 'LEAGUE') {
        if (!input.name) throw new BadRequestException('Indica el nombre de la liga');
        before = { name: identity.leagueName };
        after = { name: input.name };
        identity.leagueName = input.name;
      } else if (input.kind === 'TEAM') {
        const team = identity.teams.find((x) => String(x.teamId) === input.refId);
        if (!team) throw new NotFoundException('El equipo no está en los nombres históricos de este torneo');
        after = pick(['name', 'shortName']);
        if (!Object.keys(after).length) throw new BadRequestException('Indica el nombre o la abreviatura');
        before = Object.fromEntries(Object.keys(after).map((k) => [k, (team as unknown as Record<string, string>)[k]]));
        Object.assign(team, after);
      } else {
        const player = identity.players.find((x) => String(x.playerId) === input.refId);
        if (!player) throw new NotFoundException('El jugador no está en los nombres históricos de este torneo');
        after = pick(['firstName', 'lastName', 'nickname']);
        if (!Object.keys(after).length) throw new BadRequestException('Indica el nombre, el apellido o el apodo');
        before = Object.fromEntries(Object.keys(after).map((k) => [k, (player as unknown as Record<string, string | null>)[k] ?? null]));
        Object.assign(player, after);
      }
      const role = (await this.access.roleOf(tournamentId, user.id, session)) ?? 'OWNER';
      identity.corrections = [
        ...(identity.corrections ?? []),
        { kind: input.kind, refId: input.refId ? toObjectId(input.refId) : null, before, after, reason: input.reason, by: toObjectId(user.id), role, at: new Date() },
      ];
      await this.tournaments.updateOne({ _id: t._id }, { $set: { identity } }, { session, timestamps: false });
      return { corrections: identity.corrections.length, before, after };
    });
  }
}
