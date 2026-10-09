import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { SanctionCause, SanctionKind } from '../../../common/enums/index.js';

/**
 * Decisión humana sobre una sanción del torneo:
 * - MANUAL: sanción registrada por el organizador.
 * - AUTO: ajuste (duración o anulación) de una sanción automática, enlazada por `key`. Las
 *   automáticas se derivan de las tarjetas; este documento sobrevive aunque la sanción deje de
 *   derivarse (p. ej. tras corregir tarjetas) para no perder la decisión ni su historial.
 */
@Schema({ timestamps: true, collection: 'sanctions' })
export class Sanction {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true, index: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: String, enum: SanctionKind, required: true })
  kind: SanctionKind;

  /** Clave estable de la sanción automática (ver discipline.ts). null en las manuales. */
  @Prop({ type: String, default: null })
  key: string | null;

  @Prop({ type: Types.ObjectId, ref: 'Player', required: true })
  playerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: String, enum: SanctionCause, required: true })
  cause: SanctionCause;

  /** AUTO: partido que la originó. MANUAL: partido desde el que aplica (incluido). */
  @Prop({ type: Types.ObjectId, ref: 'Match', required: true })
  matchId: Types.ObjectId;

  /** Partidos de suspensión. En AUTO, null = lo que diga el reglamento. */
  @Prop({ type: Number, default: null, min: 1, max: 50 })
  matches: number | null;

  /**
   * MANUAL: posición (fase, fecha, hora, jornada) del partido de inicio al registrarla o corregirla.
   * Si ese partido se borra (regenerar calendario, reacomodo de la eliminatoria), la sanción sigue
   * aplicando desde esa posición en lugar de desaparecer.
   */
  @Prop({ type: Object, default: null })
  start: { phase: number; date: string; time: string; round: number } | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  reason: string | null;

  @Prop({ type: Boolean, default: false })
  annulled: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  createdBy: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

export type SanctionDocument = HydratedDocument<Sanction>;
export const SanctionSchema = SchemaFactory.createForClass(Sanction);
// Un solo ajuste por sanción automática (además del cerrojo del torneo).
SanctionSchema.index({ tournamentId: 1, key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
SanctionSchema.index({ matchId: 1 });
