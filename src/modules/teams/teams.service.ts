import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Team } from './schemas/team.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Tournament, withCoverage } from '../tournaments/schemas/tournament.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { MatchStatus, TournamentStatus } from '../../common/enums/index.js';
import { CreateTeamDto, TeamQueryDto, UpdateTeamDto } from './dto/team.dto.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { escapeRegex } from '../../common/utils/regex.js';
import { TeamAccessService } from '../../common/authorization/team-access.service.js';
import { TeamAdmin } from './schemas/team-admin.schema.js';
import { TeamRoster } from './schemas/team-roster.schema.js';
import { TeamAdminStatus, TeamRosterStatus } from '../../common/enums/index.js';
import { MembershipsService } from '../players/memberships.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ImagesService } from '../media/images.service.js';
import { CloudinaryService, IMAGE_PRESETS } from '../media/cloudinary.service.js';
import type { UploadedImage } from '../media/image-upload.js';

const TEAM_LOGO = { url: 'logoUrl', publicId: 'logoPublicId' };
const TEAM_COVER = { url: 'coverUrl', publicId: 'coverPublicId' };

@Injectable()
export class TeamsService {
  constructor(
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(TournamentTeam.name)
    private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Tournament.name)
    private readonly tournaments: Model<Tournament>,
    @InjectModel(TeamMembership.name)
    private readonly memberships: Model<TeamMembership>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(TeamAdmin.name) private readonly admins: Model<TeamAdmin>,
    @InjectModel(TeamRoster.name) private readonly rosters: Model<TeamRoster>,
    private readonly membershipsService: MembershipsService,
    private readonly access: TeamAccessService,
    private readonly images: ImagesService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  async findAll(query: TeamQueryDto) {
    return this.list(await this.buildFilter(query), query);
  }

  /**
   * Equipos relevantes para el panel: los inscritos en MIS torneos (los haya creado quien sea),
   * los que administro (OWNER/MANAGER) y las fichas que registré yo.
   * - `myRole`: OWNER | MANAGER | null (rol global en el equipo).
   * - `canEdit`: puedo editar su ficha global (OWNER, MANAGER parcial, o custodio sin OWNER).
   * Estar inscrito en mi torneo NO da `canEdit`: organizar no es administrar el equipo.
   */
  async findMine(user: AuthUser, query: TeamQueryDto) {
    const me = toObjectId(user.id);
    const [myTournaments, administered] = await Promise.all([
      this.tournaments.distinct('_id', { organizerId: me }) as Promise<Types.ObjectId[]>,
      this.admins.distinct('teamId', { userId: me, status: TeamAdminStatus.ACTIVE }) as Promise<Types.ObjectId[]>,
    ]);
    const enrolled = await this.enrollments.distinct('teamId', { tournamentId: { $in: myTournaments } });
    const filter = {
      ...(await this.buildFilter(query)),
      $or: [{ _id: { $in: [...enrolled, ...administered] } }, { createdBy: me }],
    };
    const [items, total] = await this.page(filter, query);
    const [levels, sizes] = await Promise.all([
      this.access.accessMany(items, user),
      // Jugadores en la plantilla GLOBAL actual de cada equipo (una agregación, sin N+1).
      this.rosters.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { teamId: { $in: items.map((t) => t._id) }, status: TeamRosterStatus.ACTIVE } },
        { $group: { _id: '$teamId', n: { $sum: 1 } } },
      ]),
    ]);
    const size = new Map(sizes.map((s) => [s._id.toHexString(), s.n]));
    return paginated(
      items.map((t) => {
        const level = levels.get(t._id.toHexString()) ?? null;
        return {
          ...serialize(t),
          myRole: level === 'CUSTODIAN' ? null : level,
          canEdit: level !== null,
          globalRosterSize: size.get(t._id.toHexString()) ?? 0,
        };
      }),
      total,
      query,
    );
  }

  /**
   * Ficha del equipo: datos, plantillas actuales POR TORNEO (torneos no finalizados), torneos y
   * partidos recientes. El perfil histórico completo está en GET /teams/:id/profile.
   */
  async findOne(id: string) {
    const team = await this.teams.findById(id).lean();
    if (!team) throw new NotFoundException(`Equipo ${id} no encontrado`);
    const teamId = toObjectId(id);
    const tournamentIds = await this.enrollments.distinct('tournamentId', {
      teamId,
    });
    const plays = { $or: [{ homeTeamId: teamId }, { awayTeamId: teamId }] };
    const [tournaments, recentMatches, upcomingMatches] = await Promise.all([
      this.tournaments
        .find({ _id: { $in: tournamentIds } })
        .sort({ startDate: -1 })
        .lean(),
      this.matches
        .find({ ...plays, status: MatchStatus.FINISHED })
        .sort({ date: -1, time: -1 })
        .limit(5)
        .lean(),
      this.matches
        .find({
          ...plays,
          status: { $in: [MatchStatus.SCHEDULED, MatchStatus.LIVE] },
        })
        .sort({ date: 1, time: 1 })
        .limit(3)
        .lean(),
    ]);
    const current = tournaments.filter((t) => t.status !== TournamentStatus.FINISHED).map((t) => t._id);
    return {
      ...serialize(team),
      currentRosters: await this.membershipsService.rostersByTournament(id, current),
      tournaments: serialize(tournaments.map(withCoverage)),
      recentMatches: serialize(recentMatches),
      upcomingMatches: serialize(upcomingMatches),
    };
  }

  async create(dto: CreateTeamDto, user: AuthUser) {
    const created = await this.teams.create({
      ...dto,
      shortName: dto.shortName ?? deriveShortName(dto.name),
      createdBy: toObjectId(user.id),
    });
    return serialize(created.toObject());
  }

  /** Ficha global: OWNER/custodio todo; MANAGER solo presentación (ver TeamAccessService). */
  async update(id: string, dto: UpdateTeamDto, user: AuthUser) {
    const current = await this.access.requireIdentityEdit(id, user, Object.keys(dto));
    // Un logo subido a Cloudinary que se sustituye por otra URL (o null) deja de ser nuestro: se borra.
    const replacesUpload = dto.logoUrl !== undefined && dto.logoUrl !== current.logoUrl;
    const updated = await this.teams
      .findByIdAndUpdate(id, { ...dto, ...(replacesUpload ? { logoPublicId: null } : {}) }, { new: true, runValidators: true })
      .lean();
    if (replacesUpload) await this.cloudinary.destroy(current.logoPublicId);
    return serialize(updated!);
  }

  /**
   * PUT /teams/:id/logo — sube (o reemplaza) el logo en Cloudinary. Mismo permiso que cambiar
   * `logoUrl` por PATCH: OWNER, MANAGER (campo de presentación) o custodio sin OWNER.
   */
  async setLogo(id: string, file: UploadedImage | undefined, user: AuthUser) {
    await this.access.requireIdentityEdit(id, user, ['logoUrl']);
    await this.images.replace(this.teams, id, TEAM_LOGO, file, IMAGE_PRESETS.teamLogo);
    return serialize((await this.teams.findById(id).lean())!);
  }

  /**
   * PUT /teams/:id/cover — sube (o reemplaza) la foto de portada. Mismo permiso que el logo
   * (OWNER, MANAGER o custodio sin OWNER). Una foto nueva empieza centrada.
   */
  async setCover(id: string, file: UploadedImage | undefined, user: AuthUser) {
    await this.access.requireIdentityEdit(id, user, ['coverUrl']);
    await this.images.replace(this.teams, id, TEAM_COVER, file, IMAGE_PRESETS.teamCover);
    await this.teams.updateOne({ _id: toObjectId(id) }, { $set: { coverPosition: { x: 50, y: 50 } } });
    return serialize((await this.teams.findById(id).lean())!);
  }

  /** DELETE /teams/:id/cover — quita la portada: vuelve el diseño de siempre. */
  async removeCover(id: string, user: AuthUser) {
    await this.access.requireIdentityEdit(id, user, ['coverUrl']);
    await this.images.remove(this.teams, id, TEAM_COVER);
    await this.teams.updateOne({ _id: toObjectId(id) }, { $set: { coverPosition: { x: 50, y: 50 } } });
    return serialize((await this.teams.findById(id).lean())!);
  }

  /** DELETE /teams/:id/logo — quita el logo (y lo borra de Cloudinary si se subió aquí). */
  async removeLogo(id: string, user: AuthUser) {
    await this.access.requireIdentityEdit(id, user, ['logoUrl']);
    await this.images.remove(this.teams, id, TEAM_LOGO);
    return serialize((await this.teams.findById(id).lean())!);
  }

  /**
   * Solo se elimina un equipo sin historia: sin partidos y sin jugadores (actuales o pasados).
   * Sus inscripciones a torneos (sin partidos) se eliminan con él.
   */
  async remove(id: string, user: AuthUser) {
    const current = await this.access.requireDelete(id, user);
    const teamId = toObjectId(id);
    if (
      await this.matches.exists({
        $or: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
      })
    ) {
      throw new ConflictException(
        'El equipo tiene partidos registrados y no puede eliminarse',
      );
    }
    if (await this.memberships.exists({ teamId })) {
      throw new ConflictException(
        'El equipo tiene (o tuvo) jugadores registrados y no puede eliminarse',
      );
    }
    // Inscrito en torneos de otros organizadores: borrarlo alteraría torneos ajenos.
    const tournamentIds = await this.enrollments.distinct('tournamentId', { teamId });
    if (await this.tournaments.exists({ _id: { $in: tournamentIds }, status: TournamentStatus.FINISHED })) {
      throw new ConflictException('El equipo forma parte de un torneo finalizado y no puede eliminarse');
    }
    if (await this.tournaments.exists({ _id: { $in: tournamentIds }, organizerId: { $ne: toObjectId(user.id) } })) {
      throw new ConflictException('El equipo está inscrito en torneos de otros organizadores y no puede eliminarse');
    }
    // Con jugadores en su plantilla global: primero hay que retirarlos (decisión explícita del OWNER).
    if (await this.rosters.exists({ teamId, status: TeamRosterStatus.ACTIVE })) {
      throw new ConflictException('El equipo tiene jugadores en su plantilla: retíralos antes de eliminarlo');
    }
    await this.enrollments.deleteMany({ teamId });
    // Tampoco queda como equipo en seguimiento de esos torneos (6G).
    await this.tournaments.updateMany({ _id: { $in: tournamentIds } }, { $pull: { trackedTeamIds: teamId } });
    await this.admins.deleteMany({ teamId });
    await this.rosters.deleteMany({ teamId });
    await this.teams.deleteOne({ _id: teamId });
    await this.cloudinary.destroy(current.logoPublicId);
    await this.cloudinary.destroy(current.coverPublicId);
  }

  private async buildFilter(query: TeamQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.search?.trim())
      filter.name = { $regex: escapeRegex(query.search.trim()), $options: 'i' };
    if (query.tournamentId) {
      filter._id = {
        $in: await this.enrollments.distinct('teamId', {
          tournamentId: toObjectId(query.tournamentId),
        }),
      };
    }
    return filter;
  }

  private async list(filter: Record<string, unknown>, query: TeamQueryDto) {
    const [items, total] = await this.page(filter, query);
    return paginated(serialize(items), total, query);
  }

  private page(filter: Record<string, unknown>, query: TeamQueryDto) {
    return Promise.all([
      this.teams
        .find(filter)
        .sort({ name: 1, _id: 1 })
        .skip(skipFor(query))
        .limit(query.limit)
        .lean(),
      this.teams.countDocuments(filter),
    ]);
  }
}

/** "Halcones FC" → "HAL" */
export function deriveShortName(name: string): string {
  const cleaned = name
    .replace(/\b(FC|CF|Club|Deportivo|de|del|la|los)\b/gi, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return (cleaned || name.replace(/[^\p{L}\p{N}]/gu, '') || 'EQ')
    .slice(0, 3)
    .toUpperCase()
    .padEnd(2, 'X');
}
