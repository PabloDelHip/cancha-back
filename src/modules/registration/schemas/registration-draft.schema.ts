import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const DRAFT_STEPS = ['team', 'players', 'review'] as const;
export type DraftStep = (typeof DRAFT_STEPS)[number];

/**
 * Inscripción INCOMPLETA: lo que una cuenta lleva hecho en un enlace de inscripción antes de enviar
 * la solicitud (equipo elegido, jugadores marcados, paso). Una por (usuario, torneo). Se borra al
 * enviar la solicitud o al cancelar; nunca toca equipos, plantillas ni jugadores (eso ya existe
 * por su lado). No es una RegistrationRequest: el organizador no la ve.
 */
@Schema({ timestamps: true, collection: 'registration_drafts' })
export class RegistrationDraft {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  /** Enlace por el que llegó (para volver exactamente a ese flujo). */
  @Prop({ type: Types.ObjectId, ref: 'RegistrationLink', required: true })
  linkId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', default: null })
  teamId: Types.ObjectId | null;

  @Prop({ type: [Types.ObjectId], ref: 'Player', default: [] })
  playerIds: Types.ObjectId[];

  @Prop({ type: String, enum: DRAFT_STEPS, default: 'team' })
  step: DraftStep;

  createdAt: Date;
  updatedAt: Date;
}

export type RegistrationDraftDocument = HydratedDocument<RegistrationDraft>;
export const RegistrationDraftSchema = SchemaFactory.createForClass(RegistrationDraft);
RegistrationDraftSchema.index({ userId: 1, tournamentId: 1 }, { unique: true, name: 'one_draft_per_user_tournament' });
RegistrationDraftSchema.index({ userId: 1, updatedAt: -1 });
