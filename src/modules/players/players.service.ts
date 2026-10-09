import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { normalizeSearch, Player, playerSearchName } from './schemas/player.schema.js';
import { PlayerDuplicatesService } from './player-duplicates.service.js';
import { TeamMembership } from './schemas/team-membership.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import {
  CreatePlayerDto,
  CreatePlayerWithCheckDto,
  PlayerQueryDto,
  UpdatePlayerDto,
} from './dto/player.dto.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import { sameId, serialize, toObjectId } from '../../common/utils/serialize.js';
import { escapeRegex } from '../../common/utils/regex.js';
import { todayISODate } from '../../common/utils/dates.js';
import { MembershipsService } from './memberships.service.js';
import { publicPlayer } from '../../common/utils/public.js';
import { TeamRosterStatus, TournamentStatus } from '../../common/enums/index.js';
import { TeamRoster } from '../teams/schemas/team-roster.schema.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ImagesService } from '../media/images.service.js';
import { CloudinaryService, IMAGE_PRESETS } from '../media/cloudinary.service.js';
import type { UploadedImage } from '../media/image-upload.js';

const PLAYER_PHOTO = { url: 'photoUrl', publicId: 'photoPublicId' };

@Injectable()
export class PlayersService {
  constructor(
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamRoster.name) private readonly rosters: Model<TeamRoster>,
    @InjectModel(TeamMembership.name)
    private readonly memberships: Model<TeamMembership>,
    @InjectModel(PlayerMatchStats.name)
    private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Tournament.name)
    private readonly tournaments: Model<Tournament>,
    private readonly membershipsService: MembershipsService,
    private readonly ownership: OwnershipService,
    private readonly tournamentAccess: TournamentAccessService,
    private readonly images: ImagesService,
    private readonly cloudinary: CloudinaryService,
    private readonly duplicates: PlayerDuplicatesService,
  ) {}

  /**
   * Búsqueda pública y global: sirve también para reutilizar identidades existentes.
   * Representación pública (edad, nunca la fecha de nacimiento): ver common/utils/public.ts.
   */
  async findAll(query: PlayerQueryDto) {
    const filter = await this.buildFilter(query);
    const [items, total] = await this.page(filter, query);
    return paginated(items.map((p) => publicPlayer(p)), total, query);
  }

  /**
   * Jugadores relevantes para el panel: los que participan en MIS torneos (los haya creado
   * quien sea) y las fichas que registré yo. `canEdit` indica si puedo editar la ficha maestra.
   */
  async findMine(user: AuthUser, query: PlayerQueryDto) {
    // Torneos propios y aquellos donde colabora (RBAC).
    const myTournaments = [...(await this.tournamentAccess.accessible(user.id)).keys()].map(toObjectId);
    const participants = await this.memberships.distinct('playerId', {
      tournamentId: { $in: myTournaments },
      active: true,
    });
    const filter = {
      ...(await this.buildFilter(query)),
      $or: [{ _id: { $in: participants } }, { createdBy: toObjectId(user.id) }],
    };
    const [items, total] = await this.page(filter, query);
    // La fecha de nacimiento exacta solo la recibe quien registró la ficha; quien la edita por su
    // equipo ve la edad, como el público (el formulario no la envía si no la conoce).
    // canEdit también para los equipos que administro o custodio (ownership.editablePlayerIds).
    const editable = await this.ownership.editablePlayerIds(items.map((p) => p._id), user);
    return paginated(
      items.map((p) => {
        const mine = sameId(p.createdBy, user.id);
        const canEdit = mine || editable.has(p._id.toHexString());
        return { ...publicPlayer(p), canEdit, ...(mine ? { birthDate: p.birthDate } : {}) };
      }),
      total,
      query,
    );
  }

  private async buildFilter(query: PlayerQueryDto) {
    const filter: Record<string, unknown> = {};
    // Cada palabra debe aparecer, en cualquier orden: "juan perez" encuentra también a
    // "Juan Alberto Pérez" (menos duplicados al registrar). Sin coincidencias difusas.
    // Comillas fuera: buscar "Bigotes" (como se muestra el apodo) encuentra a Bigotes.
    const words = query.search ? normalizeSearch(query.search.replace(/["'“”‘’«»]/g, ' ')).split(' ').filter(Boolean) : [];
    if (words.length) filter.$and = words.map((w) => ({ searchName: { $regex: escapeRegex(w) } }));
    if (query.teamId) {
      filter._id = {
        $in: await this.memberships.distinct('playerId', {
          teamId: toObjectId(query.teamId),
          active: true,
        }),
      };
    }
    return filter;
  }

  private page(filter: Record<string, unknown>, query: PlayerQueryDto) {
    return Promise.all([
      this.players
        .find(filter)
        .sort({ lastName: 1, firstName: 1, _id: 1 })
        .skip(skipFor(query))
        .limit(query.limit)
        .lean(),
      this.players.countDocuments(filter),
    ]);
  }

  /**
   * Jugador (representación pública) con sus participaciones actuales e historial en todos
   * los torneos. Actual = participación activa en un torneo NO finalizado; puede haber varias
   * (torneos simultáneos). El perfil completo está en /players/:id/profile.
   */
  async findOne(id: string) {
    const player = await this.players.findById(id).lean();
    if (!player) throw new NotFoundException(`Jugador ${id} no encontrado`);
    const memberships = await this.membershipsService.playerHistory(id);
    return {
      ...publicPlayer(player),
      currentParticipations: memberships.filter(
        (m) => m.active && m.tournament.status !== TournamentStatus.FINISHED,
      ),
      memberships,
    };
  }

  /**
   * POST /players. Antes de crear busca posibles duplicados (nombre y apellidos parecidos): si los
   * hay responde 409 con ellos y NO crea; con `confirmNew` ("ninguno es él") crea igualmente.
   */
  async create(dto: CreatePlayerWithCheckDto, user: AuthUser) {
    assertBirthDate(dto.birthDate);
    await this.duplicates.assertNoneOrConfirmed(dto);
    const created = await this.players.create(newPlayerFields(dto, user));
    return serialize(created.toObject());
  }

  /** Editar la ficha maestra: quien la creó o quien administra su equipo actual (ownership.editablePlayer). */
  async update(id: string, dto: UpdatePlayerDto, user: AuthUser) {
    const current = await this.ownership.editablePlayer(id, user);
    assertBirthDate(dto.birthDate);
    const searchName = playerSearchName({
      firstName: dto.firstName ?? current.firstName,
      lastName: dto.lastName ?? current.lastName,
      nickname: dto.nickname !== undefined ? dto.nickname : current.nickname,
    });
    // Una foto subida a Cloudinary que se sustituye por otra URL (o null) deja de ser nuestra: se borra.
    const replacesUpload = dto.photoUrl !== undefined && dto.photoUrl !== current.photoUrl;
    const updated = await this.players
      .findByIdAndUpdate(id, { ...dto, searchName, ...(replacesUpload ? { photoPublicId: null } : {}) }, { new: true, runValidators: true })
      .lean();
    if (replacesUpload) await this.cloudinary.destroy(current.photoPublicId);
    return serialize(updated!);
  }

  /** PUT /players/:id/photo — sube (o reemplaza) la foto en Cloudinary. Mismo permiso que editar la ficha. */
  async setPhoto(id: string, file: UploadedImage | undefined, user: AuthUser) {
    await this.ownership.editablePlayer(id, user);
    await this.images.replace(this.players, id, PLAYER_PHOTO, file, IMAGE_PRESETS.playerPhoto);
    return serialize((await this.players.findById(id).lean())!);
  }

  /** DELETE /players/:id/photo — quita la foto (y la borra de Cloudinary si se subió aquí). */
  async removePhoto(id: string, user: AuthUser) {
    await this.ownership.editablePlayer(id, user);
    await this.images.remove(this.players, id, PLAYER_PHOTO);
    return serialize((await this.players.findById(id).lean())!);
  }

  /**
   * Solo se borra una ficha sin historia: sin partidos y sin participaciones en torneos
   * ajenos (borrarla destruiría la plantilla de otro organizador).
   */
  async remove(id: string, user: AuthUser) {
    const current = await this.ownership.player(id, user);
    const playerId = toObjectId(id);
    if (await this.stats.exists({ playerId })) {
      throw new ConflictException('El jugador tiene partidos registrados y no puede eliminarse');
    }
    const tournamentIds: Types.ObjectId[] = await this.memberships.distinct('tournamentId', { playerId });
    // Un torneo finalizado es historial: su plantilla no se altera ni borrando la ficha.
    if (await this.tournaments.exists({ _id: { $in: tournamentIds }, status: TournamentStatus.FINISHED })) {
      throw new ConflictException('El jugador forma parte de un torneo finalizado y no puede eliminarse');
    }
    const foreign = await this.tournaments.exists({
      _id: { $in: tournamentIds },
      organizerId: { $ne: toObjectId(user.id) },
    });
    if (foreign) {
      throw new ConflictException('El jugador participa en torneos de otros organizadores y no puede eliminarse');
    }
    // Pertenece a la plantilla GLOBAL de algún equipo: borrar la ficha dejaría ese equipo sin
    // explicación. Primero deben retirarlo (sus OWNER/MANAGER).
    if (await this.rosters.exists({ playerId, status: TeamRosterStatus.ACTIVE })) {
      throw new ConflictException('El jugador está en la plantilla de un equipo y no puede eliminarse');
    }
    await this.memberships.deleteMany({ playerId });
    await this.rosters.deleteMany({ playerId });
    await this.players.deleteOne({ _id: playerId });
    await this.cloudinary.destroy(current.photoPublicId);
  }
}

/**
 * Campos de una ficha nueva: única fuente de las reglas de alta (fecha no futura, nombre de
 * búsqueda, `createdBy` = quien la registra). La usan POST /players y el alta desde la plantilla
 * global del equipo (TeamRosterService).
 */
export function newPlayerFields(dto: CreatePlayerDto & { confirmNew?: boolean }, user: AuthUser) {
  assertBirthDate(dto.birthDate);
  const { confirmNew: _confirmNew, ...fields } = dto;
  return {
    ...fields,
    createdBy: toObjectId(user.id),
    searchName: playerSearchName(dto),
  };
}

function assertBirthDate(birthDate: string | null | undefined) {
  if (birthDate && birthDate > todayISODate()) {
    throw new BadRequestException('birthDate no puede ser una fecha futura');
  }
}
