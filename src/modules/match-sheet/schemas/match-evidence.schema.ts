import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EvidenceKind, EvidenceStatus } from '../../../common/enums/index.js';

/**
 * Fotografía de evidencia de un partido (Módulo 2D): cédula arbitral, alineaciones, incidencias,
 * marcador… El archivo es PRIVADO en Cloudinary (`type=private`): nunca hay URL pública; se entrega
 * con URL firmada y con vencimiento tras comprobar permisos. Retirarla no borra el registro.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'match_evidence' })
export class MatchEvidence {
  @Prop({ type: Types.ObjectId, ref: 'Tournament', required: true })
  tournamentId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Match', required: true })
  matchId: Types.ObjectId;

  @Prop({ type: String, enum: EvidenceKind, required: true })
  kind: EvidenceKind;

  @Prop({ type: String, default: null, trim: true, maxlength: 300 })
  description: string | null;

  /** Incidencia a la que documenta (opcional). */
  @Prop({ type: Types.ObjectId, ref: 'MatchIncident', default: null })
  incidentId: Types.ObjectId | null;

  /** Clave de la subida que manda el cliente: reintentar la misma subida no duplica. */
  @Prop({ type: String, required: true })
  uploadKey: string;

  /** Interno: nunca sale por la API. */
  @Prop({ type: String, required: true })
  publicId: string;

  @Prop({ type: String, required: true })
  format: string;

  @Prop({ type: Number, required: true })
  bytes: number;

  @Prop({ type: String, enum: EvidenceStatus, default: EvidenceStatus.ACTIVE })
  status: EvidenceStatus;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  uploadedBy: Types.ObjectId;

  @Prop({ type: String, default: null })
  uploadedRole: string | null;

  @Prop({ type: Object, default: null })
  removed: { at: Date; by: Types.ObjectId; role: string | null; reason: string } | null;

  /** El archivo de una retirada se purga de Cloudinary pasado el plazo (script de limpieza). */
  @Prop({ type: Date, default: null })
  purgedAt: Date | null;

  createdAt: Date;
}

export type MatchEvidenceDocument = HydratedDocument<MatchEvidence>;
export const MatchEvidenceSchema = SchemaFactory.createForClass(MatchEvidence);
MatchEvidenceSchema.index({ matchId: 1, uploadKey: 1 }, { unique: true });
MatchEvidenceSchema.index({ matchId: 1, createdAt: 1 });
MatchEvidenceSchema.index({ publicId: 1 });
