import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { TournamentMember } from './schemas/tournament-member.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { TournamentMemberStatus } from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { can, MAX_TOURNAMENT_MEMBERS, Permission } from '../../common/authorization/permissions.js';
import { toObjectId } from '../../common/utils/serialize.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { UpdateTournamentMemberDto } from './dto/tournament-member.dto.js';

const ACTIVE = TournamentMemberStatus.ACTIVE;

/**
 * Colaboradores de un torneo (RBAC). Se agregan aceptando una invitación (R2). Solo el propietario los administra (Permission.MEMBERS).
 * Cada cambio toma el cerrojo del torneo (también si está finalizado: retirar un acceso siempre
 * debe poder hacerse) y revalida el permiso dentro de la transacción. El propietario no tiene
 * fila y no puede agregarse, cambiarse ni revocarse. Nada se borra: revocar o cambiar de rol deja
 * la fila anterior REVOKED.
 */
@Injectable()
export class TournamentMembersService {
  constructor(
    @InjectModel(TournamentMember.name) private readonly members: Model<TournamentMember>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
  ) {}

  /** Colaboradores activos. El correo solo lo ve quien los administra (el propietario). */
  async list(tournamentId: string, user: AuthUser) {
    const { tournament, role } = await this.access.require(tournamentId, user.id, Permission.VIEW);
    const rows = await this.members.find({ tournamentId: tournament._id, status: ACTIVE }).sort({ createdAt: 1 }).lean();
    const people = await this.users.find({ _id: { $in: [tournament.organizerId, ...rows.map((r) => r.userId)] } }).select('firstName lastName email').lean();
    const byId = new Map(people.map((p) => [p._id.toHexString(), p]));
    const showEmail = can(role, Permission.MEMBERS);
    const person = (id: Types.ObjectId) => {
      const p = byId.get(id.toHexString());
      return { userId: id.toHexString(), name: p ? `${p.firstName} ${p.lastName}`.trim() : null, ...(showEmail ? { email: p?.email ?? null } : {}) };
    };
    return {
      owner: person(tournament.organizerId),
      members: rows.map((r) => ({ ...person(r.userId), role: r.role, since: r.createdAt })),
      limit: MAX_TOURNAMENT_MEMBERS,
    };
  }

  /** Cambiar de rol: la fila anterior queda REVOKED y se crea otra (auditoría completa). */
  async update(tournamentId: string, userId: string, dto: UpdateTournamentMemberDto, user: AuthUser) {
    await this.write(tournamentId, user, async (session, tournament) => {
      const current = await this.active(tournament._id, userId, session);
      if (current.role === dto.role) return;
      await this.revokeRow(current._id, user, session);
      await this.members.create([{ tournamentId: tournament._id, userId: current.userId, role: dto.role, invitedBy: toObjectId(user.id) }], { session });
    });
    return this.list(tournamentId, user);
  }

  async revoke(tournamentId: string, userId: string, user: AuthUser) {
    await this.write(tournamentId, user, async (session, tournament) => {
      const current = await this.active(tournament._id, userId, session);
      await this.revokeRow(current._id, user, session);
    });
    return this.list(tournamentId, user);
  }

  private async write(tournamentId: string, user: AuthUser, fn: (session: ClientSession, tournament: { _id: Types.ObjectId; organizerId: Types.ObjectId }) => Promise<void>) {
    await this.access.require(tournamentId, user.id, Permission.MEMBERS);
    await this.connection.transaction(async (session) => {
      // Mismo cerrojo que las escrituras del torneo: una operación del colaborador que se cruce
      // con su revocación se reintenta y ya no tiene acceso.
      const tournament = await this.ownership.lockAny(tournamentId, session);
      await this.access.require(tournamentId, user.id, Permission.MEMBERS, session);
      await fn(session, tournament);
    });
  }

  private async active(tournamentId: Types.ObjectId, userId: string, session: ClientSession) {
    if (!Types.ObjectId.isValid(userId)) throw new NotFoundException('Colaborador no encontrado');
    const row = await this.members.findOne({ tournamentId, userId: toObjectId(userId), status: ACTIVE }).session(session).lean();
    if (!row) throw new NotFoundException('Colaborador no encontrado (el propietario no se puede cambiar ni revocar)');
    return row;
  }

  private async revokeRow(id: Types.ObjectId, user: AuthUser, session: ClientSession) {
    await this.members.updateOne({ _id: id, status: ACTIVE }, { $set: { status: TournamentMemberStatus.REVOKED, revokedBy: toObjectId(user.id), revokedAt: new Date() } }, { session });
  }
}


