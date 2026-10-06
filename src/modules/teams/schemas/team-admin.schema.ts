import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { TeamAdminRole, TeamAdminSource, TeamAdminStatus } from '../../../common/enums/index.js';

/**
 * Quién administra un Team (global). Separado de:
 * - `Team.createdBy`: quién registró la ficha (auditoría; custodia provisional mientras no hay OWNER).
 * - `Tournament.organizerId`: quién controla la participación del equipo en SU torneo.
 *
 * Un registro por concesión de rol. Retirar un rol no borra: status INACTIVE + revokedAt/By, así
 * se sabe quién tuvo acceso y cuándo. Volver a conceder crea un registro nuevo.
 *
 * Invariantes (índices únicos parciales, no solo validación en código):
 * - como máximo un OWNER ACTIVE por equipo;
 * - como máximo un rol ACTIVE por (equipo, usuario): nadie es OWNER y MANAGER a la vez ni
 *   MANAGER duplicado.
 */
@Schema({ timestamps: true, collection: 'team_admins' })
export class TeamAdmin {
  @Prop({ type: Types.ObjectId, ref: 'Team', required: true })
  teamId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, enum: TeamAdminRole, type: String })
  role: TeamAdminRole;

  @Prop({ required: true, enum: TeamAdminStatus, type: String, default: TeamAdminStatus.ACTIVE })
  status: TeamAdminStatus;

  @Prop({ required: true, enum: TeamAdminSource, type: String })
  source: TeamAdminSource;

  /** Quién concedió el rol (null = asignación interna). */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  grantedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  revokedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  revokedBy: Types.ObjectId | null;

  /** createdAt = cuándo se concedió. */
  createdAt: Date;
  updatedAt: Date;
}

export type TeamAdminDocument = HydratedDocument<TeamAdmin>;
export const TeamAdminSchema = SchemaFactory.createForClass(TeamAdmin);
TeamAdminSchema.index(
  { teamId: 1 },
  { unique: true, name: 'one_active_owner_per_team', partialFilterExpression: { role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE } },
);
TeamAdminSchema.index(
  { teamId: 1, userId: 1 },
  { unique: true, name: 'one_active_role_per_user_team', partialFilterExpression: { status: TeamAdminStatus.ACTIVE } },
);
// "Mis equipos" (6C) y comprobación de permisos por usuario.
TeamAdminSchema.index({ userId: 1, status: 1 });
