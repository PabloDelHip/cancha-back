import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ _id: false })
export class TeamColors {
  @Prop({ required: true, match: /^#[0-9a-fA-F]{6}$/ })
  primary: string;

  @Prop({ required: true, match: /^#[0-9a-fA-F]{6}$/ })
  secondary: string;
}

/**
 * Club. No pertenece a ningún torneo: participa en ellos vía TournamentTeam.
 * shortName, colors y city los usa el frontend para escudos y cabeceras.
 */
@Schema({ timestamps: true, collection: 'teams' })
export class Team {
  @Prop({ required: true, trim: true, maxlength: 80 })
  name: string;

  @Prop({ required: true, trim: true, uppercase: true, maxlength: 4 })
  shortName: string;

  @Prop({ type: String, default: null })
  logoUrl: string | null;

  /** public_id en Cloudinary si el logo se subió por Cancha (null si es una URL externa). Interno. */
  @Prop({ type: String, default: null })
  logoPublicId: string | null;

  /** Foto de portada del perfil (Cloudinary). null = la portada de siempre (colores del equipo). */
  @Prop({ type: String, default: null })
  coverUrl: string | null;

  /** public_id de la portada en Cloudinary. Interno. */
  @Prop({ type: String, default: null })
  coverPublicId: string | null;

  /**
   * Encuadre de la portada, como en Facebook: punto de la foto (en %) que queda al centro del
   * recorte. La foto se guarda completa y cada pantalla recorta alrededor de ese punto.
   */
  @Prop({ type: Object, default: () => ({ x: 50, y: 50 }) })
  coverPosition: { x: number; y: number };

  @Prop({
    type: TeamColors,
    default: () => ({ primary: '#15803d', secondary: '#fafafa' }),
  })
  colors: TeamColors;

  @Prop({ type: String, default: null, trim: true, maxlength: 80 })
  city: string | null;

  /**
   * User que registró la ficha: puede editarla/borrarla. NO es dueño de la participación del
   * equipo en torneos ajenos (eso lo controla el organizador de cada torneo).
   */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

export type TeamDocument = HydratedDocument<Team>;
export const TeamSchema = SchemaFactory.createForClass(Team);
TeamSchema.index({ name: 1 });
TeamSchema.index({ createdBy: 1, name: 1 });
