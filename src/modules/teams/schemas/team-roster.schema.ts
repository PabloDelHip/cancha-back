import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TeamRosterStatus } from '../../../common/enums/index.js';

/**
 * Plantilla GLOBAL: el Player pertenece al Team, juegue o no torneos con él. Distinto de
 * TeamMembership (participación Player ↔ Team DENTRO de un torneo, con dorsal de competición).
 *
 * Un documento = un PERIODO de pertenencia. Salir cierra el periodo (INACTIVE + leftAt); volver
 * abre uno nuevo. Así se reconstruye "jugó con Deportivo 2023–2024 y regresó en 2026" sin
 * reescribir historia. Un Player puede tener periodos ACTIVE en varios Teams a la vez (fútbol
 * amateur): no hay "equipo principal".
 *
 * Sin dorsal ni posición: el dorsal es de competición (TeamMembership.jerseyNumber) y la posición
 * es del Player.
 */
@Schema({ timestamps: true, collection: 'team_rosters' })
export class TeamRoster {
  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Player', required: true })
  playerId: Types.ObjectId;

  @Prop({ required: true, enum: TeamRosterStatus, type: String, default: TeamRosterStatus.ACTIVE })
  status: TeamRosterStatus;

  /** Fecha deportiva de alta (YYYY-MM-DD), como TeamMembership.startDate. Hoy = día del alta. */
  @Prop({ required: true })
  joinedAt: string;

  /** Fecha de baja (YYYY-MM-DD); null mientras sigue. */
  @Prop({ type: String, default: null })
  leftAt: string | null;

  /** Usuario (OWNER/MANAGER) que dio de alta / de baja. Auditoría; nunca se publica. */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  addedBy: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  removedBy: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

export type TeamRosterDocument = HydratedDocument<TeamRoster>;
export const TeamRosterSchema = SchemaFactory.createForClass(TeamRoster);
// Invariante: como máximo UN periodo ACTIVE por (equipo, jugador), aunque dos altas corran a la vez.
TeamRosterSchema.index(
  { teamId: 1, playerId: 1 },
  { unique: true, name: 'one_active_period_per_team_player', partialFilterExpression: { status: TeamRosterStatus.ACTIVE } },
);
// Plantilla del equipo (actual o historial) y cuántos jugadores activos tiene cada equipo.
TeamRosterSchema.index({ teamId: 1, status: 1, joinedAt: -1 });
// Equipos de un jugador (borrado del Player; futuro "Actualmente" por plantilla global).
TeamRosterSchema.index({ playerId: 1, status: 1 });
