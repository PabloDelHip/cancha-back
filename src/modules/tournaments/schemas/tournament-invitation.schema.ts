import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { InvitationKind, InvitationStatus, TournamentRole } from '../../../common/enums/index.js';

/**
 * Invitación a colaborar en un torneo (RBAC R2). El rol queda fijo al crearla. LINK: solo se
 * guarda el hash del token (el enlace se muestra una vez). ACCOUNT: la acepta solo la cuenta cuyo
 * correo coincide. Vence a los 7 días (`expiresAt`); nunca se borra (auditoría).
 */
@Schema({ timestamps: true, collection: 'tournament_invitations' })
export class TournamentInvitation {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: String, enum: InvitationKind, required: true })
  kind: InvitationKind;

  @Prop({ type: String, enum: TournamentRole, required: true })
  role: TournamentRole;

  /** LINK: sha256 del token. */
  @Prop({ type: String, default: null })
  tokenHash: string | null;

  /** ACCOUNT: correo normalizado del destinatario (exista o no una cuenta con él). */
  @Prop({ type: String, default: null })
  email: string | null;

  @Prop({ type: String, enum: InvitationStatus, default: InvitationStatus.PENDING })
  status: InvitationStatus;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  invitedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  decidedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  decidedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type TournamentInvitationDocument = HydratedDocument<TournamentInvitation>;
export const TournamentInvitationSchema = SchemaFactory.createForClass(TournamentInvitation);
TournamentInvitationSchema.index({ tokenHash: 1 }, { unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } });
TournamentInvitationSchema.index({ tournamentId: 1, status: 1 });
TournamentInvitationSchema.index({ email: 1, status: 1 });
