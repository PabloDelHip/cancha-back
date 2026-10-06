import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Sesión de un dispositivo. Guarda SOLO el hash (SHA-256) del refresh token vigente;
 * cada uso lo rota. Permite logout, logout de todos los dispositivos y revocación.
 */
@Schema({ timestamps: true, collection: 'auth_sessions' })
export class AuthSession {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  refreshTokenHash: string;

  /** Hash del token anterior, para distinguir una carrera entre pestañas de un robo. */
  @Prop({ type: String, default: null })
  previousTokenHash: string | null;

  @Prop({ type: Date, default: null })
  rotatedAt: Date | null;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  @Prop({ type: String, default: null, maxlength: 200 })
  userAgent: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export type AuthSessionDocument = HydratedDocument<AuthSession>;
export const AuthSessionSchema = SchemaFactory.createForClass(AuthSession);
AuthSessionSchema.index({ userId: 1, revokedAt: 1 });
// MongoDB elimina automáticamente las sesiones caducadas.
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
