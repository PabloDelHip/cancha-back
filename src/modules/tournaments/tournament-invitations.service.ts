import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { TournamentInvitation } from './schemas/tournament-invitation.schema.js';
import { TournamentMember } from './schemas/tournament-member.schema.js';
import { Tournament } from './schemas/tournament.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { normalizeEmail } from '../users/users.service.js';
import { InvitationKind, InvitationStatus, TournamentMemberStatus } from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { MAX_TOURNAMENT_MEMBERS, Permission } from '../../common/authorization/permissions.js';
import { toObjectId } from '../../common/utils/serialize.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { CreateInvitationDto } from './dto/tournament-member.dto.js';

export const INVITATION_DAYS = 7;
/** Invitaciones pendientes por torneo (además del límite de frecuencia por IP). */
export const MAX_PENDING_INVITATIONS = 50;
const PENDING = InvitationStatus.PENDING;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
type Inv = TournamentInvitation & { _id: Types.ObjectId };

/**
 * Invitaciones a colaborar (RBAC R2). Solo el propietario invita y revoca (Permission.MEMBERS).
 * - LINK: token aleatorio de 192 bits; se guarda solo su sha256 y se muestra una vez.
 * - ACCOUNT: por correo. La respuesta es idéntica exista o no la cuenta (ni siquiera se consulta);
 *   la ve y la acepta solo quien inicie sesión con ese correo, ahora o si se registra después.
 * Aceptar es atómico: transacción con el cerrojo del torneo y paso condicional PENDING → ACCEPTED;
 * dos aceptaciones simultáneas no pueden confirmarse ambas.
 */
@Injectable()
export class TournamentInvitationsService {
  constructor(
    @InjectModel(TournamentInvitation.name) private readonly invitations: Model<TournamentInvitation>,
    @InjectModel(TournamentMember.name) private readonly members: Model<TournamentMember>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
  ) {}

  // ─── Propietario ────────────────────────────────────────────────────────────

  async create(tournamentId: string, dto: CreateInvitationDto, user: AuthUser) {
    await this.access.require(tournamentId, user.id, Permission.MEMBERS);
    let token: string | null = null;
    const created = await this.connection.transaction(async (session) => {
      await this.ownership.lockAny(tournamentId, session);
      await this.access.require(tournamentId, user.id, Permission.MEMBERS, session);
      const tid = toObjectId(tournamentId);
      const now = new Date();
      if (dto.kind === InvitationKind.ACCOUNT) {
        const email = normalizeEmail(dto.email!);
        // Idempotente: la misma invitación pendiente no se duplica (y la respuesta no cambia).
        const existing = await this.invitations.findOne({ tournamentId: tid, kind: InvitationKind.ACCOUNT, email, role: dto.role, status: PENDING, expiresAt: { $gt: now } }).session(session).lean();
        if (existing) return existing;
      }
      const pending = await this.invitations.countDocuments({ tournamentId: tid, status: PENDING, expiresAt: { $gt: now } }).session(session);
      if (pending >= MAX_PENDING_INVITATIONS) throw new ConflictException(`Hay ${MAX_PENDING_INVITATIONS} invitaciones pendientes: revoca alguna antes de crear otra`);
      token = dto.kind === InvitationKind.LINK ? randomBytes(24).toString('base64url') : null;
      const [doc] = await this.invitations.create(
        [{
          tournamentId: tid,
          kind: dto.kind,
          role: dto.role,
          tokenHash: token ? hash(token) : null,
          email: dto.kind === InvitationKind.ACCOUNT ? normalizeEmail(dto.email!) : null,
          expiresAt: new Date(now.getTime() + INVITATION_DAYS * 86_400_000),
          invitedBy: toObjectId(user.id),
        }],
        { session },
      );
      return doc.toObject();
    });
    return { ...ownerView(created as Inv), ...(token ? { token } : {}) };
  }

  /** Pendientes (incluidas las vencidas, marcadas) del torneo. El token no se vuelve a mostrar. */
  async list(tournamentId: string, user: AuthUser) {
    await this.access.require(tournamentId, user.id, Permission.MEMBERS);
    const rows = await this.invitations.find({ tournamentId: toObjectId(tournamentId), status: PENDING }).sort({ createdAt: -1 }).lean();
    return rows.map((r) => ownerView(r));
  }

  async revoke(tournamentId: string, invitationId: string, user: AuthUser) {
    await this.access.require(tournamentId, user.id, Permission.MEMBERS);
    await this.connection.transaction(async (session) => {
      await this.ownership.lockAny(tournamentId, session);
      await this.access.require(tournamentId, user.id, Permission.MEMBERS, session);
      const res = await this.invitations.updateOne(
        { _id: toObjectId(invitationId), tournamentId: toObjectId(tournamentId), status: PENDING },
        { $set: { status: InvitationStatus.REVOKED, decidedBy: toObjectId(user.id), decidedAt: new Date() } },
        { session },
      );
      if (!res.modifiedCount) throw new NotFoundException('Invitación pendiente no encontrada');
    });
    return this.list(tournamentId, user);
  }

  // ─── Enlace ─────────────────────────────────────────────────────────────────

  /** Vista previa pública del enlace (sin datos privados). Token desconocido → 404. */
  async preview(token: string) {
    const inv = await this.invitations.findOne({ tokenHash: hash(token) }).lean();
    if (!inv) throw new NotFoundException('Invitación no válida');
    return this.publicView(inv);
  }

  acceptLink(token: string, user: AuthUser) {
    return this.accept({ tokenHash: hash(token) }, user);
  }

  // ─── Invitaciones a mi cuenta ───────────────────────────────────────────────

  async mine(user: AuthUser) {
    const email = await this.emailOf(user);
    const rows = await this.invitations.find({ kind: InvitationKind.ACCOUNT, email, status: PENDING, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
    return Promise.all(rows.map((r) => this.publicView(r)));
  }

  acceptMine(invitationId: string, user: AuthUser) {
    return this.accept({ _id: toObjectId(invitationId), kind: InvitationKind.ACCOUNT }, user);
  }

  async decline(invitationId: string, user: AuthUser) {
    const email = await this.emailOf(user);
    const res = await this.invitations.updateOne(
      { _id: toObjectId(invitationId), kind: InvitationKind.ACCOUNT, email, status: PENDING },
      { $set: { status: InvitationStatus.DECLINED, decidedBy: toObjectId(user.id), decidedAt: new Date() } },
    );
    if (!res.modifiedCount) throw new NotFoundException('Invitación no encontrada');
    return { declined: true };
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  private async accept(filter: Record<string, unknown>, user: AuthUser) {
    const email = await this.emailOf(user);
    const tournamentId = await this.connection.transaction(async (session) => {
      const inv = await this.invitations.findOne(filter).session(session).lean();
      if (!inv) throw new NotFoundException('Invitación no válida');
      // Una invitación a una cuenta solo la acepta esa cuenta (misma respuesta que si no existiera).
      if (inv.kind === InvitationKind.ACCOUNT && inv.email !== email) throw new NotFoundException('Invitación no válida');
      if (inv.status !== PENDING) throw new ConflictException(STATUS_MESSAGE[inv.status]);
      if (inv.expiresAt <= new Date()) throw new ConflictException('La invitación venció: pide una nueva');
      // Mismo cerrojo que las altas, cambios y revocaciones del torneo.
      const tournament = await this.ownership.lockAny(inv.tournamentId, session);
      if (tournament.organizerId.equals(user.id)) throw new ConflictException('Eres el propietario del torneo: ya tienes todos los permisos');
      const me = toObjectId(user.id);
      if (await this.members.exists({ tournamentId: inv.tournamentId, userId: me, status: TournamentMemberStatus.ACTIVE }).session(session)) {
        throw new ConflictException('Ya colaboras en este torneo; tu rol lo cambia el propietario');
      }
      const active = await this.members.countDocuments({ tournamentId: inv.tournamentId, status: TournamentMemberStatus.ACTIVE }).session(session);
      if (active >= MAX_TOURNAMENT_MEMBERS) throw new ConflictException(`El torneo ya tiene ${MAX_TOURNAMENT_MEMBERS} colaboradores activos`);
      const taken = await this.invitations.updateOne(
        { _id: inv._id, status: PENDING },
        { $set: { status: InvitationStatus.ACCEPTED, decidedBy: me, decidedAt: new Date() } },
        { session },
      );
      if (!taken.modifiedCount) throw new ConflictException(STATUS_MESSAGE[InvitationStatus.ACCEPTED]);
      await this.members.create([{ tournamentId: inv.tournamentId, userId: me, role: inv.role, invitedBy: inv.invitedBy }], { session });
      return inv.tournamentId.toHexString();
    });
    return { tournamentId, role: (await this.access.roleOf(tournamentId, user.id)) ?? null };
  }

  private async emailOf(user: AuthUser) {
    const u = await this.users.findById(user.id).select('email').lean();
    if (!u) throw new ForbiddenException('Cuenta no encontrada');
    return normalizeEmail(u.email);
  }

  private async publicView(inv: Inv) {
    const [t, by] = await Promise.all([
      this.tournaments.findById(inv.tournamentId).select('name status').lean(),
      this.users.findById(inv.invitedBy).select('firstName lastName').lean(),
    ]);
    return {
      id: inv._id.toHexString(),
      tournament: t ? { id: t._id.toHexString(), name: t.name, status: t.status } : null,
      role: inv.role,
      invitedBy: by ? `${by.firstName} ${by.lastName}`.trim() : null,
      status: effectiveStatus(inv),
      expiresAt: inv.expiresAt,
    };
  }
}

const STATUS_MESSAGE: Record<InvitationStatus, string> = {
  [InvitationStatus.PENDING]: '',
  [InvitationStatus.ACCEPTED]: 'Esta invitación ya se usó',
  [InvitationStatus.DECLINED]: 'Esta invitación fue rechazada',
  [InvitationStatus.REVOKED]: 'El organizador revocó esta invitación',
};

const effectiveStatus = (inv: Pick<Inv, 'status' | 'expiresAt'>) => (inv.status === PENDING && inv.expiresAt <= new Date() ? 'EXPIRED' : inv.status);

function ownerView(inv: Inv) {
  return {
    id: inv._id.toHexString(),
    kind: inv.kind,
    role: inv.role,
    email: inv.email,
    status: effectiveStatus(inv),
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
  };
}


