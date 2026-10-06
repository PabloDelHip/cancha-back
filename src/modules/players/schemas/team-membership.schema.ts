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

  /** `YYYY-MM-DD` */
  @Prop({ required: true })
  startDate: string;

  /** `YYYY-MM-DD`; null mientras está activa. */
  @Prop({ type: String, default: null })
  endDate: string | null;

  @Prop({ required: true, default: true })
  active: boolean;

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
