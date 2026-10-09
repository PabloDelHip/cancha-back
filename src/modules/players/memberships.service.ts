import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { TeamMembership } from './schemas/team-membership.schema.js';
import { Player } from './schemas/player.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { DEFAULT_REGISTRATION, Tournament, withCoverage } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { TeamRoster } from '../teams/schemas/team-roster.schema.js';
import { PlayerPosition, TeamRosterStatus, TournamentStatus } from '../../common/enums/index.js';
import { MembershipQueryDto, RegisterPlayerDto } from './dto/player.dto.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import {
  sameId,
  serialize,
  toObjectId,
  type WithId,
} from '../../common/utils/serialize.js';
import { todayISODate } from '../../common/utils/dates.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { TeamAccessService } from '../../common/authorization/team-access.service.js';
import { publicPlayer } from '../../common/utils/public.js';
import type { AuthUser } from '../auth/auth.types.js';

const POSITION_ORDER = [
  PlayerPosition.GOALKEEPER,
  PlayerPosition.DEFENDER,
  PlayerPosition.MIDFIELDER,
  PlayerPosition.FORWARD,
];

type Populated = Omit<TeamMembership, 'playerId' | 'teamId' | 'tournamentId'> & {
  _id: Types.ObjectId;
  playerId: WithId<Player>;
  teamId: WithId<Team>;
  tournamentId: WithId<Tournament>;
};

/**
 * Participaciones Player ↔ Team dentro de un torneo.
 *
 * Autorización: el organizador del torneo registra, mueve o da de baja jugadores en él. Player y
 * Team son globales: cualquier organizador puede usar identidades existentes en SU torneo, sin
 * tocar las participaciones de torneos ajenos (ni la ficha maestra).
 *
 * Además, el OWNER/MANAGER de un equipo inscrito administra la plantilla de SU equipo en ese torneo
 * (`/teams/:id/tournaments`): da de alta a jugadores de su plantilla global y los da de baja. No
 * puede quitarle un jugador a otro equipo del torneo (eso sigue siendo cosa del organizador).
 */
@Injectable()
export class MembershipsService {
  constructor(
    @InjectModel(TeamMembership.name)
    private readonly memberships: Model<TeamMembership>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(TournamentTeam.name)
    private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Tournament.name)
    private readonly tournaments: Model<Tournament>,
    @InjectModel(TeamRoster.name) private readonly rosters: Model<TeamRoster>,
    private readonly ownership: OwnershipService,
    private readonly teamAccess: TeamAccessService,
  ) {}

  async list(query: MembershipQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.playerId) filter.playerId = toObjectId(query.playerId);
    if (query.teamId) filter.teamId = toObjectId(query.teamId);
    if (query.tournamentId) filter.tournamentId = toObjectId(query.tournamentId);
    if (query.active !== undefined) filter.active = query.active;
    const [items, total] = await Promise.all([
      this.memberships
        .find(filter)
        .sort({ _id: 1 })
        .skip(skipFor(query))
        .limit(query.limit)
        .lean(),
      this.memberships.countDocuments(filter),
    ]);
    return paginated(serialize(items), total, query);
  }

  /** Historial del jugador en todos los torneos (más reciente primero), con equipo y torneo. */
  async playerHistory(playerId: string) {
    await this.assertPlayer(playerId);
    const rows = await this.populated({ playerId: toObjectId(playerId) }, { startDate: -1, active: -1 });
    return rows.map(({ player: _player, ...rest }) => rest);
  }

  async teamHistory(teamId: string) {
    await this.assertTeam(teamId);
    const rows = await this.populated({ teamId: toObjectId(teamId) }, { startDate: -1 });
    return rows.map(({ team: _team, ...rest }) => rest);
  }

  /**
   * Plantilla de un equipo EN UN TORNEO (TeamMembership siempre tiene contexto de torneo; no existe
   * todavía una plantilla global). Con torneo: la de ese torneo. Sin torneo (compatibilidad):
   * participaciones activas en torneos NO finalizados, una por jugador — la de un torneo finalizado
   * sigue `active` pero es historia. Para agrupar por torneo: GET /teams/:id o /teams/:id/profile.
   */
  async roster(teamId: string, tournamentId?: string) {
    await this.assertTeam(teamId);
    const filter: Record<string, unknown> = { teamId: toObjectId(teamId), active: true };
    if (tournamentId) filter.tournamentId = toObjectId(tournamentId);
    const rows = await this.populated(filter, { startDate: -1 });
    const seen = new Set<string>();
    return rows
      .filter((r) => tournamentId || r.tournament.status !== TournamentStatus.FINISHED)
      .filter((r) => {
        if (seen.has(r.player.id)) return false;
        seen.add(r.player.id);
        return true;
      })
      .map(({ player, ...membership }) => ({ membership, player }))
      .sort(byPositionAndNumber);
  }

  /**
   * Plantillas activas de un equipo en varios torneos, AGRUPADAS por torneo (una consulta).
   * Cada grupo es "la plantilla del equipo en ese torneo", nunca una plantilla global.
   */
  async rostersByTournament(teamId: string, tournamentIds: Types.ObjectId[]) {
    if (!tournamentIds.length) return [];
    const rows = await this.populated(
      { teamId: toObjectId(teamId), active: true, tournamentId: { $in: tournamentIds } },
      { startDate: -1 },
    );
    const groups = new Map<string, { tournament: (typeof rows)[number]['tournament']; players: { membership: Omit<(typeof rows)[number], 'player'>; player: (typeof rows)[number]['player'] }[] }>();
    for (const { player, ...membership } of rows) {
      const group = groups.get(membership.tournamentId) ?? { tournament: membership.tournament, players: [] };
      group.players.push({ membership, player });
      groups.set(membership.tournamentId, group);
    }
    return [...groups.values()].map((g) => ({ tournament: g.tournament, players: g.players.sort(byPositionAndNumber) }));
  }

  /** Jugadores participantes de un torneo (opcionalmente de un equipo). Lectura pública. */
  async tournamentRoster(tournamentId: string, teamId?: string) {
    if (!(await this.tournaments.exists({ _id: tournamentId }))) {
      throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);
    }
    const filter: Record<string, unknown> = { tournamentId: toObjectId(tournamentId), active: true };
    if (teamId) filter.teamId = toObjectId(teamId);
    const rows = await this.populated(filter, { startDate: -1 });
    return rows
      .map(({ player, ...membership }) => ({ membership, player }))
      .sort(
        (a, b) =>
          a.membership.team.name.localeCompare(b.membership.team.name) ||
          byPositionAndNumber(a, b),
      );
  }

  /**
   * Registra al jugador en un equipo de MI torneo, o lo mueve de equipo dentro de él.
   * - Mismo equipo → solo actualiza el dorsal.
   * - Otro equipo → cierra la participación activa en ESTE torneo y abre otra.
   * Nunca toca participaciones de otros torneos. Las dos escrituras van en una transacción.
   */
  async register(tournamentId: string, playerId: string, dto: RegisterPlayerDto, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    await this.assertPlayer(playerId);
    const enrolled = await this.enrollments.exists({
      tournamentId: toObjectId(tournamentId),
      teamId: toObjectId(dto.teamId),
    });
    if (!enrolled) throw new BadRequestException('El equipo no está inscrito en este torneo');
    const jerseyNumber = dto.jerseyNumber ?? null;

    // Con el cerrojo del torneo: no se cruza con finalizarlo ni con otra alta del mismo jugador.
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      const current = await this.memberships
        .findOne({ tournamentId: toObjectId(tournamentId), playerId: toObjectId(playerId), active: true })
        .session(session);

      if (current && sameId(current.teamId, dto.teamId)) {
        if (current.jerseyNumber !== jerseyNumber) {
          await this.assertJerseyFree(tournamentId, dto.teamId, jerseyNumber, playerId, session);
          current.jerseyNumber = jerseyNumber;
          await current.save({ session });
        }
        return;
      }

      const changeDate = this.changeDate(current, dto.startDate);
      if (current) {
        current.active = false;
        current.endDate = changeDate;
        await current.save({ session });
      }
      await this.assertJerseyFree(tournamentId, dto.teamId, jerseyNumber, playerId, session);
      await this.memberships.create(
        [
          {
            playerId: toObjectId(playerId),
            teamId: toObjectId(dto.teamId),
            tournamentId: toObjectId(tournamentId),
            jerseyNumber,
            startDate: changeDate,
            active: true,
          },
        ],
        { session },
      );
    });

    return this.playerHistory(playerId);
  }

  /** Da de baja al jugador de MI torneo (cierra su participación; el historial se conserva). */
  async unregister(tournamentId: string, playerId: string, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      const current = await this.memberships
        .findOne({ tournamentId: toObjectId(tournamentId), playerId: toObjectId(playerId), active: true })
        .session(session);
      if (!current) throw new NotFoundException('El jugador no participa en este torneo');
      current.active = false;
      current.endDate = this.changeDate(current);
      await current.save({ session });
    });
  }

  // ─── Lado del equipo (OWNER/MANAGER) ─────────────────────────────────────────

  /**
   * GET /teams/:id/tournaments — torneos donde está inscrito el equipo (en curso primero, luego
   * finalizados) con la plantilla del equipo en cada uno y los límites del organizador.
   */
  async teamTournaments(teamId: string, user: AuthUser) {
    await this.teamAccess.requireManager(teamId, user);
    const enrollments = await this.enrollments.find({ teamId: toObjectId(teamId) }).select('tournamentId').lean();
    const tournaments = await this.tournaments
      .find({ _id: { $in: enrollments.map((e) => e.tournamentId) } })
      .select('name format category status startDate endDate dataCoverage registration')
      .lean();
    const groups = await this.rostersByTournament(teamId, tournaments.map((t) => t._id));
    const players = new Map(groups.map((g) => [g.players[0].membership.tournamentId, g.players]));
    const finished = (t: { status: TournamentStatus }) => Number(t.status === TournamentStatus.FINISHED);
    return {
      teamId,
      tournaments: tournaments
        .sort((a, b) => finished(a) - finished(b) || b.startDate.localeCompare(a.startDate))
        .map(({ registration, ...t }) => {
          const r = { ...DEFAULT_REGISTRATION, ...registration };
          return {
            tournament: serialize(withCoverage(t)),
            minPlayers: r.minPlayers,
            maxPlayers: r.maxPlayers,
            editable: t.status !== TournamentStatus.FINISHED,
            players: players.get(t._id.toHexString()) ?? [],
          };
        }),
    };
  }

  /**
   * PUT /teams/:id/tournaments/:tournamentId/players/:playerId — el equipo inscribe a un jugador
   * de su plantilla global en un torneo donde juega (o cambia su dorsal). Sin aprobación del
   * organizador, pero dentro de sus reglas: equipo inscrito, torneo no finalizado, máximo de
   * jugadores y dorsal libre. Si el jugador ya juega con OTRO equipo en el torneo → 409.
   */
  async registerByTeam(teamId: string, tournamentId: string, playerId: string, jerseyNumber: number | null, user: AuthUser) {
    await this.teamAccess.requireManager(teamId, user);
    await this.assertPlayer(playerId);
    const [tid, team, pid] = [toObjectId(tournamentId), toObjectId(teamId), toObjectId(playerId)];

    await this.ownership.inTournament(tournamentId, null, async (session) => {
      const enrolled = await this.enrollments.exists({ tournamentId: tid, teamId: team }).session(session);
      if (!enrolled) throw new NotFoundException('Tu equipo no está inscrito en este torneo');
      const inRoster = await this.rosters.exists({ teamId: team, playerId: pid, status: TeamRosterStatus.ACTIVE }).session(session);
      if (!inRoster) throw new ConflictException('Primero agrega al jugador a la plantilla del equipo');

      const current = await this.memberships.findOne({ tournamentId: tid, playerId: pid, active: true }).session(session);
      if (current && !current.teamId.equals(team)) {
        const other = await this.teams.findById(current.teamId).select('name').session(session).lean();
        throw new ConflictException(`El jugador ya juega con ${other?.name ?? 'otro equipo'} en este torneo; solo el organizador puede cambiarlo de equipo`);
      }
      if (current) {
        if (current.jerseyNumber !== jerseyNumber) {
          await this.assertJerseyFree(tournamentId, teamId, jerseyNumber, playerId, session);
          current.jerseyNumber = jerseyNumber;
          await current.save({ session });
        }
        return;
      }

      const t = await this.tournaments.findById(tid).select('registration').session(session).lean();
      const max = t?.registration?.maxPlayers ?? null;
      if (max !== null) {
        const count = await this.memberships.countDocuments({ tournamentId: tid, teamId: team, active: true }).session(session);
        if (count >= max) throw new ConflictException(`El torneo permite como máximo ${max} jugadores por equipo`);
      }
      await this.assertJerseyFree(tournamentId, teamId, jerseyNumber, playerId, session);
      await this.memberships.create(
        [{ playerId: pid, teamId: team, tournamentId: tid, jerseyNumber, startDate: this.changeDate(null), active: true }],
        { session },
      );
    });
    return this.teamTournaments(teamId, user);
  }

  /** DELETE /teams/:id/tournaments/:tournamentId/players/:playerId — baja del jugador en el torneo (el historial se conserva). */
  async unregisterByTeam(teamId: string, tournamentId: string, playerId: string, user: AuthUser) {
    await this.teamAccess.requireManager(teamId, user);
    await this.ownership.inTournament(tournamentId, null, async (session) => {
      const current = await this.memberships
        .findOne({ tournamentId: toObjectId(tournamentId), teamId: toObjectId(teamId), playerId: toObjectId(playerId), active: true })
        .session(session);
      if (!current) throw new NotFoundException('El jugador no está en la plantilla de tu equipo en este torneo');
      current.active = false;
      current.endDate = this.changeDate(current);
      await current.save({ session });
    });
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  /** El cambio ocurre hoy (o en la fecha pedida), nunca antes de la participación vigente. */
  private changeDate(current: TeamMembership | null, requested?: string): string {
    if (requested && current && requested < current.startDate) {
      throw new BadRequestException(
        `startDate no puede ser anterior al inicio de la participación actual (${current.startDate})`,
      );
    }
    const date = requested ?? todayISODate();
    return current && current.startDate > date ? current.startDate : date;
  }

  private async populated(filter: Record<string, unknown>, sort: Record<string, 1 | -1>) {
    const rows = await this.memberships
      .find(filter)
      .sort(sort)
      .populate('playerId')
      .populate('teamId')
      .populate('tournamentId', 'name status startDate endDate dataCoverage')
      .lean<Populated[]>();
    return rows
      .filter((r) => r.playerId && r.teamId && r.tournamentId)
      .map(({ playerId: player, teamId: team, tournamentId: tournament, ...m }) => ({
        ...serialize(m),
        playerId: player._id.toHexString(),
        teamId: team._id.toHexString(),
        tournamentId: tournament._id.toHexString(),
        player: publicPlayer(player),
        team: serialize(team),
        tournament: serialize(withCoverage(tournament)),
      }));
  }

  private async assertJerseyFree(
    tournamentId: string,
    teamId: string,
    jerseyNumber: number | null,
    playerId: string,
    session: ClientSession,
  ) {
    if (jerseyNumber === null) return;
    const taken = await this.memberships
      .findOne({
        tournamentId: toObjectId(tournamentId),
        teamId: toObjectId(teamId),
        jerseyNumber,
        active: true,
        playerId: { $ne: toObjectId(playerId) },
      })
      .session(session)
      .lean();
    if (taken) throw new ConflictException(`El dorsal #${jerseyNumber} ya está ocupado en ese equipo`);
  }

  private async assertPlayer(id: string | Types.ObjectId) {
    if (!(await this.players.exists({ _id: id }))) throw new NotFoundException(`Jugador ${id} no encontrado`);
  }

  private async assertTeam(id: string | Types.ObjectId) {
    if (!(await this.teams.exists({ _id: id }))) throw new NotFoundException(`Equipo ${id} no encontrado`);
  }
}

type RosterEntry = {
  player: { position: PlayerPosition };
  membership: { jerseyNumber: number | null };
};

function byPositionAndNumber(a: RosterEntry, b: RosterEntry) {
  return (
    POSITION_ORDER.indexOf(a.player.position) - POSITION_ORDER.indexOf(b.player.position) ||
    (a.membership.jerseyNumber ?? 99) - (b.membership.jerseyNumber ?? 99)
  );
}
