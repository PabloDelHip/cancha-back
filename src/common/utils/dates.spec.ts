import { describe, expect, it } from 'vitest';
import { todayISODate } from './dates.js';

describe('todayISODate (zona de las ligas, no la del servidor)', () => {
  it('bug 2026-10-18: con el servidor en UTC, las 23:20 del 18 en Cancún siguen siendo el 18', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'UTC'; // como Cloud Run
    try {
      const night = new Date('2026-10-19T04:20:00Z'); // 18 oct, 23:20 en Cancún (UTC-5)
      expect(todayISODate(night)).toBe('2026-10-18');
      expect(todayISODate(new Date('2026-10-19T05:00:00Z'))).toBe('2026-10-19'); // medianoche local
    } finally {
      process.env.TZ = tz;
    }
  });

  it('respeta APP_TIME_ZONE y una zona explícita', () => {
    const night = new Date('2026-10-19T04:20:00Z');
    expect(todayISODate(night, 'UTC')).toBe('2026-10-19');
    expect(todayISODate(night, 'America/Mazatlan')).toBe('2026-10-18');
    const prev = process.env.APP_TIME_ZONE;
    process.env.APP_TIME_ZONE = 'Europe/Madrid';
    try {
      expect(todayISODate(night)).toBe('2026-10-19');
    } finally {
      if (prev === undefined) delete process.env.APP_TIME_ZONE;
      else process.env.APP_TIME_ZONE = prev;
    }
  });
});
