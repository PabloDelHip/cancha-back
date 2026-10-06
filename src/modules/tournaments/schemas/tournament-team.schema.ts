import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/** Inscripción de un equipo en un torneo (relación N:M independiente). */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'tournament_teams',
})
export class TournamentTeam {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  createdAt: Date;
}

export type TournamentTeamDocument = HydratedDocument<TournamentTeam>;
export const TournamentTeamSchema =
  SchemaFactory.createForClass(TournamentTeam);
TournamentTeamSchema.index({ tournamentId: 1, teamId: 1 }, { unique: true });
TournamentTeamSchema.index({ teamId: 1 });
