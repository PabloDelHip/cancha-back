import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Team } from '../../modules/teams/schemas/team.schema.js';
import { TeamAdmin } from '../../modules/teams/schemas/team-admin.schema.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';
import { TeamAdminRole, TeamAdminStatus } from '../enums/index.js';
import { toObjectId } from '../utils/serialize.js';

/**
 * Nivel de acceso de un usuario a la identidad GLOBAL de un Team (nunca a su participación en
 * torneos, que controla el organizador de cada torneo vía OwnershipService):
 *
 * - OWNER: todo (identidad completa, borrar sin historia, administrar MANAGERS).
 * - MANAGER: presentación del equipo (MANAGER_EDITABLE_FIELDS). No administra roles.
 * - CUSTODIAN: quien registró la ficha (`createdBy`) y SOLO mientras el equipo no tiene OWNER.
 *   Es la custodia provisional de V1 (un organizador que dio de alta el equipo puede corregir una
 *   errata); no es propiedad: no administra roles y la pierde en cuanto hay OWNER.
 * - null: nada.
 */
export type TeamAccessLevel = TeamAdminRole | 'CUSTODIAN';

/** Lo que un MANAGER puede cambiar. Nombre y abreviatura (identidad) quedan para OWNER/custodio. */
export const MANAGER_EDITABLE_FIELDS = ['logoUrl', 'colors', 'city'] as const;

const ACTIVE = TeamAdminStatus.ACTIVE;

/**
 * Pregunta única "¿puede este usuario administrar este Team?" para 6A y las etapas siguientes
 * (plantilla global, inscripciones, publicaciones). Devuelve el recurso o lanza 404/403, como
 * OwnershipService, para que los services no repitan comprobaciones.
 */
@Injectable()
export class TeamAccessService {
  constructor(
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(TeamAdmin.name) private readonly admins: Model<TeamAdmin>,
  ) {}

  /** Rol ACTIVO del usuario en el equipo (o null). */
  async roleOf(teamId: string | Types.ObjectId, userId: string): Promise<TeamAdminRole | null> {
    const row = await this.admins
      .findOne({ teamId: toObjectId(teamId), userId: toObjectId(userId), status: ACTIVE })
      .select('role')
      .lean();
    return row?.role ?? null;
  }

  async isTeamOwner(teamId: string | Types.ObjectId, userId: string) {
    return (await this.roleOf(teamId, userId)) === TeamAdminRole.OWNER;
  }

  async isTeamManager(teamId: string | Types.ObjectId, userId: string) {
    return (await this.roleOf(teamId, userId)) === TeamAdminRole.MANAGER;
  }

  /** OWNER o MANAGER activo. (El custodio NO administra el equipo.) */
  async canManageTeam(teamId: string | Types.ObjectId, userId: string) {
    return (await this.roleOf(teamId, userId)) !== null;
  }

  async hasOwner(teamId: string | Types.ObjectId) {
    return !!(await this.admins.exists({ teamId: toObjectId(teamId), role: TeamAdminRole.OWNER, status: ACTIVE }));
  }

  /** Equipo + nivel de acceso del usuario. 404 si el equipo no existe. */
  async access(teamId: string | Types.ObjectId, user: AuthUser) {
    const team = await this.teams.findById(teamId).lean();
    if (!team) throw new NotFoundException(`Equipo ${teamId} no encontrado`);
    const role = await this.roleOf(team._id, user.id);
    if (role) return { team, level: role as TeamAccessLevel };
    const custodian = team.createdBy?.toHexString() === user.id && !(await this.hasOwner(team._id));
    return { team, level: custodian ? ('CUSTODIAN' as const) : null };
  }

  /** Nivel de acceso a muchos equipos con 2 consultas (listados del panel). */
  async accessMany(teams: { _id: Types.ObjectId; createdBy: Types.ObjectId | null }[], user: AuthUser) {
    const ids = teams.map((t) => t._id);
    const rows = await this.admins
      .find({ teamId: { $in: ids }, status: ACTIVE, $or: [{ userId: toObjectId(user.id) }, { role: TeamAdminRole.OWNER }] })
      .select('teamId userId role')
      .lean();
    const mine = new Map(rows.filter((r) => r.userId.toHexString() === user.id).map((r) => [r.teamId.toHexString(), r.role]));
    const owned = new Set(rows.filter((r) => r.role === TeamAdminRole.OWNER).map((r) => r.teamId.toHexString()));
    return new Map(
      teams.map((t) => {
        const id = t._id.toHexString();
        const level: TeamAccessLevel | null =
          mine.get(id) ?? (t.createdBy?.toHexString() === user.id && !owned.has(id) ? 'CUSTODIAN' : null);
        return [id, level];
      }),
    );
  }

  /** OWNER o MANAGER (p. ej. ver administradores; en 6B, plantilla global). */
  async requireManager(teamId: string, user: AuthUser) {
    const { team, level } = await this.access(teamId, user);
    if (level !== TeamAdminRole.OWNER && level !== TeamAdminRole.MANAGER) {
      throw new ForbiddenException('Solo el OWNER o un MANAGER del equipo pueden hacer esto');
    }
    return { team, role: level };
  }

  /** Solo el OWNER (administrar MANAGERS). */
  async requireOwner(teamId: string, user: AuthUser) {
    const { team, level } = await this.access(teamId, user);
    if (level !== TeamAdminRole.OWNER) throw new ForbiddenException('Solo el OWNER del equipo puede hacer esto');
    return team;
  }

  /** Editar la ficha global: OWNER y custodio todo; MANAGER solo MANAGER_EDITABLE_FIELDS. */
  async requireIdentityEdit(teamId: string, user: AuthUser, fields: string[]) {
    const { team, level } = await this.access(teamId, user);
    if (!level) throw new ForbiddenException('No administras este equipo');
    if (level === TeamAdminRole.MANAGER) {
      const blocked = fields.filter((f) => !(MANAGER_EDITABLE_FIELDS as readonly string[]).includes(f));
      if (blocked.length) throw new ForbiddenException(`Un MANAGER no puede cambiar: ${blocked.join(', ')} (solo el OWNER)`);
    }
    return team;
  }

  /** Borrar la ficha (solo sin historia, lo decide TeamsService): OWNER o custodio. */
  async requireDelete(teamId: string, user: AuthUser) {
    const { team, level } = await this.access(teamId, user);
    if (level !== TeamAdminRole.OWNER && level !== 'CUSTODIAN') {
      throw new ForbiddenException('Solo el OWNER del equipo (o quien lo registró, si aún no tiene OWNER) puede eliminarlo');
    }
    return team;
  }
}
