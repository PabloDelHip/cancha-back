import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { MatchIncidentStatus, MatchIncidentType, MatchStatus, SuspensionDecision } from '../../../common/enums/index.js';

/** Quién cerró o anuló una incidencia, cuándo y por qué. */
export interface IncidentClose {
  at: Date;
  by: Types.ObjectId;
  role: string | null;
  note: string | null;
}

/**
 * Incidencia operativa de un partido (Módulo 2C-2). Nunca se borra: se resuelve (con nota, o con la
 * decisión sobre el partido si es una suspensión) o se anula (VOID) si se registró por error.
 * Es información interna del torneo: no sale en las vistas públicas del partido.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'match_incidents' })
export class MatchIncident {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Match', required: true })
  matchId: Types.ObjectId;

  @Prop({ type: String, enum: MatchIncidentType, required: true })
  type: MatchIncidentType;

  @Prop({ type: String, required: true, trim: true, maxlength: 1000 })
  description: string;

  /** Cuándo ocurrió (puede registrarse después). */
  @Prop({ type: Date, required: true })
  occurredAt: Date;

  @Prop({ type: String, enum: MatchIncidentStatus, default: MatchIncidentStatus.OPEN })
  status: MatchIncidentStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  reportedBy: Types.ObjectId;

  /** Rol del responsable en el torneo al registrarla (OWNER, ADMIN, COORDINATOR). */
  @Prop({ type: String, default: null })
  reportedRole: string | null;

  /** Suspensión: estado del partido al suspenderse (SCHEDULED o LIVE), para deshacerla si fue un error. */
  @Prop({ type: String, enum: MatchStatus, default: null })
  suspendedFrom: MatchStatus | null;

  @Prop({ type: Object, default: null })
  resolution: (IncidentClose & { decision: SuspensionDecision | null }) | null;

  @Prop({ type: Object, default: null })
  voided: IncidentClose | null;

  createdAt: Date;
}

export type MatchIncidentDocument = HydratedDocument<MatchIncident>;
export const MatchIncidentSchema = SchemaFactory.createForClass(MatchIncident);
MatchIncidentSchema.index({ matchId: 1, createdAt: 1 });
MatchIncidentSchema.index({ tournamentId: 1, createdAt: -1 });
// Una sola suspensión abierta por partido, aunque dos peticiones lo intenten a la vez.
MatchIncidentSchema.index(
  { matchId: 1 },
  { unique: true, name: 'one_open_suspension', partialFilterExpression: { type: MatchIncidentType.SUSPENSION, status: MatchIncidentStatus.OPEN } },
);
