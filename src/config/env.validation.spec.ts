import { durationToSeconds, validateEnv } from './env.validation.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/x',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
};

describe('validateEnv', () => {
  it('sesión "eterna" por defecto: refresh de 365 días (ventana deslizante en auth.service)', () => {
    const env = validateEnv(base);
    expect(env.JWT_REFRESH_EXPIRES_IN).toBe('365d');
    expect(durationToSeconds(env.JWT_REFRESH_EXPIRES_IN)).toBe(365 * 86_400);
    expect(env.JWT_ACCESS_EXPIRES_IN).toBe('15m');
  });

  it('respeta un valor configurado y rechaza formatos inválidos', () => {
    expect(validateEnv({ ...base, JWT_REFRESH_EXPIRES_IN: '30d' }).JWT_REFRESH_EXPIRES_IN).toBe('30d');
    expect(() => validateEnv({ ...base, JWT_REFRESH_EXPIRES_IN: 'un año' })).toThrow(/JWT_REFRESH_EXPIRES_IN/);
  });

  it('Cloudinary: las tres o ninguna', () => {
    expect(validateEnv(base).CLOUDINARY_CLOUD_NAME).toBeNull();
    expect(() => validateEnv({ ...base, CLOUDINARY_CLOUD_NAME: 'x' })).toThrow(/CLOUDINARY/);
  });
});
