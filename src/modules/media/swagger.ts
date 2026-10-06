import type { ApiBodyOptions } from '@nestjs/swagger';

/** Cuerpo multipart de las subidas de imagen (documentación Swagger). */
export const IMAGE_FILE_BODY: ApiBodyOptions = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: { file: { type: 'string', format: 'binary', description: 'JPG, PNG, WebP, GIF o AVIF · máx. 5 MB' } },
  },
};
