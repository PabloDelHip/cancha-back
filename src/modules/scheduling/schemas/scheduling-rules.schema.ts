import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

/**
 * 6A — restricciones de calendario del torneo. Los torneos anteriores no tienen el campo y se leen
 * con DEFAULT_TOURNAMENT_RULES (sin restricciones): nada cambia hasta que el organizador las configura.
 * Días: 0 = domingo … 6 = sábado (como la disponibilidad de las canchas).
 */
@Schema({ _id: false })
export class TournamentSchedulingRules {
  /** Zona horaria IANA del torneo. null = la de las ligas (`APP_TIME_ZONE`). */
  @Prop({ type: String, default: null })
  timeZone: string | null;

  /** Días en que se programan partidos. Vacío = cualquier día. */
  @Prop({ type: [Number], default: [] })
  days: number[];

  /** Primer inicio permitido (`HH:mm`). */
  @Prop({ type: String, default: null })
  startTime: string | null;

  /** Hora a la que debe haber terminado el último partido (`HH:mm`, admite `24:00`). */
  @Prop({ type: String, default: null })
  endTime: string | null;

  /** Minutos mínimos entre el final de un partido y el inicio del siguiente en la misma cancha. */
  @Prop({ type: Number, default: null, min: 0, max: 240 })
  fieldGapMinutes: number | null;

  @Prop({ type: Number, default: null, min: 1, max: 50 })
  maxMatchesPerDay: number | null;

  @Prop({ type: Number, default: null, min: 1, max: 30 })
  maxSimultaneous: number | null;

  /** Disponibilidad de las canchas (catálogo de sedes): solo aviso o restricción obligatoria. */
  @Prop({ type: String, enum: ['WARN', 'BLOCK'], default: 'WARN' })
  fieldAvailability: 'WARN' | 'BLOCK';

  /** 6B: reglas generales que solo avisan (DAYS, HOURS, DAILY_LIMIT). Vacío = todas obligatorias. */
  @Prop({ type: [String], enum: ['DAYS', 'HOURS', 'DAILY_LIMIT'], default: [] })
  softRules: ('DAYS' | 'HOURS' | 'DAILY_LIMIT')[];

  @Prop({ type: Date, default: null })
  updatedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  updatedBy: Types.ObjectId | null;
}
export const TournamentSchedulingRulesSchema = SchemaFactory.createForClass(TournamentSchedulingRules);

@Schema({ _id: false })
export class TimeRange {
  /** null = todos los días. */
  @Prop({ type: Number, default: null, min: 0, max: 6 })
  day: number | null;

  @Prop({ type: String, required: true })
  from: string;

  @Prop({ type: String, required: true })
  to: string;
}
const TimeRangeSchema = SchemaFactory.createForClass(TimeRange);

/** 6A — restricciones de un equipo EN un torneo (viven en su inscripción: no afectan otros torneos). */
@Schema({ _id: false })
export class TeamSchedulingRules {
  @Prop({ type: [Number], default: [] })
  unavailableDays: number[];

  @Prop({ type: [String], default: [] })
  unavailableDates: string[];

  @Prop({ type: [TimeRangeSchema], default: [] })
  unavailableTimes: TimeRange[];

  /** Horas mínimas entre el final de un partido del equipo y el inicio del siguiente. */
  @Prop({ type: Number, default: null, min: 0, max: 336 })
  minRestHours: number | null;

  @Prop({ type: Number, default: null, min: 1, max: 10 })
  maxMatchesPerDay: number | null;

  /** true = obligatoria (bloquea); false = preferencia (solo avisa). */
  @Prop({ type: Boolean, default: true })
  strict: boolean;

  @Prop({ type: String, default: null, trim: true, maxlength: 300 })
  notes: string | null;
}
export const TeamSchedulingRulesSchema = SchemaFactory.createForClass(TeamSchedulingRules);
