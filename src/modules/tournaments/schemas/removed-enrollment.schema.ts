import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * 3E — copia administrativa de un equipo QUITADO del torneo sin haber jugado (removeTeam). La
 * inscripción y las participaciones se borran (no es participante, no cuenta para cupos,
 * calendario ni estadísticas), pero su historial queda aquí, de solo lectura, para el historial
 * de plantillas (`GET /tournaments/:id/roster-history`). Nadie más la lee ni la modifica.
 */
@Schema({ timestamps: false, collection: 'removed_enrollments' })
export class RemovedEnrollment {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  /** Cuándo se había inscrito (createdAt de la inscripción borrada). */
  @Prop({ type: Date, default: null })
  enrolledAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  removedBy: Types.ObjectId;

  @Prop({ type: String, default: null })
  removedRole: string | null;

  @Prop({ type: Date, required: true })
  removedAt: Date;

  /** Participaciones borradas, tal como estaban (con su `audit`). */
  @Prop({ type: [Object], default: [] })
  memberships: Record<string, unknown>[];
}

export type RemovedEnrollmentDocument = HydratedDocument<RemovedEnrollment>;
export const RemovedEnrollmentSchema = SchemaFactory.createForClass(RemovedEnrollment);
RemovedEnrollmentSchema.index({ tournamentId: 1, removedAt: -1 });
