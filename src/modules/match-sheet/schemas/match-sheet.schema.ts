import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ _id: false })
export class SheetPlayer {
  @Prop({ type: Types.ObjectId, ref: 'Player', required: true })
  playerId: Types.ObjectId;

  /** Dorsal usado EN ESTE partido (por defecto, el de su participación en el torneo). */
  @Prop({ type: Number, default: null, min: 0, max: 99 })
  jerseyNumber: number | null;

  @Prop({ type: Boolean, required: true })
  starter: boolean;

  @Prop({ type: Boolean, default: false })
  captain: boolean;
}
const SheetPlayerSchema = SchemaFactory.createForClass(SheetPlayer);

@Schema({ _id: false })
export class SheetSubstitution {
  @Prop({ type: Types.ObjectId, ref: 'Player', required: true })
  outPlayerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Player', required: true })
  inPlayerId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0, max: 200 })
  minute: number;
}
const SheetSubstitutionSchema = SchemaFactory.createForClass(SheetSubstitution);

@Schema({ _id: false })
export class SheetTeam {
  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: [SheetPlayerSchema], default: [] })
  players: SheetPlayer[];

  @Prop({ type: [SheetSubstitutionSchema], default: [] })
  substitutions: SheetSubstitution[];

  @Prop({ type: Date, default: null })
  updatedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  updatedBy: Types.ObjectId | null;
}
const SheetTeamSchema = SchemaFactory.createForClass(SheetTeam);

/**
 * Ficha técnica de un partido (Módulo 2D): SOLO lo que no existía en otra parte (alineaciones,
 * sustituciones y observaciones). Resultado, estadísticas, árbitros, incidencias e historial se
 * leen de sus fuentes; el cierre vive en `Match.sheetClosed`. Una por partido, creada al guardar.
 */
@Schema({ timestamps: true, collection: 'match_sheets' })
export class MatchSheet {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Match', required: true })
  matchId: Types.ObjectId;

  /** Equipos con alineación capturada (local y/o visitante). */
  @Prop({ type: [SheetTeamSchema], default: [] })
  teams: SheetTeam[];

  @Prop({ type: String, default: null, trim: true, maxlength: 4000 })
  observations: string | null;

  createdAt: Date;
  updatedAt: Date;
}

export type MatchSheetDocument = HydratedDocument<MatchSheet>;
export const MatchSheetSchema = SchemaFactory.createForClass(MatchSheet);
MatchSheetSchema.index({ matchId: 1 }, { unique: true });
MatchSheetSchema.index({ tournamentId: 1 });
