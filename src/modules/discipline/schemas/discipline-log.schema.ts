import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DisciplineAction } from '../../../common/enums/index.js';

/** Historial disciplinario del torneo: solo se agregan entradas, nunca se editan ni se borran. */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'discipline_log' })
export class DisciplineLog {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: String, enum: DisciplineAction, required: true })
  action: DisciplineAction;

  /** Referencia de la sanción (id de la manual o clave de la automática). */
  @Prop({ type: String, default: null })
  ref: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Player', default: null })
  playerId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'Match', default: null })
  matchId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  /** Rol del responsable en el torneo en ese momento (OWNER, ADMIN, COORDINATOR, SCORER). */
  @Prop({ type: String, default: null })
  actorRole: string | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  justification: string | null;

  @Prop({ type: Object, default: null })
  before: Record<string, unknown> | null;

  @Prop({ type: Object, default: null })
  after: Record<string, unknown> | null;

  createdAt: Date;
}

export type DisciplineLogDocument = HydratedDocument<DisciplineLog>;
export const DisciplineLogSchema = SchemaFactory.createForClass(DisciplineLog);
DisciplineLogSchema.index({ tournamentId: 1, createdAt: -1 });
