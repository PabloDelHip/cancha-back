/**
 * Validación de variables de entorno al arrancar.
 * Falla rápido con un mensaje claro en lugar de errores crípticos más tarde.
 */
export interface EnvConfig {
  PORT: number;
  MONGODB_URI: string;
  FRONTEND_URL: string;
  NODE_ENV: 'development' | 'production' | 'test';
  JWT_ACCESS_SECRET: string;
  JWT_ACCESS_EXPIRES_IN: string;
  JWT_REFRESH_SECRET: string;
  JWT_REFRESH_EXPIRES_IN: string;
  /** Intentos de login/registro permitidos por IP y endpoint en cada ventana. */
  AUTH_THROTTLE_LIMIT: number;
  /** Refrescos permitidos por IP en cada ventana (cada carga de página hace uno). */
  AUTH_REFRESH_THROTTLE_LIMIT: number;
  /** Ventana del rate limit de auth, en segundos. */
  AUTH_THROTTLE_TTL: number;
  /**
   * Proxies de confianza delante del API (Express `trust proxy`). 0 (defecto) = conexión directa.
   * Detrás de Cloud Run: 1, para que req.ip (rate limit por IP) sea la del cliente y no la del proxy.
   */
  TRUST_PROXY_HOPS: number;
  /**
   * Cloudinary (imágenes de jugadores y equipos). Opcionales: sin ellas el API arranca igual y
   * las subidas responden 503. Van las tres o ninguna.
   */
  CLOUDINARY_CLOUD_NAME: string | null;
  CLOUDINARY_API_KEY: string | null;
  CLOUDINARY_API_SECRET: string | null;
  /** API de Cloudinary (por defecto la real). Solo se cambia para pruebas con un almacenamiento simulado. */
  CLOUDINARY_API_URL: string;
}

/** Duraciones estilo "15m", "7d", "3600s" o segundos. */
const DURATION = /^\d+[smhd]?$/;
const PLACEHOLDER = /change-me/i;

export function validateEnv(raw: Record<string, unknown>): EnvConfig {
  const errors: string[] = [];
  const str = (key: string, fallback = '') =>
    String(raw[key] ?? fallback).trim();

  const port = Number(raw.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0)
    errors.push('PORT debe ser un entero positivo');

  const mongoUri = str('MONGODB_URI');
  if (!/^mongodb(\+srv)?:\/\//.test(mongoUri))
    errors.push('MONGODB_URI debe ser una URI mongodb:// válida');

  const nodeEnv = str('NODE_ENV', 'development');
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    errors.push('NODE_ENV debe ser development, production o test');
  }

  const accessSecret = str('JWT_ACCESS_SECRET');
  const refreshSecret = str('JWT_REFRESH_SECRET');
  if (!accessSecret) errors.push('JWT_ACCESS_SECRET es obligatorio');
  if (!refreshSecret) errors.push('JWT_REFRESH_SECRET es obligatorio');
  if (accessSecret && accessSecret === refreshSecret) {
    errors.push('JWT_ACCESS_SECRET y JWT_REFRESH_SECRET deben ser distintos');
  }
  if (nodeEnv === 'production') {
    for (const [name, value] of [
      ['JWT_ACCESS_SECRET', accessSecret],
      ['JWT_REFRESH_SECRET', refreshSecret],
    ]) {
      if (value.length < 32 || PLACEHOLDER.test(value)) {
        errors.push(
          `${name} debe ser un secreto aleatorio de al menos 32 caracteres en producción`,
        );
      }
    }
  }

  const accessTtl = str('JWT_ACCESS_EXPIRES_IN', '15m');
  // Sesión "eterna" con ventana deslizante: cada refresh renueva la caducidad (auth.service), así
  // que solo caduca tras este tiempo SIN usar la app. Revocable siempre con logout / logout-all.
  const refreshTtl = str('JWT_REFRESH_EXPIRES_IN', '365d');
  if (!DURATION.test(accessTtl))
    errors.push('JWT_ACCESS_EXPIRES_IN debe tener formato como 15m, 1h o 900');
  if (!DURATION.test(refreshTtl))
    errors.push(
      'JWT_REFRESH_EXPIRES_IN debe tener formato como 7d, 12h o 604800',
    );

  const throttleLimit = Number(raw.AUTH_THROTTLE_LIMIT ?? 10);
  const refreshThrottleLimit = Number(raw.AUTH_REFRESH_THROTTLE_LIMIT ?? 60);
  const throttleTtl = Number(raw.AUTH_THROTTLE_TTL ?? 60);
  if (!Number.isInteger(refreshThrottleLimit) || refreshThrottleLimit <= 0) {
    errors.push('AUTH_REFRESH_THROTTLE_LIMIT debe ser un entero positivo');
  }
  if (!Number.isInteger(throttleLimit) || throttleLimit <= 0)
    errors.push('AUTH_THROTTLE_LIMIT debe ser un entero positivo');
  if (!Number.isInteger(throttleTtl) || throttleTtl <= 0)
    errors.push('AUTH_THROTTLE_TTL debe ser un entero positivo');

  const trustProxyHops = Number(raw.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0)
    errors.push('TRUST_PROXY_HOPS debe ser un entero ≥ 0');

  const cloudinary = (['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const).map((k) => str(k) || null);
  if (cloudinary.some(Boolean) && !cloudinary.every(Boolean))
    errors.push('CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET van juntas (las tres o ninguna)');
  if (cloudinary[0] && !/^[a-z0-9_-]+$/i.test(cloudinary[0]))
    errors.push('CLOUDINARY_CLOUD_NAME no es válido');
  const cloudinaryApi = str('CLOUDINARY_API_URL', 'https://api.cloudinary.com').replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(cloudinaryApi)) errors.push('CLOUDINARY_API_URL no es una URL válida');
  if (nodeEnv === 'production' && cloudinaryApi !== 'https://api.cloudinary.com')
    errors.push('CLOUDINARY_API_URL solo puede cambiarse fuera de producción');

  if (errors.length)
    throw new Error(`Configuración inválida:\n - ${errors.join('\n - ')}`);

  return {
    PORT: port,
    MONGODB_URI: mongoUri,
    FRONTEND_URL: str('FRONTEND_URL', 'http://localhost:5173'),
    NODE_ENV: nodeEnv as EnvConfig['NODE_ENV'],
    JWT_ACCESS_SECRET: accessSecret,
    JWT_ACCESS_EXPIRES_IN: accessTtl,
    JWT_REFRESH_SECRET: refreshSecret,
    JWT_REFRESH_EXPIRES_IN: refreshTtl,
    AUTH_THROTTLE_LIMIT: throttleLimit,
    AUTH_REFRESH_THROTTLE_LIMIT: refreshThrottleLimit,
    AUTH_THROTTLE_TTL: throttleTtl,
    TRUST_PROXY_HOPS: trustProxyHops,
    CLOUDINARY_CLOUD_NAME: cloudinary[0],
    CLOUDINARY_API_KEY: cloudinary[1],
    CLOUDINARY_API_SECRET: cloudinary[2],
    CLOUDINARY_API_URL: cloudinaryApi,
  };
}

/** "15m" → 900 (segundos). Un número sin unidad son segundos. */
export function durationToSeconds(value: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(value);
  if (!match) throw new Error(`Duración inválida: ${value}`);
  const factor = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[
    match[2] as '' | 's' | 'm' | 'h' | 'd'
  ];
  return Number(match[1]) * factor;
}
