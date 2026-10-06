import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Liga: agrupa los torneos de una misma organización a lo largo del tiempo (p. ej. Apertura,
 * Clausura y copas) y es la base de su histórico. Todo torneo pertenece a una liga.
 * Autoridad: un único dueño (`organizerId`), que es quien crea y administra sus torneos.
 */
@Schema({ timestamps: true, collection: 'leagues' })
export class League {
  @Prop({ required: true, trim: true, maxlength: 80 })
  name: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 80 })
  city: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 500 })
  description: string | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  organizerId: Types.ObjectId;

  /**
   * Liga creada por el sistema para alojar torneos sin liga (los que existían antes de las ligas, o
   * uno creado por la API sin indicar liga). Una como máximo por organizador; se puede renombrar.
   */
  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type LeagueDocument = HydratedDocument<League>;
export const LeagueSchema = SchemaFactory.createForClass(League);
LeagueSchema.index({ organizerId: 1, name: 1 });
LeagueSchema.index({ organizerId: 1 }, { unique: true, partialFilterExpression: { isDefault: true }, name: 'one_default_league_per_organizer' });
