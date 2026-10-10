import { describe, expect, it } from 'vitest';
import { MatchStatus, SuspensionDecision } from '../../common/enums/index.js';
import { DECISION, sameRelease } from './match-rules.js';

describe('decisión sobre un partido suspendido', () => {
  it('cada estado de salida es una decisión; SUSPENDED no es salida', () => {
    expect(DECISION[MatchStatus.LIVE]).toBe(SuspensionDecision.RESUMED);
    expect(DECISION[MatchStatus.SCHEDULED]).toBe(SuspensionDecision.RESCHEDULED);
    expect(DECISION[MatchStatus.POSTPONED]).toBe(SuspensionDecision.POSTPONED);
    expect(DECISION[MatchStatus.CANCELLED]).toBe(SuspensionDecision.CANCELLED);
    expect(DECISION[MatchStatus.FINISHED]).toBe(SuspensionDecision.FINISHED);
    expect(MatchStatus.SUSPENDED in DECISION).toBe(false);
  });
});

describe('confirmación de una reprogramación', () => {
  const now = { field: true, assignmentIds: ['a1', 'b2'] };
  it('coincide aunque cambie el orden o se repitan ids', () => {
    expect(sameRelease(now, { field: true, assignmentIds: ['b2', 'a1'] })).toBe(true);
    expect(sameRelease(now, { field: true, assignmentIds: ['a1', 'b2', 'a1'] })).toBe(true);
    expect(sameRelease({ field: false, assignmentIds: [] }, { field: false, assignmentIds: [] })).toBe(true);
  });
  it('obsoleta si cambia la cancha o cualquier árbitro (de más o de menos)', () => {
    expect(sameRelease(now, { field: false, assignmentIds: ['a1', 'b2'] })).toBe(false);
    expect(sameRelease(now, { field: true, assignmentIds: ['a1'] })).toBe(false);
    expect(sameRelease(now, { field: true, assignmentIds: ['a1', 'b2', 'c3'] })).toBe(false);
    expect(sameRelease({ field: false, assignmentIds: [] }, { field: false, assignmentIds: ['a1'] })).toBe(false);
  });
});
