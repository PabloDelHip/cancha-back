import { describe, expect, it } from 'vitest';
import { MatchStatus } from '../../common/enums/index.js';
import { availabilityWarnings, conflictsAmong, interval, overlaps, reserves, type Slot } from './occupancy.js';

const slot = (date: string, time: string, duration = 60, buffer = 15): Slot => ({ date, time, duration, buffer });

describe('ocupación de canchas', () => {
  it('duración + margen: 18:00 (60+15) ocupa hasta las 19:15', () => {
    expect(overlaps(slot('2027-01-10', '18:00'), slot('2027-01-10', '19:14'))).toBe(true);
    expect(overlaps(slot('2027-01-10', '18:00'), slot('2027-01-10', '19:15'))).toBe(false);
    // El margen también protege al anterior: uno a las 16:50 termina (con margen) a las 18:05.
    expect(overlaps(slot('2027-01-10', '18:00'), slot('2027-01-10', '16:50'))).toBe(true);
    expect(overlaps(slot('2027-01-10', '18:00'), slot('2027-01-10', '16:45'))).toBe(false);
  });

  it('cruza la medianoche: choca con el del día siguiente', () => {
    expect(overlaps(slot('2027-01-10', '23:30'), slot('2027-01-11', '00:30'))).toBe(true);
    expect(overlaps(slot('2027-01-10', '23:30'), slot('2027-01-11', '00:45'))).toBe(false);
    // Fin de mes y de año.
    expect(overlaps(slot('2027-12-31', '23:50', 90), slot('2028-01-01', '01:00'))).toBe(true);
    expect(interval(slot('2027-01-31', '23:00')).end - interval(slot('2027-02-01', '00:00')).start).toBe(15);
  });

  it('cancelados y pospuestos no reservan', () => {
    expect([MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.FINISHED].every(reserves)).toBe(true);
    expect(reserves(MatchStatus.CANCELLED)).toBe(false);
    expect(reserves(MatchStatus.POSTPONED)).toBe(false);
  });

  it('conflictos entre varios partidos (barrido)', () => {
    const pairs = conflictsAmong([
      { id: 'a', ...slot('2027-01-10', '18:00') },
      { id: 'b', ...slot('2027-01-10', '19:15') },
      { id: 'c', ...slot('2027-01-10', '19:30') },
    ]);
    expect(pairs.map(([x, y]) => `${x.id}${y.id}`)).toEqual(['bc']);
  });

  it('disponibilidad: avisa fuera de horario o en fecha cerrada (sin margen)', () => {
    const a = { weekly: [{ day: 0, from: '08:00', to: '20:00' }], closedDates: ['2027-01-17'] };
    // 2027-01-10 es domingo.
    expect(availabilityWarnings(a, slot('2027-01-10', '19:00'))).toEqual([]); // termina 20:00 justo
    expect(availabilityWarnings(a, slot('2027-01-10', '19:30'))).toHaveLength(1);
    expect(availabilityWarnings(a, slot('2027-01-11', '10:00'))).toHaveLength(1); // lunes sin ventana
    expect(availabilityWarnings(a, slot('2027-01-17', '10:00'))).toEqual(['La cancha no está disponible el 2027-01-17']);
    expect(availabilityWarnings({ weekly: [{ day: 0, from: '22:00', to: '24:00' }], closedDates: [] }, slot('2027-01-10', '23:00'))).toEqual([]);
    expect(availabilityWarnings({ weekly: [], closedDates: [] }, slot('2027-01-10', '03:00'))).toEqual([]);
  });
});

describe('árbitros (2B): cada partido con su margen', () => {
  it('el margen de cada partido es el de su sede (o 15 sin cancha)', () => {
    // 18:00 con margen 0 queda libre a las 19:00; otro a las 19:00 no choca.
    expect(overlaps(slot('2027-01-10', '18:00', 60, 0), slot('2027-01-10', '19:00', 60, 15))).toBe(false);
    // Con margen 15 sí.
    expect(overlaps(slot('2027-01-10', '18:00', 60, 15), slot('2027-01-10', '19:00', 60, 0))).toBe(true);
  });
});
