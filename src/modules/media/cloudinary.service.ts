import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { EnvConfig } from '../../config/env.validation.js';
import type { UploadedImage } from './image-upload.js';

/** Cómo se guarda y se entrega cada tipo de imagen. */
export interface ImagePreset {
  /** Carpeta en Cloudinary. */
  folder: string;
  /** Transformación al SUBIR: limita lo que se almacena (nunca amplía). */
  incoming: string;
  /** Transformación al ENTREGAR: formato y calidad automáticos (WebP/AVIF según el navegador). */
  delivery: string;
}

export const IMAGE_PRESETS = {
  tournamentLogo: { folder: 'kikovo/tournaments', incoming: 'c_limit,w_512,h_512', delivery: 'f_auto,q_auto' },
  playerPhoto: { folder: 'kikovo/players', incoming: 'c_limit,w_800,h_800', delivery: 'f_auto,q_auto' },
  teamLogo: { folder: 'kikovo/teams', incoming: 'c_limit,w_512,h_512', delivery: 'f_auto,q_auto' },
  // Portada: se guarda la foto completa (el encuadre lo hace cada pantalla con coverPosition).
  teamCover: { folder: 'kikovo/covers', incoming: 'c_limit,w_1920,h_1920', delivery: 'f_auto,q_auto' },
} as const satisfies Record<string, ImagePreset>;

export interface StoredImage {
  url: string;
  publicId: string;
}

/**
 * Cliente mínimo de la API REST de Cloudinary (subida firmada y borrado), sin SDK: `fetch` +
 * firma SHA-1 (https://cloudinary.com/documentation/authentication_signatures). Credenciales solo
 * desde variables de entorno; sin ellas, las subidas responden 503 y el resto del API funciona.
 */
@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private readonly cloudName: string | null;
  private readonly apiKey: string | null;
  private readonly apiSecret: string | null;
  /** Base del API (la real; en pruebas puede apuntar a un almacenamiento simulado). */
  private readonly apiUrl: string;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.cloudName = config.get('CLOUDINARY_CLOUD_NAME', { infer: true });
    this.apiKey = config.get('CLOUDINARY_API_KEY', { infer: true });
    this.apiSecret = config.get('CLOUDINARY_API_SECRET', { infer: true });
    this.apiUrl = config.get('CLOUDINARY_API_URL', { infer: true }) ?? 'https://api.cloudinary.com';
  }

  get configured() {
    return !!(this.cloudName && this.apiKey && this.apiSecret);
  }

  /** Sube la imagen y devuelve la URL de entrega optimizada + public_id. */
  async upload(file: UploadedImage, preset: ImagePreset): Promise<StoredImage> {
    const params = { folder: preset.folder, timestamp: now(), transformation: preset.incoming };
    const form = this.signedForm(params);
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), 'upload');
    const res = await this.post('upload', form);
    if (!res.ok) throw await this.failure('subir la imagen', res);
    const body = (await res.json()) as { public_id: string; version: number };
    return { publicId: body.public_id, url: this.deliveryUrl(body.public_id, body.version, preset.delivery) };
  }

  /**
   * Subida PRIVADA (`type=private`, evidencias de partidos): nunca hay URL pública; se entrega solo
   * con una URL firmada y con vencimiento (`privateUrl`). `public_id` determinista + `overwrite`:
   * reintentar la misma subida reemplaza el mismo archivo en vez de dejar copias.
   */
  async uploadPrivate(file: UploadedImage, opts: { publicId: string; incoming: string }): Promise<{ publicId: string; version: number; format: string; bytes: number }> {
    const form = this.signedForm({ overwrite: 'true', public_id: opts.publicId, timestamp: now(), transformation: opts.incoming, type: 'private' });
    form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), 'upload');
    const res = await this.post('upload', form);
    if (!res.ok) throw await this.failure('subir la imagen', res);
    const body = (await res.json()) as { public_id: string; version: number; format: string; bytes: number };
    return { publicId: body.public_id, version: body.version, format: body.format, bytes: body.bytes };
  }

  /**
   * URL temporal de un archivo privado (API de descarga firmada con `expires_at`). Se genera sin
   * red, después de comprobar permisos; caduca sola y no sirve para otro archivo.
   */
  privateUrl(publicId: string, format: string, ttlSeconds: number) {
    this.assertConfigured();
    const expiresAt = now() + ttlSeconds;
    const params = { attachment: 'false', expires_at: expiresAt, format, public_id: publicId, timestamp: now(), type: 'private' };
    const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_key: this.apiKey!, signature: CloudinaryService.sign(params, this.apiSecret!) });
    return { url: `${this.apiUrl}/v1_1/${this.cloudName}/image/download?${query}`, expiresAt: new Date(expiresAt * 1000) };
  }

  /** Una página de archivos privados bajo un prefijo (Admin API), para limpiar huérfanos. */
  async listPrivate(prefix: string, cursor?: string): Promise<{ resources: { publicId: string; createdAt: Date }[]; nextCursor: string | null }> {
    this.assertConfigured();
    const query = new URLSearchParams({ prefix, max_results: '500', ...(cursor ? { next_cursor: cursor } : {}) });
    let res: Response;
    try {
      res = await fetch(`${this.apiUrl}/v1_1/${this.cloudName}/resources/image/private?${query}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64')}` },
      });
    } catch (e) {
      throw new BadGatewayException(`El servicio de imágenes no está disponible: ${(e as Error).message}`);
    }
    if (!res.ok) throw await this.failure('listar las imágenes', res);
    const body = (await res.json()) as { resources: { public_id: string; created_at: string }[]; next_cursor?: string };
    return { resources: body.resources.map((r) => ({ publicId: r.public_id, createdAt: new Date(r.created_at) })), nextCursor: body.next_cursor ?? null };
  }

  /**
   * Borra una imagen (y la invalida en la CDN). Nunca lanza: una imagen huérfana es preferible a
   * fallar una operación que ya se guardó; el fallo queda en el log.
   */
  async destroy(publicId: string | null | undefined): Promise<void> {
    await this.remove(publicId, 'upload');
  }

  /** Borra un archivo privado (evidencia). Nunca lanza; devuelve si se borró. */
  destroyPrivate(publicId: string): Promise<boolean> {
    return this.remove(publicId, 'private');
  }

  private async remove(publicId: string | null | undefined, type: 'upload' | 'private'): Promise<boolean> {
    if (!publicId || !this.configured) return false;
    try {
      const res = await this.post('destroy', this.signedForm({ invalidate: 'true', public_id: publicId, timestamp: now(), ...(type === 'private' ? { type } : {}) }));
      if (!res.ok) this.logger.warn(`No se pudo borrar ${publicId} de Cloudinary (HTTP ${res.status})`);
      return res.ok;
    } catch (e) {
      this.logger.warn(`No se pudo borrar ${publicId} de Cloudinary: ${(e as Error).message}`);
      return false;
    }
  }

  /** URL https con la transformación de entrega delante de la versión (cache-busting por versión). */
  deliveryUrl(publicId: string, version: number, delivery: string) {
    return `https://res.cloudinary.com/${this.cloudName}/image/upload/${delivery}/v${version}/${publicId}`;
  }

  /** Firma: parámetros ordenados `k=v&k2=v2` + api_secret → SHA-1 hex. */
  static sign(params: Record<string, string | number>, apiSecret: string) {
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return createHash('sha1').update(toSign + apiSecret).digest('hex');
  }

  private signedForm(params: Record<string, string | number>) {
    this.assertConfigured();
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append('api_key', this.apiKey!);
    form.append('signature', CloudinaryService.sign(params, this.apiSecret!));
    return form;
  }

  private async post(action: 'upload' | 'destroy', form: FormData) {
    try {
      return await fetch(`${this.apiUrl}/v1_1/${this.cloudName}/image/${action}`, { method: 'POST', body: form });
    } catch (e) {
      this.logger.error(`Cloudinary no responde (${action}): ${(e as Error).message}`);
      throw new BadGatewayException('El servicio de imágenes no está disponible. Inténtalo de nuevo.');
    }
  }

  private async failure(what: string, res: Response) {
    const detail = await res.text().catch(() => '');
    this.logger.error(`Cloudinary rechazó ${what} (HTTP ${res.status}): ${detail.slice(0, 200)}`);
    return new BadGatewayException(`No se pudo ${what}. Inténtalo de nuevo.`);
  }

  private assertConfigured() {
    if (!this.configured) throw new ServiceUnavailableException('La subida de imágenes no está configurada en este servidor');
  }
}

const now = () => Math.floor(Date.now() / 1000);
