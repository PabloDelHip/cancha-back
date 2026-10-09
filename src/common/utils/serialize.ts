import { Types } from 'mongoose';

/**
 * Campos internos que nunca salen por la API:
 * - organizerId / createdBy: sirven para autorizar en el servidor; el cliente no los necesita
 *   (los listados de /admin devuelven `canEdit` calculado por el backend).
 * - searchName: índice de búsqueda.
 * - writeSeq: cerrojo lógico de escrituras del torneo.
 * - photoPublicId / logoPublicId / coverPublicId: id del archivo en Cloudinary (para reemplazarlo o borrarlo).
 */
const INTERNAL_FIELDS = new Set(['__v', 'organizerId', 'createdBy', 'searchName', 'writeSeq', 'photoPublicId', 'logoPublicId', 'coverPublicId']);
type InternalField = '_id' | '__v' | 'organizerId' | 'createdBy' | 'searchName' | 'writeSeq' | 'photoPublicId' | 'logoPublicId' | 'coverPublicId';

/**
 * Convierte un documento `lean()` en JSON para la API:
 * `_id` → `id`, ObjectId → string, sin campos internos. Recursivo para subdocumentos.
 */
export type Serialized<T> = T extends Types.ObjectId
  ? string
  : T extends Date
    ? Date
    : T extends Array<infer U>
      ? Serialized<U>[]
      : T extends object
        ? {
            [K in keyof T as K extends InternalField ? never : K]: Serialized<
              T[K]
            >;
          } & ('_id' extends keyof T ? { id: string } : unknown)
        : T;

export function serialize<T>(value: T): Serialized<T> {
  return convert(value) as Serialized<T>;
}

function convert(value: unknown): unknown {
  if (value instanceof Types.ObjectId) return value.toHexString();
  if (value instanceof Date || value === null || typeof value !== 'object')
    return value;
  if (Array.isArray(value)) return value.map(convert);

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (INTERNAL_FIELDS.has(key)) continue;
    if (key === '_id') out.id = convert(v);
    else out[key] = convert(v);
  }
  return out;
}

export function toObjectId(id: string | Types.ObjectId): Types.ObjectId {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

export function sameId(
  a: string | Types.ObjectId | null | undefined,
  b: string | Types.ObjectId | null | undefined,
) {
  return a != null && b != null && a.toString() === b.toString();
}

/** Tipo de un documento poblado con `populate()` (incluye su _id). */
export type WithId<T> = T & { _id: Types.ObjectId };
