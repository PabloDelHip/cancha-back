import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Participación de un jugador (global) con un equipo (global) DENTRO de un torneo.
 *
 * El contexto es el torneo: su organizador es quien administra estas participaciones.
 * Así un mismo Player puede jugar a la vez en competiciones distintas, con equipos
 * distintos y organizadores distintos, sin que uno pueda tocar la plantilla del otro.
 *
 * Cambiar de equipo dentro del torneo cierra la participación activa (endDate) y abre
 * otra: el historial nunca se borra.
 */
/** Quién inscribió, movió o dio de baja, y las excepciones autorizadas (3A). Nunca se expone en público. */
export enum MembershipAuditAction {
  REGISTERED = 'REGISTERED',
  /** Elegibilidad con fecha anterior a la de la inscripción real (con motivo). */
  RETROACTIVE = 'RETROACTIVE',
  /** Inscrito por encima del máximo de jugadores del equipo (con motivo). */
  OVER_LIMIT = 'OVER_LIMIT',
  /** Participación cerrada al cambiar de equipo dentro del torneo. */
  MOVED = 'MOVED',
  /** Baja del torneo (con motivo). */
  UNREGISTERED = 'UNREGISTERED',
  /** 3C: cambio de equipo autorizado con la eliminatoria ya iniciada (con motivo). */
  KNOCKOUT_EXCEPTION = 'KNOCKOUT_EXCEPTION',
  /** 3C: transferencia errónea anulada; en la participación restaurada, con la copia de la anulada en `details.annulled`. */
  TRANSFER_ANNULLED = 'TRANSFER_ANNULLED',
  /** 3E: cambio de dorsal en la participación vigente (`details.from` / `details.to`; null = sin dorsal). */
  JERSEY_CHANGED = 'JERSEY_CHANGED',
}

@Schema({ _id: false })
export class MembershipAudit {
  @Prop({ type: String, enum: MembershipAuditAction, required: true })
  action: MembershipAuditAction;

  @Prop({ type: String, default: null })
  reason: string | null;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  by: Types.ObjectId;

  /** Rol en el torneo (OWNER/ADMIN…), `TEAM` (dueño/manager del equipo) o `REQUEST` (solicitud aprobada). */
  @Prop({ type: String, default: null })
  role: string | null;

  @Prop({ type: Date, required: true })
  at: Date;

  /** Datos de la excepción: fecha pedida, máximo y ocupación, equipo destino. */
  @Prop({ type: Object, default: null })
  details: Record<string, unknown> | null;
}
const MembershipAuditSchema = SchemaFactory.createForClass(MembershipAudit);

@Schema({ timestamps: true, collection: 'team_memberships' })
export class TeamMembership {
  @Prop({ type: Types.ObjectId, ref: 'Player', required: true })
  playerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Number, default: null, min: 1, max: 99 })
  jerseyNumber: number | null;

  /**
   * `YYYY-MM-DD` — fecha EFECTIVA: desde cuándo es elegible para jugar con el equipo. Por
   * defecto, el día de la inscripción; antes de eso solo con excepción RETROACTIVE.
   */
  @Prop({ required: true })
  startDate: string;

  /**
   * `YYYY-MM-DD` — fecha REAL de la inscripción (3A). null = participación anterior a 3A: conserva
   * la regla previa (activa = elegible en cualquier fecha del torneo), así no cambia nada histórico.
   */
  @Prop({ type: String, default: null })
  registeredAt: string | null;

  /** `YYYY-MM-DD`; null mientras está activa. */
  @Prop({ type: String, default: null })
  endDate: string | null;

  @Prop({ required: true, default: true })
  active: boolean;

  /** Motivo de la baja (obligatorio desde 3A). */
  @Prop({ type: String, default: null })
  endReason: string | null;

  @Prop({ type: [MembershipAuditSchema], default: [] })
  audit: MembershipAudit[];

  createdAt: Date;
  updatedAt: Date;
}

export type TeamMembershipDocument = HydratedDocument<TeamMembership>;
export const TeamMembershipSchema =
  SchemaFactory.createForClass(TeamMembership);
// Un jugador juega con un solo equipo a la vez DENTRO de un torneo (sí en varios torneos).
TeamMembershipSchema.index(
  { tournamentId: 1, playerId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
// Dorsal único dentro de la plantilla activa de un equipo en un torneo.
TeamMembershipSchema.index(
  { tournamentId: 1, teamId: 1, jerseyNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      active: true,
      jerseyNumber: { $type: 'number' },
    },
  },
);
TeamMembershipSchema.index({ playerId: 1, startDate: -1 });
TeamMembershipSchema.index({ teamId: 1, active: 1 });
// 3E: el historial lee todas las participaciones de un torneo (activas o no); los índices de arriba
// por torneo son parciales (solo activas) y no sirven para eso.
TeamMembershipSchema.index({ tournamentId: 1, teamId: 1 });
