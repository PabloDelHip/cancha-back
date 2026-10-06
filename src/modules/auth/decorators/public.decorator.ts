import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marca un endpoint como público (sin JWT). Todo lo demás requiere autenticación:
 * olvidar este decorador deja la ruta protegida, nunca abierta.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
