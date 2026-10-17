import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { MembershipAuditAction, TeamMembership, type TeamMembershipDocument } from './schemas/team-membership.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { MatchSheet } from '../match-sheet/schemas/match-sheet.schema.js';
import { Sanction } from '../discipline/schemas/sanction.schema.js';
import { PlayerBlock } from './schemas/player-block.schema.js';
import { assertNotBlocked, blockedAmong } from './blocks.js';
import { participationOf } from '../match-sheet/lineup.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Player } from './schemas/player.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { DEFAULT_REGISTRATION, Tournament, withCoverage } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { TeamRoster } from '../teams/schemas/team-roster.schema.js';
import { MatchStatus, PlayerPosition, TeamRosterStatus, TournamentStatus } from '../../common/enums/index.js';
import { MembershipQueryDto, RegisterPlayerDto } from './dto/player.dto.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import {
  serialize,
  toObjectId,
  type WithId,
} from '../../common/utils/serialize.js';
import { todayISODate } from '../../common/utils/dates.js';
import { transferredFrom } from './membership-rules.js';
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
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(MatchSheet.name) private readonly sheets: Model<MatchSheet>,
    @InjectModel(Sanction.name) private readonly sanctions: Model<Sanction>,
    @InjectModel(PlayerBlock.name) private readonly blocks: Model<PlayerBlock>,
    private readonly ownership: OwnershipService,
    private readonly teamAccess: TeamAccessService,
    private readonly access: TournamentAccessService,
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
        .select('-endReason')
        .sort({ _id: 1 })
        .skip(skipFor(query))
        .limit(query.limit)
        .lean(),
      this.memberships.countDocuments(filter),
    ]);
    // La auditoría no sale: solo `transferredFrom` (3C), que el panel usa para ofrecer la anulación.
    return paginated(serialize(items.map(({ audit, ...m }) => ({ ...m, transferredFrom: transferredFrom({ audit }) }))), total, query);
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
   * Registra al jugador en un equipo de MI torneo, o lo mueve de equipo dentro de él (3A).
   * - Mismo equipo → actualiza el dorsal; con `startDate` anterior, adelanta su elegibilidad
   *   (excepción RETROACTIVE).
   * - Otro equipo → solo con `fromTeamId` = su equipo actual (cambio explícito): cierra la
   *   participación activa en ESTE torneo y abre otra. Sin él → 409 PLAYER_IN_OTHER_TEAM.
   * - Fecha efectiva (`startDate`) por defecto hoy; anterior a hoy = RETROACTIVE: motivo y permiso
   *   REGISTRATION_EXCEPTIONS. Un cambio retroactivo que dejaría fuera de periodo partidos ya
   *   jugados con el equipo anterior → 409 (nunca se alteran en silencio).
   * - Equipo lleno (`registration.maxPlayers`) → 409 TEAM_FULL, salvo excepción OVER_LIMIT con motivo.
   * - 3C, cambio de equipo: motivo obligatorio (`transferReason`); fecha límite del torneo y bloqueo
   *   desde la eliminatoria, ambos contra la fecha REAL de hoy (una fecha efectiva retroactiva no
   *   los evita). El bloqueo admite excepción KNOCKOUT_EXCEPTION con motivo.
   * - 3D: quien ya jugó en el torneo con OTRO equipo (participación cerrada por una baja) y vuelve
   *   con uno distinto también es un cambio de equipo, con las mismas reglas: una baja intermedia no
   *   las evita. Volver al MISMO equipo es un alta normal. Ni el equipo retirado (409 TEAM_WITHDRAWN)
   *   ni un jugador con bloqueo administrativo vigente (409 PLAYER_BLOCKED) admiten altas nuevas.
   * Excepciones, altas y cambios quedan en `audit` (quién, rol, cuándo, por qué).
   * Nunca toca participaciones de otros torneos. Todo va en una transacción con el cerrojo.
   */
  async register(tournamentId: string, playerId: string, dto: RegisterPlayerDto, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    await this.assertPlayer(playerId);
    await this.assertTeam(dto.teamId);
    const jerseyNumber = dto.jerseyNumber ?? null;
    const today = todayISODate();
    const retroReason = dto.retroactiveReason?.trim() || null;
    const overReason = dto.overLimitReason?.trim() || null;
    const transferReason = dto.transferReason?.trim() || null;
    const knockoutReason = dto.knockoutReason?.trim() || null;
    const [tid, pid, team] = [toObjectId(tournamentId), toObjectId(playerId), toObjectId(dto.teamId)];

    // Con el cerrojo del torneo: no se cruza con finalizarlo, con retirar al equipo del torneo
    // (que borra sus participaciones), con otra alta del mismo jugador ni con otra del mismo equipo (cupo).
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      await this.assertEnrolled(tid, team, session, true);
      const role = await this.access.roleOf(tid, user.id, session);
      const entry = (action: MembershipAuditAction, reason: string | null = null, details: Record<string, unknown> | null = null) => ({ action, reason, by: toObjectId(user.id), role, at: new Date(), details });
      const exception = async (reason: string | null, what: string) => {
        if (!reason) throw new BadRequestException(`Indica el motivo: ${what}`);
        await this.access.require(tid, user.id, Permission.REGISTRATION_EXCEPTIONS, session);
      };
      const current = await this.memberships.findOne({ tournamentId: tid, playerId: pid, active: true }).session(session);

      if (current && current.teamId.equals(team)) {
        if (current.jerseyNumber !== jerseyNumber) {
          await this.assertJerseyFree(tournamentId, dto.teamId, jerseyNumber, playerId, session);
          current.audit.push(entry(MembershipAuditAction.JERSEY_CHANGED, null, { from: current.jerseyNumber, to: jerseyNumber }));
          current.jerseyNumber = jerseyNumber;
        }
        // Adelantar la elegibilidad de su participación actual (p. ej. jugó antes de inscribirse).
        if (dto.startDate && dto.startDate < current.startDate) {
          await exception(retroReason, 'la elegibilidad retroactiva requiere justificación');
          await this.assertNoOverlap(tid, pid, dto.startDate, session, current._id);
          current.audit.push(entry(MembershipAuditAction.RETROACTIVE, retroReason, { from: current.startDate, to: dto.startDate }));
          current.startDate = dto.startDate;
        } else if (dto.startDate && dto.startDate > current.startDate) {
          throw new BadRequestException('La fecha efectiva de una participación vigente solo puede adelantarse (no retrasarse)');
        }
        if (current.isModified()) await current.save({ session });
        return;
      }
      if (current && !(dto.fromTeamId && current.teamId.equals(toObjectId(dto.fromTeamId)))) {
        const other = await this.teams.findById(current.teamId).select('name').session(session).lean();
        throw new ConflictException({
          statusCode: 409,
          error: 'PLAYER_IN_OTHER_TEAM',
          message: `El jugador ya juega con ${other?.name ?? 'otro equipo'} en este torneo. Para cambiarlo de equipo usa "Dorsal / equipo" en su fila de la plantilla.`,
          teamId: current.teamId.toHexString(),
        });
      }

      // 3D: su última participación en el torneo (cerrada) fue con otro equipo → es un cambio de equipo.
      const last = current ? null : await this.lastClosed(tid, pid, session);
      const rejoinsOther = !!last && !last.teamId.equals(team);
      const transfer = !!current || rejoinsOther;
      await assertNotBlocked(this.blocks, session, tid, [playerId], today, (ids) => this.names(ids, session), 'inscribirse ni cambiar de equipo');
      const changeDate = this.changeDate(current, dto.startDate);
      // `fromTeamId` solo en un cambio directo (lo anulable, 3C); tras una baja, `previousTeamId`.
      const details = current ? { fromTeamId: current.teamId.toHexString() } : rejoinsOther ? { previousTeamId: last!.teamId.toHexString() } : null;
      const audit = [entry(MembershipAuditAction.REGISTERED, transfer ? transferReason : null, details)];
      if (transfer) {
        if (!transferReason && current) throw new BadRequestException('Indica el motivo del cambio de equipo');
        if (!transferReason) {
          const previous = await this.teams.findById(last!.teamId).select('name').session(session).lean();
          throw new ConflictException({
            statusCode: 409,
            error: 'TRANSFER_REASON_REQUIRED',
            message: `Ya jugó con ${previous?.name ?? 'otro equipo'} en este torneo: inscribirlo con otro equipo es un cambio de equipo. Indica el motivo.`,
            previousTeamId: last!.teamId.toHexString(),
          });
        }
        const rules = await this.transferRules(tid, session);
        if (rules.transferDeadline && today > rules.transferDeadline) {
          throw new ConflictException({ statusCode: 409, error: 'TRANSFER_DEADLINE_PASSED', message: `El plazo para cambiar jugadores de equipo terminó el ${rules.transferDeadline}`, deadline: rules.transferDeadline });
        }
        if (rules.lockTransfersOnKnockout && (await this.knockoutStarted(tid, today, session))) {
          if (!knockoutReason) {
            throw new ConflictException({ statusCode: 409, error: 'TRANSFERS_LOCKED_KNOCKOUT', message: 'La fase eliminatoria ya empezó: el torneo no permite cambios de equipo salvo excepción justificada' });
          }
          await exception(knockoutReason, 'el cambio de equipo con la eliminatoria iniciada requiere justificación');
          audit.push(entry(MembershipAuditAction.KNOCKOUT_EXCEPTION, knockoutReason));
        }
      }
      if (changeDate < today) {
        await exception(retroReason, 'la fecha efectiva es anterior a hoy (elegibilidad retroactiva)');
        audit.push(entry(MembershipAuditAction.RETROACTIVE, retroReason, { from: today, to: changeDate }));
      }
      if (current) {
        // Cerrarla en una fecha pasada no puede dejar fuera de periodo partidos ya jugados con ese equipo.
        const played = await this.playedAfter(tid, pid, current.teamId, changeDate, session);
        if (played.length) {
          throw new ConflictException({
            statusCode: 409,
            error: 'MOVE_AFFECTS_PLAYED_MATCHES',
            message: `Ya jugó con su equipo actual después del ${changeDate} (${played.map((m) => m.date).join(', ')}). Elige una fecha de cambio posterior a esos partidos.`,
            matchIds: played.map((m) => m.id),
          });
        }
      } else {
        await this.assertNoOverlap(tid, pid, changeDate, session);
      }
      const max = await this.maxPlayers(tid, session);
      if (max !== null) {
        const count = await this.memberships.countDocuments({ tournamentId: tid, teamId: team, active: true }).session(session);
        if (count >= max) {
          if (!overReason) {
            throw new ConflictException({ statusCode: 409, error: 'TEAM_FULL', message: `El torneo permite como máximo ${max} jugadores por equipo (este equipo ya tiene ${count})`, max, count });
          }
          await exception(overReason, 'superar el máximo de jugadores requiere justificación');
          audit.push(entry(MembershipAuditAction.OVER_LIMIT, overReason, { max, count }));
        }
      }
      if (current) {
        current.active = false;
        current.endDate = changeDate;
        current.audit.push(entry(MembershipAuditAction.MOVED, transferReason, { toTeamId: dto.teamId }));
        await current.save({ session });
      }
      await this.assertJerseyFree(tournamentId, dto.teamId, jerseyNumber, playerId, session);
      await this.memberships.create(
        [{ playerId: pid, teamId: team, tournamentId: tid, jerseyNumber, startDate: changeDate, registeredAt: today, active: true, audit }],
        { session },
      );
    });

    return this.playerHistory(playerId);
  }

  /**
   * Da de baja al jugador de MI torneo, con motivo (3A). Cierra su participación: partidos,
   * estadísticas e historial se conservan, aunque ya haya jugado.
   */
  async unregister(tournamentId: string, playerId: string, reason: string, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      const current = await this.memberships
        .findOne({ tournamentId: toObjectId(tournamentId), playerId: toObjectId(playerId), active: true })
        .session(session);
      if (!current) throw new NotFoundException('El jugador no participa en este torneo');
      const role = await this.access.roleOf(tournamentId, user.id, session);
      this.close(current, reason, user.id, role);
      await current.save({ session });
    });
  }

  /**
   * 3C — anula una transferencia errónea (motivo obligatorio, permiso TEAMS = propietario y
   * administradores). Solo si NO hubo participación deportiva con el equipo equivocado: ni
   * estadísticas, ni ficha (aunque sea de suplente), ni sanciones. Entonces la participación errónea
   * se retira y su copia completa queda en la auditoría de la anterior, que se reabre tal como estaba
   * (sin dorsal si alguien lo ocupó). No cuenta como participación ni aparece en el perfil. Con
   * participación → 409: requiere otra corrección (p. ej. un nuevo cambio de equipo).
   * Va con el cerrojo del torneo: no se cruza con capturas, fichas ni otros cambios del jugador.
   */
  async annulTransfer(tournamentId: string, playerId: string, reason: string, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    await this.assertPlayer(playerId);
    const [tid, pid] = [toObjectId(tournamentId), toObjectId(playerId)];
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      const current = await this.memberships.findOne({ tournamentId: tid, playerId: pid, active: true }).session(session);
      if (!current) throw new NotFoundException('El jugador no participa en este torneo');
      const fromTeamId = transferredFrom(current);
      const previous = fromTeamId
        ? await this.memberships.findOne({ tournamentId: tid, playerId: pid, active: false, teamId: toObjectId(fromTeamId), endDate: current.startDate }).sort({ _id: -1 }).session(session)
        : null;
      if (!previous) {
        throw new ConflictException({ statusCode: 409, error: 'NOT_A_TRANSFER', message: 'Su participación actual no viene de un cambio de equipo: para quitarlo del torneo usa la baja' });
      }
      // 3D: no se reabre una participación en un equipo retirado del torneo.
      await this.assertEnrolled(tid, previous.teamId, session, true);
      const teamMatches = await this.matches.find({ tournamentId: tid, $or: [{ homeTeamId: current.teamId }, { awayTeamId: current.teamId }] }).select('_id').session(session).lean();
      const ids = teamMatches.map((m) => m._id);
      const [stat, sheet, sanction] = await Promise.all([
        this.stats.exists({ matchId: { $in: ids }, playerId: pid, teamId: current.teamId }).session(session),
        this.sheets.exists({ matchId: { $in: ids }, teams: { $elemMatch: { teamId: current.teamId, 'players.playerId': pid } } }).session(session),
        this.sanctions.exists({ tournamentId: tid, playerId: pid, teamId: current.teamId }).session(session),
      ]);
      if (stat || sheet || sanction) {
        const team = await this.teams.findById(current.teamId).select('name').session(session).lean();
        throw new ConflictException({
          statusCode: 409,
          error: 'TRANSFER_HAS_PARTICIPATION',
          message: `Ya tiene ${[stat && 'estadísticas', sheet && 'alineaciones en la ficha', sanction && 'sanciones'].filter(Boolean).join(', ')} con ${team?.name ?? 'el equipo nuevo'}: anular la transferencia borraría esa historia. Requiere una corrección administrativa distinta (por ejemplo, un nuevo cambio de equipo).`,
        });
      }
      const role = await this.access.roleOf(tid, user.id, session);
      const jerseyTaken =
        previous.jerseyNumber !== null &&
        !!(await this.memberships.exists({ tournamentId: tid, teamId: previous.teamId, jerseyNumber: previous.jerseyNumber, active: true, playerId: { $ne: pid } }).session(session));
      const annulled = {
        membershipId: current._id.toHexString(),
        teamId: current.teamId.toHexString(),
        jerseyNumber: current.jerseyNumber,
        startDate: current.startDate,
        registeredAt: current.registeredAt ?? null,
        audit: current.toObject().audit.map((a) => ({ ...a, by: a.by.toHexString() })),
      };
      await this.memberships.deleteOne({ _id: current._id }, { session });
      previous.active = true;
      previous.endDate = null;
      const clearedJersey = jerseyTaken ? previous.jerseyNumber : null;
      if (jerseyTaken) previous.jerseyNumber = null;
      previous.audit.push({ action: MembershipAuditAction.TRANSFER_ANNULLED, reason: reason.trim(), by: toObjectId(user.id), role, at: new Date(), details: { annulled, ...(jerseyTaken ? { jerseyCleared: clearedJersey } : {}) } });
      await previous.save({ session });
    });
    return this.playerHistory(playerId);
  }

  // ─── Lado del equipo (OWNER/MANAGER) ─────────────────────────────────────────

  /**
   * GET /teams/:id/tournaments — torneos donde está inscrito el equipo (en curso primero, luego
   * finalizados) con la plantilla del equipo en cada uno y los límites del organizador.
   */
  async teamTournaments(teamId: string, user: AuthUser) {
    await this.teamAccess.requireManager(teamId, user);
    const enrollments = await this.enrollments.find({ teamId: toObjectId(teamId) }).select('tournamentId withdrawnAt').lean();
    const withdrawnAt = new Map(enrollments.map((e) => [e.tournamentId.toHexString(), e.withdrawnAt ?? null]));
    const tournaments = await this.tournaments
      .find({ _id: { $in: enrollments.map((e) => e.tournamentId) } })
      .select('name format category status startDate endDate dataCoverage registration')
      .lean();
    const groups = await this.rostersByTournament(teamId, tournaments.map((t) => t._id));
    // 3D: el equipo ve si sus jugadores tienen un bloqueo administrativo vigente (sin el motivo).
    const today = todayISODate();
    const blocked = new Set<string>();
    for (const g of groups) {
      const ids = await blockedAmong(this.blocks, null, g.players[0].membership.tournamentId, g.players.map((p) => p.player.id), today);
      for (const id of ids) blocked.add(`${g.players[0].membership.tournamentId}:${id}`);
    }
    const players = new Map(
      groups.map((g) => [g.players[0].membership.tournamentId, g.players.map((p) => ({ ...p, blocked: blocked.has(`${p.membership.tournamentId}:${p.player.id}`) }))]),
    );
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
            editable: t.status !== TournamentStatus.FINISHED && !withdrawnAt.get(t._id.toHexString()),
            withdrawnAt: withdrawnAt.get(t._id.toHexString()) ?? null,
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
      await this.assertEnrolled(tid, team, session, true);
      const inRoster = await this.rosters.exists({ teamId: team, playerId: pid, status: TeamRosterStatus.ACTIVE }).session(session);
      if (!inRoster) throw new ConflictException('Primero agrega al jugador a la plantilla del equipo');

      const current = await this.memberships.findOne({ tournamentId: tid, playerId: pid, active: true }).session(session);
      if (current && !current.teamId.equals(team)) {
        const other = await this.teams.findById(current.teamId).select('name').session(session).lean();
        throw new ConflictException({
          statusCode: 409,
          error: 'PLAYER_IN_OTHER_TEAM',
          message: `El jugador ya juega con ${other?.name ?? 'otro equipo'} en este torneo; solo el organizador puede cambiarlo de equipo`,
          teamId: current.teamId.toHexString(),
        });
      }
      if (current) {
        if (current.jerseyNumber !== jerseyNumber) {
          await this.assertJerseyFree(tournamentId, teamId, jerseyNumber, playerId, session);
          current.audit.push({ action: MembershipAuditAction.JERSEY_CHANGED, reason: null, by: toObjectId(user.id), role: 'TEAM', at: new Date(), details: { from: current.jerseyNumber, to: jerseyNumber } });
          current.jerseyNumber = jerseyNumber;
          await current.save({ session });
        }
        return;
      }

      // 3D: si su última participación en el torneo fue con otro equipo, volver es un cambio de equipo
      // (motivo, plazo, eliminatoria): solo el organizador. Una baja intermedia no lo evita.
      const last = await this.lastClosed(tid, pid, session);
      if (last && !last.teamId.equals(team)) {
        const other = await this.teams.findById(last.teamId).select('name').session(session).lean();
        throw new ConflictException({
          statusCode: 409,
          error: 'TRANSFER_REQUIRES_ORGANIZER',
          message: `El jugador ya jugó con ${other?.name ?? 'otro equipo'} en este torneo: inscribirlo en tu equipo es un cambio de equipo y lo hace el organizador`,
          teamId: last.teamId.toHexString(),
        });
      }
      await assertNotBlocked(this.blocks, session, tid, [playerId], todayISODate(), (ids) => this.names(ids, session), 'inscribirse');
      // El equipo no tiene excepciones: el máximo del organizador es firme (solo él puede superarlo).
      const max = await this.maxPlayers(tid, session);
      if (max !== null) {
        const count = await this.memberships.countDocuments({ tournamentId: tid, teamId: team, active: true }).session(session);
        if (count >= max) {
          throw new ConflictException({ statusCode: 409, error: 'TEAM_FULL', message: `El torneo permite como máximo ${max} jugadores por equipo; pide al organizador una excepción`, max, count });
        }
      }
      // Desde el equipo la elegibilidad empieza hoy (sin fechas retroactivas).
      const today = todayISODate();
      await this.assertNoOverlap(tid, pid, today, session);
      await this.assertJerseyFree(tournamentId, teamId, jerseyNumber, playerId, session);
      await this.memberships.create(
        [{ playerId: pid, teamId: team, tournamentId: tid, jerseyNumber, startDate: today, registeredAt: today, active: true, audit: [{ action: MembershipAuditAction.REGISTERED, reason: null, by: toObjectId(user.id), role: 'TEAM', at: new Date(), details: null }] }],
        { session },
      );
    });
    return this.teamTournaments(teamId, user);
  }

  /** DELETE /teams/:id/tournaments/:tournamentId/players/:playerId — baja del jugador en el torneo, con motivo (el historial se conserva). */
  async unregisterByTeam(teamId: string, tournamentId: string, playerId: string, reason: string, user: AuthUser) {
    await this.teamAccess.requireManager(teamId, user);
    await this.ownership.inTournament(tournamentId, null, async (session) => {
      await this.assertEnrolled(toObjectId(tournamentId), toObjectId(teamId), session);
      const current = await this.memberships
        .findOne({ tournamentId: toObjectId(tournamentId), teamId: toObjectId(teamId), playerId: toObjectId(playerId), active: true })
        .session(session);
      if (!current) throw new NotFoundException('El jugador no está en la plantilla de tu equipo en este torneo');
      this.close(current, reason, user.id, 'TEAM');
      await current.save({ session });
    });
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  /** Baja: cierra hoy (o al inicio, si aún no empezaba) con motivo y queda en la auditoría. */
  private close(current: TeamMembershipDocument, reason: string, userId: string, role: string | null) {
    const text = reason.trim();
    if (!text) throw new BadRequestException('Indica el motivo de la baja');
    current.active = false;
    current.endDate = this.changeDate(current);
    current.endReason = text;
    current.audit.push({ action: MembershipAuditAction.UNREGISTERED, reason: text, by: toObjectId(userId), role, at: new Date(), details: null });
  }

  /**
   * 404 si el equipo no existe; 409 TEAM_NOT_ENROLLED si existe pero no juega este torneo (mismo
   * criterio en ambos lados). `acceptsPlayers` (altas): 409 TEAM_WITHDRAWN si se retiró (3D).
   */
  private async assertEnrolled(tournamentId: Types.ObjectId, teamId: Types.ObjectId, session: ClientSession, acceptsPlayers = false) {
    const enrollment = await this.enrollments.findOne({ tournamentId, teamId }).select('withdrawnAt').session(session).lean();
    if (enrollment && acceptsPlayers && enrollment.withdrawnAt) {
      const team = await this.teams.findById(teamId).select('name').session(session).lean();
      throw new ConflictException({ statusCode: 409, error: 'TEAM_WITHDRAWN', message: `${team?.name ?? 'El equipo'} se retiró del torneo el ${enrollment.withdrawnAt}: no admite jugadores`, withdrawnAt: enrollment.withdrawnAt });
    }
    if (enrollment) return;
    if (!(await this.teams.exists({ _id: teamId }).session(session))) throw new NotFoundException(`Equipo ${teamId.toHexString()} no encontrado`);
    throw new ConflictException({ statusCode: 409, error: 'TEAM_NOT_ENROLLED', message: 'El equipo no está inscrito en este torneo' });
  }

  /** Última participación CERRADA del jugador en el torneo (la más reciente). */
  private lastClosed(tournamentId: Types.ObjectId, playerId: Types.ObjectId, session: ClientSession) {
    return this.memberships.findOne({ tournamentId, playerId, active: false }).sort({ endDate: -1, _id: -1 }).select('teamId endDate').session(session).lean();
  }

  private async names(ids: string[], session: ClientSession) {
    const list = await this.players.find({ _id: { $in: ids.map(toObjectId) } }).select('firstName lastName').session(session).lean();
    return ids.map((id) => {
      const p = list.find((x) => x._id.equals(id));
      return p ? `${p.firstName} ${p.lastName}` : id;
    });
  }

  private async transferRules(tournamentId: Types.ObjectId, session: ClientSession) {
    const t = await this.tournaments.findById(tournamentId).select('registration').session(session).lean();
    return { ...DEFAULT_REGISTRATION, ...t?.registration };
  }

  /**
   * 3C — la eliminatoria empezó: algún partido de eliminatoria (con cruce, `stage.tie`) no cancelado
   * ya se jugó o está en juego, o su fecha llegó (`today`, fecha real). Generar el cuadro no basta.
   */
  private async knockoutStarted(tournamentId: Types.ObjectId, today: string, session: ClientSession) {
    return !!(await this.matches
      .exists({
        tournamentId,
        'stage.tie': { $ne: null },
        status: { $ne: MatchStatus.CANCELLED },
        $or: [{ date: { $lte: today } }, { status: { $in: [MatchStatus.LIVE, MatchStatus.FINISHED, MatchStatus.SUSPENDED] } }],
      })
      .session(session));
  }

  private async maxPlayers(tournamentId: Types.ObjectId, session: ClientSession) {
    const t = await this.tournaments.findById(tournamentId).select('registration').session(session).lean();
    return t?.registration?.maxPlayers ?? null;
  }

  /** Una nueva participación no puede empezar antes de que terminara la anterior en el torneo (mismo día sí: cambio de equipo). */
  private async assertNoOverlap(tournamentId: Types.ObjectId, playerId: Types.ObjectId, startDate: string, session: ClientSession, except?: Types.ObjectId) {
    const previous = await this.memberships
      .findOne({ tournamentId, playerId, active: false, endDate: { $gt: startDate }, ...(except ? { _id: { $ne: except } } : {}) })
      .select('endDate')
      .session(session)
      .lean();
    if (previous) {
      throw new ConflictException({ statusCode: 409, error: 'PERIOD_OVERLAP', message: `Su participación anterior en este torneo terminó el ${previous.endDate}: la nueva no puede empezar antes` });
    }
  }

  /** Partidos del torneo jugados por el jugador con ese equipo DESPUÉS de `date` (estadísticas o alineación). */
  private async playedAfter(tournamentId: Types.ObjectId, playerId: Types.ObjectId, teamId: Types.ObjectId, date: string, session: ClientSession) {
    const later = await this.matches.find({ tournamentId, date: { $gt: date }, $or: [{ homeTeamId: teamId }, { awayTeamId: teamId }] }).select('_id date').session(session).lean();
    if (!later.length) return [];
    const ids = later.map((m) => m._id);
    const [stats, sheets] = await Promise.all([
      this.stats.find({ matchId: { $in: ids }, playerId, teamId, played: { $ne: false } }).select('matchId').session(session).lean(),
      this.sheets.find({ matchId: { $in: ids }, teams: { $elemMatch: { teamId, 'players.playerId': playerId } } }).select('matchId teams').session(session).lean(),
    ]);
    const hit = new Set(stats.map((s) => s.matchId.toHexString()));
    for (const sheet of sheets) {
      const lineup = sheet.teams.find((t) => t.teamId.equals(teamId));
      if (lineup && participationOf(lineup).participants.has(playerId.toHexString())) hit.add(sheet.matchId.toHexString());
    }
    return later.filter((m) => hit.has(m._id.toHexString())).map((m) => ({ id: m._id.toHexString(), date: m.date })).sort((a, b) => a.date.localeCompare(b.date));
  }

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
    // La auditoría no sale en las respuestas: solo se deriva de ella `transferredFrom` (3C).
    const rows = await this.memberships
      .find(filter)
      .select('-endReason')
      .sort(sort)
      .populate('playerId')
      .populate('teamId')
      .populate('tournamentId', 'name status startDate endDate dataCoverage')
      .lean<Populated[]>();
    return rows
      .filter((r) => r.playerId && r.teamId && r.tournamentId)
      .map(({ playerId: player, teamId: team, tournamentId: tournament, audit, ...m }) => ({
        ...serialize(m),
        transferredFrom: transferredFrom({ audit }),
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
