import { Global, Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service.js';
import { ImagesService } from './images.service.js';

/** Imágenes en Cloudinary (MongoDB solo guarda URL y public_id). Global, como la autorización. */
@Global()
@Module({
  providers: [CloudinaryService, ImagesService],
  exports: [CloudinaryService, ImagesService],
})
export class MediaModule {}
