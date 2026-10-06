import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { UserRole } from '../../../common/enums/index.js';

/**
 * Cuenta autenticada de la plataforma. NO es un Player: un organizador registra jugadores
 * que no tienen cuenta. En el futuro un User podrá reclamar un Player (no implementado).
 */
@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: 254,
  })
  email: string;

  /** Hash Argon2id. Nunca se selecciona por defecto ni se serializa. */
  @Prop({ required: true, select: false })
  passwordHash: string;

  @Prop({ required: true, trim: true, maxlength: 60 })
  firstName: string;

  @Prop({ required: true, trim: true, maxlength: 80 })
  lastName: string;

  /**
   * LEGACY: rol de plataforma de V1. Toda cuenta es ORGANIZER y ningún guard lo usa para
   * autorizar. NO es un tipo de cuenta ni debe ampliarse (PLAYER, MANAGER…): los roles de una
   * persona salen de sus relaciones (Tournament.organizerId, TeamAdmin, futuro Player claim).
   */
  @Prop({
    required: true,
    enum: UserRole,
    type: String,
    default: UserRole.ORGANIZER,
  })
  role: UserRole;

  /**
   * Capacidad de ORGANIZAR torneos, activada por la propia persona ("Quiero organizar un torneo").
   * No es un rol ni excluye nada: la misma cuenta puede administrar equipos y organizar. Quien ya
   * organiza algún torneo la tiene igualmente (ver OrganizerAccessService). null = no activada.
   */
  @Prop({ type: Date, default: null })
  organizerEnabledAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type UserDocument = HydratedDocument<User>;
export const UserSchema = SchemaFactory.createForClass(User);
