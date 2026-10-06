import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { TeamAdmin } from './schemas/team-admin.schema.js';
import { Team } from './schemas/team.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { TeamAdminRole, TeamAdminSource, TeamAdminStatus } from '../../common/enums/index.js';
import { TeamAccessService } from '../../common/authorization/team-access.service.js';
import { toObjectId } from '../../common/utils/serialize.js';
import { normalizeEmail } from '../users/users.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { AddManagerDto } from './dto/team-admin.dto.js';

const ACTIVE = TeamAdminStatus.ACTIVE;
const isDuplicateKey = (e: unknown) => e instanceof mongo.MongoServerError && e.code === 11000;

/** Administrador tal como lo ve otro administrador: nombre y rol, nunca email ni datos de cuenta. */
export interface TeamAdminView {
  userId: string;
  firstName: string;
  lastName: string;
  role: TeamAdminRole;
  since: Date;
}

/**
 * Roles globales de un Team (OWNER / MANAGER). Las comprobaciones de permiso son de
 * TeamAccessService; las invariantes (un OWNER, sin duplicados) las garantizan los índices
 * únicos parciales de TeamAdmin: aquí se traduce el choque a 409 o se resuelve idempotente.
 */
@Injectable()
export class TeamAdminsService {
  constructor(
    @InjectModel(TeamAdmin.name) private readonly admins: Model<TeamAdmin>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectConnection() private readonly connection: Connection,
    private readonly access: TeamAccessService,
  ) {}

  /** GET /teams/:id/admins — solo OWNER o MANAGER del equipo. */
  async list(teamId: string, user: AuthUser) {
    await this.access.requireManager(teamId, user);
    return this.view(teamId);
  }

  /**
   * POST /teams/:id/managers — solo el OWNER. Idempotente: si ya es MANAGER activo devuelve el
   * mismo estado (`created: false`). Dos altas simultáneas del mismo usuario: una inserta y la otra
   * choca con el índice único y termina igual de idempotente.
   */
  async addManager(teamId: string, dto: AddManagerDto, user: AuthUser) {
    await this.access.requireOwner(teamId, user);
    const target = await this.resolveUser(dto);
    const team = toObjectId(teamId);
    const current = await this.admins.findOne({ teamId: team, userId: target._id, status: ACTIVE }).lean();
    if (current?.role === TeamAdminRole.OWNER) throw new ConflictException('Ese usuario ya es el OWNER del equipo');
    let created = false;
    if (!current) {
      try {
        await this.admins.create({
          teamId: team,
          userId: target._id,
          role: TeamAdminRole.MANAGER,
          status: ACTIVE,
          source: TeamAdminSource.OWNER,
          grantedBy: toObjectId(user.id),
        });
        created = true;
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;
        // Alguien lo dio de alta a la vez: vale si quedó como MANAGER.
        const now = await this.admins.findOne({ teamId: team, userId: target._id, status: ACTIVE }).lean();
        if (now?.role !== TeamAdminRole.MANAGER) throw new ConflictException('Ese usuario ya es el OWNER del equipo');
      }
    }
    return { created, admins: await this.view(teamId) };
  }

  /** DELETE /teams/:id/managers/:userId — solo el OWNER. Baja lógica (auditoría). */
  async removeManager(teamId: string, userId: string, user: AuthUser) {
    await this.access.requireOwner(teamId, user);
    const res = await this.admins.updateOne(
      { teamId: toObjectId(teamId), userId: toObjectId(userId), role: TeamAdminRole.MANAGER, status: ACTIVE },
      { $set: { status: TeamAdminStatus.INACTIVE, revokedAt: new Date(), revokedBy: toObjectId(user.id) } },
    );
    if (!res.modifiedCount) throw new NotFoundException('Ese usuario no es MANAGER activo del equipo');
  }

  /**
   * Asignación INTERNA del OWNER (script administrativo `npm run team:assign-owner`, pruebas).
   * No hay endpoint HTTP: un usuario no puede apropiarse de un equipo sin OWNER. El Claim Flow
   * futuro llamará a esta misma operación tras verificar al solicitante (source CLAIM).
   *
   * - Equipo con OWNER distinto → 409 (el índice único parcial lo garantiza aunque dos
   *   asignaciones corran a la vez: una inserta, la otra recibe duplicate key → 409).
   * - Mismo OWNER → idempotente.
   * - Si el usuario era MANAGER, se promueve en una transacción (baja de MANAGER + alta de
   *   OWNER); si el alta choca, la baja se deshace.
   */
  async assignOwner(teamId: string, userId: string) {
    const team = await this.teams.findById(teamId).select('_id').lean();
    if (!team) throw new NotFoundException(`Equipo ${teamId} no encontrado`);
    const target = await this.users.findById(userId).select('_id').lean();
    if (!target) throw new NotFoundException(`Usuario ${userId} no encontrado`);
    const filter = { teamId: team._id, userId: target._id, status: ACTIVE };
    try {
      await this.connection.transaction(async (session) => {
        const current = await this.admins.findOne(filter).session(session).lean();
        if (current?.role === TeamAdminRole.OWNER) return;
        if (current) {
          await this.admins.updateOne(
            { _id: current._id },
            { $set: { status: TeamAdminStatus.INACTIVE, revokedAt: new Date(), revokedBy: null } },
            { session },
          );
        }
        await this.admins.create(
          [{ teamId: team._id, userId: target._id, role: TeamAdminRole.OWNER, status: ACTIVE, source: TeamAdminSource.INTERNAL, grantedBy: null }],
          { session },
        );
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new ConflictException('El equipo ya tiene un OWNER activo');
      throw e;
    }
    return this.view(teamId);
  }

  private async resolveUser(dto: AddManagerDto) {
    if (!!dto.userId === !!dto.email) throw new BadRequestException('Indica userId o email (uno de los dos)');
    const target = await this.users
      .findOne(dto.userId ? { _id: toObjectId(dto.userId) } : { email: normalizeEmail(dto.email!) })
      .select('_id')
      .lean();
    if (!target) throw new NotFoundException('No existe una cuenta con esos datos');
    return target as { _id: Types.ObjectId };
  }

  /** OWNER (o null) y MANAGERS activos, con nombre: lo que necesita la pantalla de administración. */
  private async view(teamId: string) {
    const rows = await this.admins.find({ teamId: toObjectId(teamId), status: ACTIVE }).sort({ createdAt: 1 }).lean();
    const users = await this.users
      .find({ _id: { $in: rows.map((r) => r.userId) } })
      .select('firstName lastName')
      .lean();
    const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
    const toView = (r: (typeof rows)[number]): TeamAdminView => ({
      userId: r.userId.toHexString(),
      firstName: byId.get(r.userId.toHexString())?.firstName ?? '',
      lastName: byId.get(r.userId.toHexString())?.lastName ?? '',
      role: r.role,
      since: r.createdAt,
    });
    const owner = rows.find((r) => r.role === TeamAdminRole.OWNER);
    return {
      teamId,
      owner: owner ? toView(owner) : null,
      managers: rows.filter((r) => r.role === TeamAdminRole.MANAGER).map(toView),
    };
  }
}
