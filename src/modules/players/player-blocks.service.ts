import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PlayerBlock } from './schemas/player-block.schema.js';
import { Player } from './schemas/player.schema.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission, can } from '../../common/authorization/permissions.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { todayISODate } from '../../common/utils/dates.js';
import type { BlockPlayerDto, LiftBlockDto } from './dto/player.dto.js';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * 3D — bloqueos administrativos de jugadores en un torneo (ver PlayerBlock). Aplicar y levantar:
 * permiso TEAMS (propietario y administradores), motivo obligatorio y fecha; una fecha anterior a
 * hoy es una excepción (REGISTRATION_EXCEPTIONS). Todo con el cerrojo del torneo, así no se cruza
 * con una inscripción, una captura o una ficha del mismo jugador.
 */
@Injectable()
export class PlayerBlocksService {
  constructor(
    @InjectModel(PlayerBlock.name) private readonly blocks: Model<PlayerBlock>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
  ) {}

  /**
   * Bloqueos del torneo (vigentes y levantados, más recientes primero). Panel del torneo (VIEW); el
   * motivo y los autores solo para quien administra la plantilla (TEAMS).
   */
  async list(tournamentId: string, user: AuthUser) {
    const { role } = await this.access.require(tournamentId, user.id, Permission.VIEW);
    const detailed = can(role, Permission.TEAMS);
    const rows = await this.blocks.find({ tournamentId: toObjectId(tournamentId) }).sort({ since: -1, _id: -1 }).lean();
    return rows.map((b) => {
      const { reason, liftReason, blockedBy, liftedBy, blockedRole, liftedRole, ...rest } = serialize(b);
      return { ...rest, active: b.until === null, ...(detailed ? { reason, liftReason, blockedBy, liftedBy, blockedRole, liftedRole } : {}) };
    });
  }

  async block(tournamentId: string, playerId: string, dto: BlockPlayerDto, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    if (!(await this.players.exists({ _id: playerId }))) throw new NotFoundException(`Jugador ${playerId} no encontrado`);
    const today = todayISODate();
    const since = dto.since ?? today;
    if (since > today) throw new BadRequestException('El bloqueo empieza hoy o en una fecha pasada');
    const [tid, pid] = [toObjectId(tournamentId), toObjectId(playerId)];
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      if (await this.blocks.exists({ tournamentId: tid, playerId: pid, until: null }).session(session)) {
        throw new ConflictException({ statusCode: 409, error: 'PLAYER_ALREADY_BLOCKED', message: 'El jugador ya tiene un bloqueo vigente en este torneo' });
      }
      // Los periodos no se solapan: el historial queda legible.
      const last = await this.blocks.findOne({ tournamentId: tid, playerId: pid }).sort({ until: -1 }).select('until').session(session).lean();
      if (last?.until && since < last.until) {
        throw new BadRequestException(`Su bloqueo anterior se levantó el ${last.until}: el nuevo no puede empezar antes`);
      }
      if (since < today) await this.access.require(tid, user.id, Permission.REGISTRATION_EXCEPTIONS, session);
      const role = await this.access.roleOf(tid, user.id, session);
      await this.blocks.create([{ tournamentId: tid, playerId: pid, since, reason: dto.reason.trim(), blockedBy: toObjectId(user.id), blockedRole: role }], { session });
    });
    return this.list(tournamentId, user);
  }

  async lift(tournamentId: string, playerId: string, dto: LiftBlockDto, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    const today = todayISODate();
    const until = dto.until ?? today;
    if (until > today) throw new BadRequestException('El bloqueo se levanta hoy o en una fecha pasada');
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      const open = await this.blocks.findOne({ tournamentId: toObjectId(tournamentId), playerId: toObjectId(playerId), until: null }).session(session);
      if (!open) throw new NotFoundException('El jugador no tiene un bloqueo vigente en este torneo');
      if (until < open.since) throw new BadRequestException(`El bloqueo empezó el ${open.since}: no puede levantarse antes`);
      if (until < today) await this.access.require(tournamentId, user.id, Permission.REGISTRATION_EXCEPTIONS, session);
      open.until = until;
      open.liftReason = dto.reason.trim();
      open.liftedBy = toObjectId(user.id);
      open.liftedRole = await this.access.roleOf(tournamentId, user.id, session);
      open.liftedAt = new Date();
      await open.save({ session });
    });
    return this.list(tournamentId, user);
  }
}
