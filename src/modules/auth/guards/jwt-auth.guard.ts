import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

/**
 * Guard global: exige un access token válido salvo en rutas @Public().
 * Registrado como APP_GUARD en AppModule.
 *
 * 5B (D4): en una LECTURA pública (GET) el token es OPCIONAL. Sin `Authorization` se lee como
 * anónimo; si viene, se valida y `request.user` queda disponible (`@Viewer()`), p. ej. para que el
 * propietario y sus colaboradores vean sus torneos en borrador. Un token inválido o vencido responde
 * 401 (no se degrada en silencio a anónimo): así el front renueva la sesión y reintenta. Las rutas
 * públicas que no son GET (login, registro, refresh, logout) ignoran el header como siempre: el
 * refresh llega justamente con el access token vencido.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isPublic) return super.canActivate(context);
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, string | undefined> }>();
    // Un encabezado sin token («Bearer » vacío) no es una credencial: se lee como anónimo.
    const token = req.headers.authorization?.replace(/^Bearer\s*/i, '').trim();
    return req.method === 'GET' && token ? super.canActivate(context) : true;
  }

  handleRequest<TUser>(err: unknown, user: TUser | false): TUser {
    if (err || !user)
      throw new UnauthorizedException('Autenticación requerida');
    return user;
  }
}
