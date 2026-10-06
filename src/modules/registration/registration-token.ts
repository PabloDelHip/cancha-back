import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Token del enlace de inscripción. Solo primitivas estándar de Node (sin criptografía propia):
 * - generación: 32 bytes de `randomBytes` (CSPRNG) en base64url → 43 caracteres, 256 bits;
 *   no depende del torneo ni del organizador, no es secuencial ni enumerable;
 * - búsqueda: SHA-256 del token (índice único). Un token de 256 bits aleatorios no necesita sal;
 * - re-lectura por el organizador: AES-256-GCM con clave derivada por HKDF-SHA256 del secreto del
 *   servidor (dominio propio), para poder volver a copiar el enlace sin guardarlo en claro.
 */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newRegistrationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRegistrationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function keyFrom(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'cancha:registration-link:v1', 32));
}

/** `iv.tag.ciphertext` en base64url. */
export function encryptRegistrationToken(token: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decryptRegistrationToken(payload: string, secret: string): string {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
