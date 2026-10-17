import { describe, expect, it } from 'vitest';
import { belongsOn, transferredFrom } from './membership-rules.js';

describe('belongsOn (elegibilidad por fecha)', () => {
  it('3A: solo dentro del periodo efectivo; inscribirse tarde no habilita partidos anteriores', () => {
    const m = { active: true, startDate: '2027-02-01', endDate: null, registeredAt: '2027-02-01' };
    expect(belongsOn(m, '2027-01-31')).toBe(false);
    expect(belongsOn(m, '2027-02-01')).toBe(true);
    expect(belongsOn(m, '2027-05-01')).toBe(true);
  });

  it('3A: retroactiva (startDate anterior a registeredAt) habilita desde startDate', () => {
    expect(belongsOn({ active: true, startDate: '2027-01-10', endDate: null, registeredAt: '2027-02-01' }, '2027-01-10')).toBe(true);
  });

  it('cerrada: su periodo, ambos extremos inclusive', () => {
    const m = { active: false, startDate: '2027-01-01', endDate: '2027-01-31', registeredAt: '2027-01-01' };
    expect(belongsOn(m, '2027-01-31')).toBe(true);
    expect(belongsOn(m, '2027-02-01')).toBe(false);
  });

  it('anterior a 3A (sin registeredAt): activa sigue siendo elegible en cualquier fecha; nada histórico cambia', () => {
    expect(belongsOn({ active: true, startDate: '2027-02-01', endDate: null }, '2026-01-01')).toBe(true);
    expect(belongsOn({ active: true, startDate: '2027-02-01', endDate: null, registeredAt: null }, '2026-01-01')).toBe(true);
    expect(belongsOn({ active: false, startDate: '2027-01-01', endDate: '2027-01-31' }, '2027-02-01')).toBe(false);
  });
});

describe('transferredFrom (3C)', () => {
  const by = 'u';
  it('el equipo de origen sale de la auditoría REGISTERED de un cambio de equipo', () => {
    expect(transferredFrom({ audit: [{ action: 'REGISTERED', details: { fromTeamId: 'A' } }, { action: 'KNOCKOUT_EXCEPTION', details: null }] })).toBe('A');
  });
  it('alta normal, participación anterior a 3A o auditoría sin REGISTERED → null', () => {
    expect(transferredFrom({ audit: [{ action: 'REGISTERED', details: null }] })).toBeNull();
    expect(transferredFrom({})).toBeNull();
    expect(transferredFrom({ audit: null })).toBeNull();
    expect(transferredFrom({ audit: [{ action: 'MOVED', details: { toTeamId: by } }] })).toBeNull();
  });
});
