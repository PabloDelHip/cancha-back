import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { FieldAvailability } from '../../venues/schemas/venue.schema.js';

/**
 * Árbitro del organizador (reutilizable en todas sus ligas y torneos). Sin cuenta de usuario.
 * Teléfono y correo son privados: nunca salen en respuestas públicas. `archived` = se eliminó
 * pero tiene partidos: se conserva para que su historial siga resolviendo.
 */
@Schema({ timestamps: true, collection: 'referees' })
export class Referee {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  organizerId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  firstName: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  lastName: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 30 })
  phone: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  email: string | null;

  @Prop({ type: Boolean, default: true })
  active: boolean;

  @Prop({ type: Boolean, default: false })
  archived: boolean;

  /** Disponibilidad para arbitrar: solo genera avisos. */
  @Prop({ type: FieldAvailability, default: () => ({ weekly: [], closedDates: [] }) })
  availability: FieldAvailability;

  /** Cerrojo lógico: toda asignación lo incrementa en su transacción (asignaciones simultáneas). */
  @Prop({ type: Number, default: 0 })
  writeSeq: number;

  createdAt: Date;
  updatedAt: Date;
}

export type RefereeDocument = HydratedDocument<Referee>;
export const RefereeSchema = SchemaFactory.createForClass(Referee);

export const refereeName = (r: Pick<Referee, 'firstName' | 'lastName'>) => `${r.firstName} ${r.lastName}`.trim();
