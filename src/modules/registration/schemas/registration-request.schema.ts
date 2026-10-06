import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { RegistrationRequestStatus } from '../../../common/enums/index.js';

/**
 * Solicitud de inscripción de un Team a un Tournament con la selección de jugadores de su
 * plantilla GLOBAL (referencias, no copias). La selección enviada no cambia aunque cambie la
 * plantilla: al aprobar se revalida todo. Nunca se borra (historial administrativo); reintentar
 * tras REJECTED/CANCELLED crea una solicitud nueva.
 */
@Schema({ timestamps: true, collection: 'registration_requests' })
export class RegistrationRequest {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  /** OWNER/MANAGER que la envió. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  submittedBy: Types.ObjectId;

  @Prop({ required: true, enum: RegistrationRequestStatus, type: String, default: RegistrationRequestStatus.PENDING })
  status: RegistrationRequestStatus;

  @Prop({ type: [Types.ObjectId], ref: 'Player', required: true })
  playerIds: Types.ObjectId[];

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  /** Organizador que aprobó o rechazó. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  reviewedBy: Types.ObjectId | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 300 })
  rejectionReason: string | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  cancelledBy: Types.ObjectId | null;

  /** createdAt = enviada. */
  createdAt: Date;
  updatedAt: Date;
}

export type RegistrationRequestDocument = HydratedDocument<RegistrationRequest>;
export const RegistrationRequestSchema = SchemaFactory.createForClass(RegistrationRequest);
// Máximo UNA solicitud PENDING por (torneo, equipo), también bajo concurrencia.
RegistrationRequestSchema.index(
  { tournamentId: 1, teamId: 1 },
  { unique: true, name: 'one_pending_request_per_team', partialFilterExpression: { status: RegistrationRequestStatus.PENDING } },
);
// Panel del organizador: por estado, más recientes primero.
RegistrationRequestSchema.index({ tournamentId: 1, status: 1, createdAt: -1 });
// Historial de un equipo (estado en el link, "mis solicitudes").
RegistrationRequestSchema.index({ teamId: 1, tournamentId: 1, createdAt: -1 });
