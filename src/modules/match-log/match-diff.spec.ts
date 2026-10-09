import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { MatchLogAction } from '../../common/enums/index.js';
import { diff, editAction, releasedOf, resultAction, snapshotOf, TRACKED } from './match-diff.js';

const id = new Types.ObjectId();
const base = { tournamentId: id, round: 1, homeTeamId: id, awayTeamId: id, date: '2027-01-10', time: '18:00', status: 'SCHEDULED', fieldId: null, venue: null };

describe('diff del historial', () => {
  it('sin cambios reales no hay entrada (ids, null, "" y undefined se normalizan)', () => {
    expect(diff(base, { ...base, homeTeamId: new Types.ObjectId(id.toHexString()), venue: '' }, TRACKED)).toBeNull();
    expect(diff({ ...base, venue: undefined }, { ...base, venue: null }, TRACKED)).toBeNull();
  });

  it('registra solo los campos que cambian, con valores anteriores y nuevos', () => {
    expect(diff(base, { ...base, time: '20:00', status: 'POSTPONED' }, TRACKED)).toEqual({
      time: { from: '18:00', to: '20:00' },
      status: { from: 'SCHEDULED', to: 'POSTPONED' },
    });
  });

  it('tipo principal: reprogramación > estado > cancha > equipos', () => {
    expect(editAction({ time: { from: 'a', to: 'b' }, status: { from: 'a', to: 'b' } })).toBe(MatchLogAction.RESCHEDULED);
    expect(editAction({ status: { from: 'a', to: 'b' }, fieldId: { from: null, to: 'x' } })).toBe(MatchLogAction.STATUS_CHANGED);
    expect(editAction({ fieldId: { from: null, to: 'x' } })).toBe(MatchLogAction.FIELD_CHANGED);
    expect(editAction({ round: { from: 1, to: 2 } })).toBe(MatchLogAction.UPDATED);
  });

  it('resultado: captura (primera vez o al finalizar) vs corrección', () => {
    expect(resultAction({ homeScore: null, status: 'SCHEDULED' }, { status: 'FINISHED' })).toBe(MatchLogAction.RESULT_CAPTURED);
    expect(resultAction({ homeScore: 1, status: 'LIVE' }, { status: 'FINISHED' })).toBe(MatchLogAction.RESULT_CAPTURED);
    expect(resultAction({ homeScore: 1, status: 'FINISHED' }, { status: 'FINISHED' })).toBe(MatchLogAction.RESULT_CORRECTED);
  });

  it('copia y recursos liberados al eliminar (solo árbitros en funciones)', () => {
    const r1 = new Types.ObjectId();
    const r2 = new Types.ObjectId();
    const m = { ...base, _id: id, fieldId: id, venue: 'Sede · C1', referees: [{ refereeId: r1, role: 'CENTRAL', status: 'ASSIGNED' }, { refereeId: r2, role: 'FOURTH', status: 'ABSENT' }] };
    expect(releasedOf(m)).toEqual({ matchId: id.toHexString(), fieldId: id.toHexString(), venue: 'Sede · C1', referees: [{ refereeId: r1.toHexString(), role: 'CENTRAL' }] });
    expect(releasedOf({ ...base, _id: id, referees: [] })).toBeNull();
    expect(snapshotOf(m)).toMatchObject({ id: id.toHexString(), date: '2027-01-10', referees: [{ role: 'CENTRAL' }, { status: 'ABSENT' }] });
  });
});
