import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { MatchStatus } from '../../../common/enums/index.js';
import type { MatchStage } from '../../competition/types.js';

@Schema({ timestamps: true, collection: 'matches' })
export class Match {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  /** Jornada */
  @Prop({ required: true, min: 1 })
  round: number;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  homeTeamId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  awayTeamId: Types.ObjectId;

  /** `YYYY-MM-DD`, fecha local de la sede. */
  @Prop({ required: true })
  date: string;

  /** `HH:mm`, hora local de la sede. */
  @Prop({ required: true })
  time: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 120 })
  venue: string | null;

  @Prop({
    required: true,
    enum: MatchStatus,
    type: String,
    default: MatchStatus.SCHEDULED,
  })
  status: MatchStatus;

  @Prop({ type: Number, default: null, min: 0 })
  homeScore: number | null;

  @Prop({ type: Number, default: null, min: 0 })
  awayScore: number | null;

  /**
   * Lugar del partido en la estructura del torneo: fase, grupo y eliminatoria (ronda, llave, partido
   * de ida o vuelta). null = partido de liga clásica (fase 0), como todos los partidos de V1.
   */
  @Prop({ type: Object, default: null })
  stage: MatchStage | null;

  /**
   * Penales: de una eliminatoria empatada (solo en el partido que la cierra) o de un empate de liga
   * cuando el torneo da punto extra al ganador (settings.pointsForShootoutWin). No cuentan como
   * goles ni en ninguna estadística.
   */
  @Prop({ type: Object, default: null })
  penalties: { home: number; away: number } | null;

  /** Se jugaron tiempos extra (llave con regla EXTRA_TIME): el marcador ya los incluye. */
  @Prop({ type: Boolean, default: false })
  extraTime: boolean;

  createdAt: Date;
  updatedAt: Date;
}

export type MatchDocument = HydratedDocument<Match>;
export const MatchSchema = SchemaFactory.createForClass(Match);
MatchSchema.index({ tournamentId: 1, date: 1, time: 1 });
MatchSchema.index({ status: 1, date: 1 });
MatchSchema.index({ homeTeamId: 1, date: 1 });
MatchSchema.index({ awayTeamId: 1, date: 1 });
// Un partido por (fase, ronda, llave, ida/vuelta) de un bracket: imposible duplicarlo aunque dos
// peticiones concurrentes lo intentaran (además del cerrojo por torneo).
MatchSchema.index(
  { tournamentId: 1, 'stage.phase': 1, 'stage.tie.round': 1, 'stage.tie.slot': 1, 'stage.tie.leg': 1 },
  { unique: true, partialFilterExpression: { 'stage.tie.leg': { $exists: true } } },
);
