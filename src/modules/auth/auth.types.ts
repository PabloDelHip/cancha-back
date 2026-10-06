import type { UserRole } from '../../common/enums/index.js';

/** Usuario autenticado disponible en request.user (derivado del access token). */
export interface AuthUser {
  id: string;
  role: UserRole;
}

/** Claims del access token: solo lo imprescindible. */
export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}

/** Claims del refresh token: usuario y sesión a la que pertenece. */
export interface RefreshTokenPayload {
  sub: string;
  sid: string;
}

/**
 * `__session`: es la ÚNICA cookie que Firebase Hosting reenvía a Cloud Run (descarta las demás).
 * El frontend se sirve desde Firebase y llama a `/api` en su mismo dominio (rewrite a Cloud Run):
 * la cookie es de primera parte y la sesión sobrevive a recargas en cualquier navegador.
 */
export const REFRESH_COOKIE = '__session';
/** Nombre anterior: se sigue aceptando (y se limpia) para no cerrar sesiones al migrar. */
export const LEGACY_REFRESH_COOKIE = 'cancha_rt';
/** La cookie solo viaja a los endpoints de autenticación. */
export const REFRESH_COOKIE_PATH = '/api/auth';
