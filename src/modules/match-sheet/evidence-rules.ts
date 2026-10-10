/**
 * Reglas de las fotografías de evidencia (2D), sin base de datos ni red.
 */
import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import { ACCEPTED_IMAGE_TYPES, detectImageType, type UploadedImage } from '../media/image-upload.js';

/** Fotos de celular de una cédula: caben de sobra. Se reducen al guardar (lado mayor ≤ 2400 px). */
export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
/** Fotografías ACTIVAS por partido. */
export const MAX_EVIDENCE_PER_MATCH = 20;
/** Vigencia de la URL temporal de una fotografía. */
export const EVIDENCE_URL_TTL_SECONDS = 300;
export const EVIDENCE_FOLDER = 'kikovo/evidence';
export const EVIDENCE_INCOMING = 'c_limit,w_2400,h_2400';
/** Una subida sin registro (interrumpida) se considera huérfana pasado este margen. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
/** El archivo de una fotografía retirada se conserva (privado) este tiempo antes de purgarse. */
export const REMOVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const unsupported = () => 'Solo se aceptan imágenes JPG, PNG, WebP, GIF o AVIF';

/** Multer en memoria: un archivo de hasta 8 MB y los campos de texto de la evidencia. */
export const evidenceUploadOptions: MulterOptions = {
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: 1, fields: 6, fieldSize: 2048 },
  fileFilter: (_req, file, cb) => {
    if ((ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.mimetype)) cb(null, true);
    else cb(new UnsupportedMediaTypeException(unsupported()), false);
  },
};

/** Presencia, tamaño y tipo REAL por contenido (el mimetype lo decide el cliente). */
export function assertEvidenceImage(file: UploadedImage | undefined): asserts file is UploadedImage {
  if (!file?.buffer?.length) throw new BadRequestException('Adjunta la fotografía en el campo "file" (multipart/form-data)');
  if (file.size > MAX_EVIDENCE_BYTES) throw new BadRequestException('La fotografía supera 8 MB');
  if (!detectImageType(file.buffer)) throw new UnsupportedMediaTypeException(unsupported());
}

/** Ruta privada determinista: reintentar la misma subida reemplaza el mismo archivo. */
export const evidencePublicId = (tournamentId: string, matchId: string, uploadKey: string) => `${EVIDENCE_FOLDER}/${tournamentId}/${matchId}/${uploadKey}`;

/**
 * Plan de limpieza segura:
 * - Huérfanos: archivos bajo la carpeta de evidencias sin registro y con más de 24 h (subidas
 *   interrumpidas o cuyo registro falló). Los recientes no se tocan: pueden estar a medio guardar.
 * - Retiradas: archivos de fotografías retiradas hace más de 30 días y aún no purgadas.
 * Nunca incluye una fotografía activa.
 */
export function cleanupPlan(input: {
  resources: { publicId: string; createdAt: Date }[];
  records: { publicId: string; status: string; removedAt: Date | null; purgedAt: Date | null }[];
  now: Date;
}) {
  const byId = new Map(input.records.map((r) => [r.publicId, r]));
  const orphans = input.resources.filter((r) => !byId.has(r.publicId) && input.now.getTime() - r.createdAt.getTime() > ORPHAN_GRACE_MS).map((r) => r.publicId);
  const purge = input.records
    .filter((r) => r.status === 'REMOVED' && !r.purgedAt && r.removedAt && input.now.getTime() - r.removedAt.getTime() > REMOVED_RETENTION_MS)
    .map((r) => r.publicId);
  return { orphans, purge };
}
