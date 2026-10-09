import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { MatchLogAction, MatchLogCause, MatchLogSource } from '../../../common/enums/index.js';

/**
 * Historial de un partido (Módulo 2C): solo se agregan entradas, siempre dentro de la misma
 * transacción que el cambio. Pertenece al torneo: sobrevive a la eliminación del partido.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'match_logs' })
export class MatchLog {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  /** null en las entradas de varios partidos (calendario reemplazado). */
  @Prop({ type: Types.ObjectId, ref: 'Match', default: null })
  matchId: Types.ObjectId | null;

  /** Partidos afectados por una entrada de varios partidos (para consultarla por partido). */
  @Prop({ type: [Types.ObjectId], default: [] })
  affectedMatchIds: Types.ObjectId[];

  @Prop({ type: String, enum: MatchLogAction, required: true })
  action: MatchLogAction;

  @Prop({ type: String, enum: MatchLogSource, default: MatchLogSource.USER })
  source: MatchLogSource;

  @Prop({ type: String, enum: MatchLogCause, default: null })
  cause: MatchLogCause | null;

  /** Usuario que hizo el cambio (o que lo desencadenó, si lo aplicó el sistema). */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  /** Rol del responsable en el torneo en ese momento (OWNER, ADMIN, COORDINATOR, SCORER). */
  @Prop({ type: String, default: null })
  actorRole: string | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  reason: string | null;

  /** Campos que cambiaron: `{ campo: { from, to } }`. */
  @Prop({ type: Object, default: null })
  changes: Record<string, { from: unknown; to: unknown }> | null;

  /** Copia del partido (creado o eliminado). */
  @Prop({ type: Object, default: null })
  snapshot: Record<string, unknown> | null;

  /** Calendario reemplazado: copias de todos los partidos eliminados. */
  @Prop({ type: [Object], default: undefined })
  deleted?: Record<string, unknown>[];

  /** Cancha y árbitros que quedaron libres al eliminar. */
  @Prop({ type: Object, default: null })
  released: { matchId: string; fieldId: string | null; venue: string | null; referees: { refereeId: string; role: string }[] }[] | null;

  createdAt: Date;
}

export type MatchLogDocument = HydratedDocument<MatchLog>;
export const MatchLogSchema = SchemaFactory.createForClass(MatchLog);
MatchLogSchema.index({ tournamentId: 1, createdAt: -1 });
MatchLogSchema.index({ matchId: 1, createdAt: 1 });
MatchLogSchema.index({ affectedMatchIds: 1 });
