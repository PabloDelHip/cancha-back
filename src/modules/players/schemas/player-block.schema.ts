import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * 3D — bloqueo ADMINISTRATIVO de un jugador en un torneo (documentación, pago, conducta…). No es
 * una sanción disciplinaria: no se cumple con partidos ni aparece en Disciplina; lo aplica y lo
 * levanta el propietario o un administrador, siempre con motivo.
 *
 * Vigencia: desde `since` (inclusive) hasta `until` (exclusive; null = vigente). Mientras está
 * vigente impide inscribirlo, transferirlo y que participe en partidos de esas fechas; lo ya
 * registrado en un partido no se revalida (regla de 3B). Cada documento es un periodo: levantarlo
 * lo cierra y un bloqueo nuevo abre otro, así el historial completo queda en la colección. Es
 * interno: el motivo nunca sale en lecturas públicas; el equipo solo ve que está bloqueado.
 */
@Schema({ timestamps: true, collection: 'player_blocks' })
export class PlayerBlock {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Player', required: true })
  playerId: Types.ObjectId;

  /** `YYYY-MM-DD`: primer día bloqueado. Anterior a la fecha real del bloqueo = retroactivo (excepción). */
  @Prop({ required: true })
  since: string;

  @Prop({ required: true, trim: true, maxlength: 300 })
  reason: string;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  blockedBy: Types.ObjectId;

  @Prop({ type: String, default: null })
  blockedRole: string | null;

  /** `YYYY-MM-DD`: primer día ya habilitado. null = bloqueo vigente. */
  @Prop({ type: String, default: null })
  until: string | null;

  @Prop({ type: String, default: null, trim: true, maxlength: 300 })
  liftReason: string | null;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  liftedBy: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  liftedRole: string | null;

  @Prop({ type: Date, default: null })
  liftedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;
}

export type PlayerBlockDocument = HydratedDocument<PlayerBlock>;
export const PlayerBlockSchema = SchemaFactory.createForClass(PlayerBlock);
PlayerBlockSchema.index({ tournamentId: 1, playerId: 1, since: 1 });
// Un solo bloqueo vigente por jugador y torneo (además del cerrojo del torneo).
PlayerBlockSchema.index(
  { tournamentId: 1, playerId: 1 },
  { name: 'one_open_block_per_player', unique: true, partialFilterExpression: { until: null } },
);
