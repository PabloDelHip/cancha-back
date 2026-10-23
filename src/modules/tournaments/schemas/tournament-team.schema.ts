import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TeamSchedulingRules, TeamSchedulingRulesSchema } from '../../scheduling/schemas/scheduling-rules.schema.js';

/** 3D — retiro y reincorporación de un equipo inscrito (con motivo, quién y con qué rol). */
export enum EnrollmentAuditAction {
  WITHDRAWN = 'WITHDRAWN',
  REINSTATED = 'REINSTATED',
}

@Schema({ _id: false })
export class EnrollmentAudit {
  @Prop({ type: String, enum: EnrollmentAuditAction, required: true })
  action: EnrollmentAuditAction;

  @Prop({ type: String, required: true })
  reason: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  by: Types.ObjectId;

  @Prop({ type: String, default: null })
  role: string | null;

  @Prop({ type: Date, required: true })
  at: Date;

  /** Al retirar: partidos cancelados y participaciones cerradas. */
  @Prop({ type: Object, default: null })
  details: Record<string, unknown> | null;
}
const EnrollmentAuditSchema = SchemaFactory.createForClass(EnrollmentAudit);

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

  /**
   * 3D — `YYYY-MM-DD` del retiro: el equipo abandonó el torneo después de jugar. Sigue inscrito (sus
   * resultados cuentan y su historia se conserva), pero no recibe jugadores ni partidos nuevos y no
   * clasifica. null = participa con normalidad (también todas las inscripciones anteriores a 3D).
   */
  @Prop({ type: String, default: null })
  withdrawnAt: string | null;

  /** Interna: motivos y autores del retiro y la reincorporación. Nunca se expone en público. */
  @Prop({ type: [EnrollmentAuditSchema], default: [] })
  audit: EnrollmentAudit[];

  /** 6A — restricciones de calendario del equipo en ESTE torneo. null = sin restricciones. */
  @Prop({ type: TeamSchedulingRulesSchema, default: null, select: false })
  scheduling: TeamSchedulingRules | null;

  createdAt: Date;
}

export type TournamentTeamDocument = HydratedDocument<TournamentTeam>;
export const TournamentTeamSchema =
  SchemaFactory.createForClass(TournamentTeam);
TournamentTeamSchema.index({ tournamentId: 1, teamId: 1 }, { unique: true });
TournamentTeamSchema.index({ teamId: 1 });
