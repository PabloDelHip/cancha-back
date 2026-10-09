import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DEFAULT_BUFFER_MINUTES } from '../occupancy.js';

@Schema({ _id: false })
export class WeeklyWindow {
  @Prop({ type: Number, required: true, min: 0, max: 6 })
  day: number;

  @Prop({ type: String, required: true })
  from: string;

  @Prop({ type: String, required: true })
  to: string;
}

@Schema({ _id: false })
export class FieldAvailability {
  @Prop({ type: [WeeklyWindow], default: [] })
  weekly: WeeklyWindow[];

  @Prop({ type: [String], default: [] })
  closedDates: string[];
}

/**
 * Cancha de una sede. `archived` = se eliminó pero hay partidos que la usan: se conserva para que
 * esas referencias sigan resolviendo y deja de ofrecerse. `active = false` = desactivada (no se
 * puede asignar a partidos nuevos).
 */
@Schema({ timestamps: false })
export class Field {
  _id: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  name: string;

  @Prop({ type: Boolean, default: true })
  active: boolean;

  @Prop({ type: Boolean, default: false })
  archived: boolean;

  @Prop({ type: FieldAvailability, default: () => ({ weekly: [], closedDates: [] }) })
  availability: FieldAvailability;
}
export const FieldSchema = SchemaFactory.createForClass(Field);

/** Sede del organizador (reutilizable en todas sus ligas y torneos) con sus canchas. */
@Schema({ timestamps: true, collection: 'venues' })
export class Venue {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  organizerId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  name: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 200 })
  address: string | null;

  /** Minutos de cambio entre partidos en sus canchas (se suman a la duración del partido). */
  @Prop({ type: Number, default: DEFAULT_BUFFER_MINUTES, min: 0, max: 120 })
  bufferMinutes: number;

  @Prop({ type: Boolean, default: true })
  active: boolean;

  @Prop({ type: Boolean, default: false })
  archived: boolean;

  @Prop({ type: [FieldSchema], default: [] })
  fields: Field[];

  /**
   * Cerrojo lógico: toda reserva de una de sus canchas lo incrementa dentro de su transacción.
   * Así dos torneos que asignan la misma cancha a la vez se serializan (como `Tournament.writeSeq`).
   */
  @Prop({ type: Number, default: 0 })
  writeSeq: number;

  createdAt: Date;
  updatedAt: Date;
}

export type VenueDocument = HydratedDocument<Venue>;
export const VenueSchema = SchemaFactory.createForClass(Venue);
