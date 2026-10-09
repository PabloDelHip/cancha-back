import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TournamentMemberStatus, TournamentRole } from '../../../common/enums/index.js';

/**
 * Colaborador de un torneo (RBAC). El propietario NO tiene fila: es Tournament.organizerId y no
 * puede perder el acceso. Revocar deja la fila REVOKED como auditoría (nunca se borra).
 */
@Schema({ timestamps: true, collection: 'tournament_members' })
export class TournamentMember {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: TournamentRole, required: true })
  role: TournamentRole;

  @Prop({ type: String, enum: TournamentMemberStatus, default: TournamentMemberStatus.ACTIVE })
  status: TournamentMemberStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  invitedBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  revokedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type TournamentMemberDocument = HydratedDocument<TournamentMember>;
export const TournamentMemberSchema = SchemaFactory.createForClass(TournamentMember);
// Un solo rol activo por persona y torneo.
TournamentMemberSchema.index({ tournamentId: 1, userId: 1 }, { unique: true, partialFilterExpression: { status: TournamentMemberStatus.ACTIVE } });
// Torneos que administra un usuario (panel).
TournamentMemberSchema.index({ userId: 1, status: 1 });
