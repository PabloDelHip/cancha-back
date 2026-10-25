import { Injectable, NotFoundException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { CloudinaryService, type ImagePreset } from './cloudinary.service.js';
import { assertImage, type UploadedImage } from './image-upload.js';

/** Par de campos de una entidad con imagen: URL pública + public_id interno. */
export interface ImageFields {
  url: string;
  publicId: string;
}

/**
 * 10C: `keep(url)` = la imagen que se reemplaza sigue en uso en otro lado (p. ej. el escudo con que
 * un equipo jugó un torneo finalizado): se deja en Cloudinary en lugar de borrarla.
 */
export type KeepImage = (previousUrl: string) => Promise<boolean>;

/** Solo se escriben los dos campos de imagen: el modelo concreto da igual aquí. */
type AnyModel = Model<Record<string, unknown>>;
const asModel = <T>(model: Model<T>) => model as unknown as AnyModel;

/**
 * Reemplazo de la imagen de una entidad (jugador, equipo). La AUTORIZACIÓN la decide antes el
 * service de cada entidad, con sus reglas de siempre; aquí solo se guarda y se limpia:
 *
 *   validar contenido → subir la nueva → intercambiar URL/public_id en UNA escritura atómica
 *   (devuelve el documento anterior) → borrar de Cloudinary la imagen que se reemplazó.
 *
 * Cada petición borra exactamente lo que ella reemplazó: dos subidas simultáneas no dejan huérfanas
 * ni borran dos veces. Si la entidad desapareció entre medias, se borra la recién subida.
 */
@Injectable()
export class ImagesService {
  constructor(private readonly cloudinary: CloudinaryService) {}

  async replace<T>(
    model: Model<T>,
    id: string,
    fields: ImageFields,
    file: UploadedImage | undefined,
    preset: ImagePreset,
    keep?: KeepImage,
  ) {
    assertImage(file);
    const stored = await this.cloudinary.upload(file, preset);
    const previous = await asModel(model)
      .findByIdAndUpdate(id, { $set: { [fields.url]: stored.url, [fields.publicId]: stored.publicId } }, { returnDocument: 'before' })
      .select(`${fields.url} ${fields.publicId}`)
      .lean<Record<string, unknown>>();
    if (!previous) {
      await this.cloudinary.destroy(stored.publicId);
      throw new NotFoundException('El recurso ya no existe');
    }
    await this.discard(previous, fields, keep);
  }

  /** Quita la imagen (URL y public_id a null) y la borra de Cloudinary si era nuestra. */
  async remove<T>(model: Model<T>, id: string, fields: ImageFields, keep?: KeepImage) {
    const previous = await asModel(model)
      .findByIdAndUpdate(id, { $set: { [fields.url]: null, [fields.publicId]: null } }, { returnDocument: 'before' })
      .select(`${fields.url} ${fields.publicId}`)
      .lean<Record<string, unknown>>();
    if (!previous) throw new NotFoundException('El recurso ya no existe');
    await this.discard(previous, fields, keep);
  }

  /** Borra de Cloudinary la imagen reemplazada, salvo que siga en uso (`keep`). */
  private async discard(previous: Record<string, unknown>, fields: ImageFields, keep?: KeepImage) {
    const url = previous[fields.url] as string | null | undefined;
    if (keep && url && (await keep(url))) return;
    await this.cloudinary.destroy(previous[fields.publicId] as string | null);
  }
}
