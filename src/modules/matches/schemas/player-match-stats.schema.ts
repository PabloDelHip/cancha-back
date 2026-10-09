import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { SendOff } from '../../../common/enums/index.js';

/**
 * Participación de un jugador en UN partido. Es la fuente de verdad de todas las
 * estadísticas históricas. `teamId` es el equipo con el que jugó ese partido.
 */
@Schema({ timestamps: true, collection: 'player_match_stats' })
export class PlayerMatchStats {
  @Prop({ type: Types.ObjectId, ref: 'Match', required: true })
  matchId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Player', required: true })
  playerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ required: true, default: true })
  played: boolean;

  @Prop({ required: true, default: 0, min: 0 })
  goals: number;

  @Prop({ required: true, default: 0, min: 0 })
  assists: number;

  /** Autogoles: cuentan en el marcador del RIVAL y nunca como goles del jugador. */
  @Prop({ default: 0, min: 0 })
  ownGoals: number;

  @Prop({ required: true, default: 0, min: 0, max: 2 })
  yellowCards: number;

  @Prop({ required: true, default: 0, min: 0, max: 1 })
  redCards: number;

  /**
   * Tipo de expulsión: null = no fue expulsado. Ausente en capturas anteriores al módulo
   * disciplinario (o de clientes que no lo envían): esas no se interpretan automáticamente.
   */
  @Prop({ type: String, enum: [...Object.values(SendOff), null], default: undefined })
  sendOff?: SendOff | null;

  createdAt: Date;
  updatedAt: Date;
}

export type PlayerMatchStatsDocument = HydratedDocument<PlayerMatchStats>;
export const PlayerMatchStatsSchema =
  SchemaFactory.createForClass(PlayerMatchStats);
PlayerMatchStatsSchema.index({ matchId: 1, playerId: 1 }, { unique: true });
PlayerMatchStatsSchema.index({ playerId: 1 });
PlayerMatchStatsSchema.index({ teamId: 1 });
