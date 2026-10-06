import { BadRequestException, UnsupportedMediaTypeException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';

/** Tamaño máximo de una imagen subida (antes de optimizar). Las fotos de móvil caben de sobra. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Formatos aceptados. SVG no: puede llevar scripts. */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

/** Archivo recibido por multer en memoria (lo que usa este módulo). */
export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname: string;
}

/**
 * Multer en memoria (nada se escribe en disco: compatible con Cloud Run y FS de solo lectura).
 * Límite de tamaño → 413 (lo traduce Nest). Tipo declarado no aceptado → 415. El tipo REAL se
 * comprueba después por contenido (assertImage), porque el mimetype lo decide el cliente.
 */
export const imageUploadOptions: MulterOptions = {
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => {
    if ((ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.mimetype)) cb(null, true);
    else cb(new UnsupportedMediaTypeException(unsupportedMessage()), false);
  },
};

const unsupportedMessage = () => 'Solo se aceptan imágenes JPG, PNG, WebP, GIF o AVIF';

/** Tipo real por la firma de los primeros bytes (null si no es una imagen aceptada). */
export function detectImageType(buf: Buffer): AcceptedImageType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp' && /^avi[fs]$/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/avif';
  return null;
}

/** Valida presencia, tamaño y contenido real. */
export function assertImage(file: UploadedImage | undefined): asserts file is UploadedImage {
  if (!file?.buffer?.length) throw new BadRequestException('Adjunta una imagen en el campo "file" (multipart/form-data)');
  if (file.size > MAX_IMAGE_BYTES) throw new BadRequestException('La imagen supera 5 MB');
  if (!detectImageType(file.buffer)) throw new UnsupportedMediaTypeException(unsupportedMessage());
}
