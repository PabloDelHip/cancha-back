import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { PlayerPosition } from '../../../common/enums/index.js';

/**
 * Identidad deportiva de una persona. Independiente de equipos y torneos:
 * NO guarda teamId (eso vive en TeamMembership) ni totales (se derivan de PlayerMatchStats).
 * Tampoco es un User: un organizador puede registrar jugadores sin cuenta.
 */
@Schema({ timestamps: true, collection: 'players' })
export class Player {
  @Prop({ required: true, trim: true, maxlength: 60 })
  firstName: string;

  @Prop({ required: true, trim: true, maxlength: 80 })
  lastName: string;

  /**
   * Apodo opcional ("Bigotes"). No es único ni identifica a nadie por sí solo: ayuda a encontrar
   * y distinguir jugadores. Entra en la búsqueda, NO en la detección de posibles duplicados.
   */
  @Prop({ type: String, default: null, trim: true, maxlength: 40 })
  nickname: string | null;

  /** `YYYY-MM-DD` */
  @Prop({ type: String, default: null })
  birthDate: string | null;

  @Prop({ required: true, enum: PlayerPosition, type: String })
  position: PlayerPosition;

  @Prop({ type: String, default: null })
  photoUrl: string | null;

  /** public_id en Cloudinary si la foto se subió por Cancha (null si es una URL externa). Interno. */
  @Prop({ type: String, default: null })
  photoPublicId: string | null;

  /**
   * User que registró la ficha (custodio): puede editarla, borrarla y cambiar al jugador
   * de equipo. No es dueño de su historia: las estadísticas pertenecen a los partidos.
   */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;

  /**
   * Clave de idempotencia de la petición que creó la ficha desde la plantilla de un equipo
   * (POST /teams/:id/global-roster/players): un doble clic o un reintento con la misma clave no
   * crea un segundo jugador. Uso interno, nunca público. No es deduplicación por nombre.
   */
  @Prop({ type: String, select: false })
  creationRequestId?: string;

  /** Nombre normalizado (minúsculas, sin acentos) para la búsqueda. Uso interno. */
  @Prop({ required: true, select: false })
  searchName: string;

  createdAt: Date;
  updatedAt: Date;
}

export type PlayerDocument = HydratedDocument<Player>;
export const PlayerSchema = SchemaFactory.createForClass(Player);
PlayerSchema.index({ searchName: 1 });
PlayerSchema.index({ lastName: 1, firstName: 1 });
PlayerSchema.index({ createdBy: 1, lastName: 1 });
PlayerSchema.index(
  { createdBy: 1, creationRequestId: 1 },
  { name: 'one_player_per_creation_request', unique: true, partialFilterExpression: { creationRequestId: { $type: 'string' } } },
);

/** Texto de búsqueda del jugador: nombre, apellidos y apodo, normalizados. */
export function playerSearchName(p: { firstName: string; lastName: string; nickname?: string | null }): string {
  return normalizeSearch(`${p.firstName} ${p.lastName} ${p.nickname ?? ''}`);
}

export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
