import { describe, expect, it } from 'vitest';
import { blockedOn } from './blocks.js';

describe('3D: blockedOn (vigencia del bloqueo administrativo)', () => {
  it('desde `since` (inclusive) hasta `until` (exclusive); sin `until`, vigente', () => {
    expect(blockedOn({ since: '2027-03-05', until: null }, '2027-03-04')).toBe(false);
    expect(blockedOn({ since: '2027-03-05', until: null }, '2027-03-05')).toBe(true);
    expect(blockedOn({ since: '2027-03-05', until: null }, '2099-01-01')).toBe(true);
    expect(blockedOn({ since: '2027-03-05', until: '2027-03-10' }, '2027-03-09')).toBe(true);
    expect(blockedOn({ since: '2027-03-05', until: '2027-03-10' }, '2027-03-10')).toBe(false);
  });

  it('levantado el mismo día que empezó: no cubre ningún día', () => {
    expect(blockedOn({ since: '2027-03-05', until: '2027-03-05' }, '2027-03-05')).toBe(false);
  });
});
