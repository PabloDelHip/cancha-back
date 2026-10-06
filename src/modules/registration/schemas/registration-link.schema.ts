import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { RegistrationLinkStatus } from '../../../common/enums/index.js';

/**
 * Enlace privado de inscripción. El token (32 bytes aleatorios) NUNCA se guarda en claro:
 * - `tokenHash` (SHA-256): para resolver el enlace (índice único);
 * - `tokenCiphertext` (AES-256-GCM, clave derivada del secreto del servidor): para que el
 *   organizador pueda volver a copiarlo y compartirlo sin regenerarlo (lo que rompería el enlace
 *   ya enviado por WhatsApp).
 * Poseer el enlace solo da acceso al flujo; inscribir exige ser OWNER/MANAGER del equipo.
 */
@Schema({ timestamps: true, collection: 'registration_links' })
export class RegistrationLink {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ required: true })
  tokenHash: string;

  @Prop({ required: true, select: false })
  tokenCiphertext: string;

  @Prop({ required: true, enum: RegistrationLinkStatus, type: String, default: RegistrationLinkStatus.ACTIVE })
  status: RegistrationLinkStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  revokedBy: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

export type RegistrationLinkDocument = HydratedDocument<RegistrationLink>;
export const RegistrationLinkSchema = SchemaFactory.createForClass(RegistrationLink);
RegistrationLinkSchema.index({ tokenHash: 1 }, { unique: true });
// Máximo un enlace ACTIVE por torneo (regenerar = revocar el anterior + crear otro, en transacción).
RegistrationLinkSchema.index(
  { tournamentId: 1 },
  { unique: true, name: 'one_active_link_per_tournament', partialFilterExpression: { status: RegistrationLinkStatus.ACTIVE } },
);
