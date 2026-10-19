import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Tournament } from '../../modules/tournaments/schemas/tournament.schema.js';
import { TournamentMember } from '../../modules/tournaments/schemas/tournament-member.schema.js';
import { TournamentMemberStatus, TournamentStatus } from '../enums/index.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';
import { can, type AccessRole, type Permission } from './permissions.js';


/**
 * "¿Qué rol tiene este usuario en este torneo y puede hacer X?" (RBAC). Una consulta indexada por
 * petición; los permisos no viajan en el JWT, así una revocación surte efecto de inmediato. Con
 * `session`, la comprobación se hace dentro de la transacción (ver OwnershipService.inTournament).
 */
@Injectable()
export class TournamentAccessService {
  constructor(
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentMember.name) private readonly members: Model<TournamentMember>,
  ) {}

  async roleIn(tournament: { _id: Types.ObjectId; organizerId: Types.ObjectId }, userId: string, session: ClientSession | null = null): Promise<AccessRole | null> {
    if (tournament.organizerId.equals(userId)) return 'OWNER';
    const member = await this.members
      .findOne({ tournamentId: tournament._id, userId: new Types.ObjectId(userId), status: TournamentMemberStatus.ACTIVE })
      .select('role')
      .session(session)
      .lean();
    return member?.role ?? null;
  }

  /** Rol por id de torneo (null si no existe o no tiene acceso). */
  async roleOf(tournamentId: string | Types.ObjectId, userId: string, session: ClientSession | null = null) {
    const t = await this.tournaments.findById(tournamentId).select('organizerId').session(session).lean();
    return t ? this.roleIn(t, userId, session) : null;
  }

  /** Lanza 403 si el rol no tiene el permiso. Sin ningún acceso, 403 genérico (sin revelar más). */
  assert(role: AccessRole | null, permission: Permission) {
    if (!role) throw new ForbiddenException('No tienes permiso para administrar este torneo');
    if (!can(role, permission)) throw new ForbiddenException(`Tu rol en este torneo no permite esta acción (${permission})`);
  }

  /** Carga el torneo y exige el permiso. 404 si no existe. */
  async require(tournamentId: string | Types.ObjectId, userId: string, permission: Permission, session: ClientSession | null = null) {
    const tournament = await this.tournaments.findById(tournamentId).session(session).lean();
    if (!tournament) throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);
    const role = await this.roleIn(tournament, userId, session);
    this.assert(role, permission);
    return { tournament, role: role! };
  }

  /** Torneos donde el usuario tiene acceso (propios + colaboraciones activas), con su rol. */
  async accessible(userId: string): Promise<Map<string, AccessRole>> {
    const me = new Types.ObjectId(userId);
    const [owned, member] = await Promise.all([
      this.tournaments.distinct('_id', { organizerId: me }) as Promise<Types.ObjectId[]>,
      this.members.find({ userId: me, status: TournamentMemberStatus.ACTIVE }).select('tournamentId role').lean(),
    ]);
    const out = new Map<string, AccessRole>(member.map((m) => [m.tournamentId.toHexString(), m.role]));
    for (const id of owned) out.set(id.toHexString(), 'OWNER');
    return out;
  }

  // ─── 5B (D4): visibilidad pública de los torneos en borrador ───────────────

  /**
   * Torneos en BORRADOR que este visitante no puede ver (todos, si es anónimo). Un borrador solo lo
   * ven su propietario y sus colaboradores activos; iniciado (ACTIVE) o finalizado es público. Las
   * lecturas públicas excluyen estos ids (`$nin`); son pocos (los borradores en preparación).
   */
  async hiddenDrafts(viewer: AuthUser | null): Promise<Types.ObjectId[]> {
    const drafts = await this.tournaments.find({ status: TournamentStatus.DRAFT }).select('_id organizerId').lean();
    if (!viewer || !drafts.length) return drafts.map((t) => t._id);
    const me = new Types.ObjectId(viewer.id);
    const member = new Set(
      (await this.members.distinct('tournamentId', { userId: me, status: TournamentMemberStatus.ACTIVE, tournamentId: { $in: drafts.map((t) => t._id) } })).map(String),
    );
    return drafts.filter((t) => !t.organizerId.equals(me) && !member.has(String(t._id))).map((t) => t._id);
  }

  /** ¿Puede este visitante ver el torneo? (existe y, si es borrador, es propietario o colaborador). */
  async isVisible(tournamentId: string | Types.ObjectId, viewer: AuthUser | null): Promise<boolean> {
    const t = await this.tournaments.findById(tournamentId).select('status organizerId').lean();
    if (!t) return false;
    if (t.status !== TournamentStatus.DRAFT) return true;
    return viewer ? (await this.roleIn(t, viewer.id)) !== null : false;
  }

  /** 404 (como si no existiera, sin revelar que hay un borrador) si el visitante no puede verlo. */
  async assertVisible(tournamentId: string | Types.ObjectId, viewer: AuthUser | null) {
    if (!(await this.isVisible(tournamentId, viewer))) throw new NotFoundException(`Torneo ${String(tournamentId)} no encontrado`);
  }
}
