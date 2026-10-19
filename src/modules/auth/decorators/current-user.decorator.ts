import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../auth.types.js';

/** Inyecta el usuario autenticado: `@CurrentUser() user: AuthUser` → user.id */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest<{ user: AuthUser }>().user;
  },
);

/**
 * 5B (D4): quien consulta una ruta pública — el usuario si envió un token válido, `null` si es
 * anónimo (ver JwtAuthGuard). Solo para decidir visibilidad (torneos en borrador), nunca permisos.
 */
export const Viewer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | null => {
    return ctx.switchToHttp().getRequest<{ user?: AuthUser }>().user ?? null;
  },
);
