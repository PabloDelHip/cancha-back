import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Jornada de un torneo (organización deportiva). La programación real (fecha/hora) vive en
 * cada Match.
 *
 * Vínculo con los partidos: `(tournamentId, number)` ↔ `Match.round`. El número es la clave
 * estable de la jornada (no se renumera), así que `Match.round` no es una segunda fuente de
 * verdad sino la referencia: el backend garantiza que toda jornada usada por un partido tiene
 * su registro (se crea al programar o al generar el calendario).
 */
@Schema({ timestamps: true, collection: 'rounds' })
export class Round {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ required: true, min: 1, max: 99 })
  number: number;

  /** Nombre opcional ("Jornada 11 · Reprogramados"); sin él se muestra "Jornada N". */
  @Prop({ type: String, default: null, trim: true, maxlength: 60 })
  name: string | null;

  /** Fecha de referencia `YYYY-MM-DD` (se propone al programar partidos de la jornada). */
  @Prop({ type: String, default: null })
  date: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export type RoundDocument = HydratedDocument<Round>;
export const RoundSchema = SchemaFactory.createForClass(Round);
RoundSchema.index({ tournamentId: 1, number: 1 }, { unique: true });
