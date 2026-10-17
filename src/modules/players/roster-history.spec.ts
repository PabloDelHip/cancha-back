import { describe, expect, it } from 'vitest';
import { assignBlockTeams, deriveHistory, filterHistory, RosterEventAction as A, sortHistory, teamOn, type HistorySources, type MembershipRecord } from './roster-history.js';

const U = 'u0000000000000000000000a';
const at = (d: string) => new Date(`${d}T15:00:00`);
const entry = (action: string, day: string, details: Record<string, unknown> | null = null, reason: string | null = null) => ({ action, reason, by: U, role: 'OWNER', at: at(day), details });
const m = (id: string, team: string, startDate: string, extra: Partial<MembershipRecord> = {}): MembershipRecord => ({
  _id: id.padStart(24, '0'),
  playerId: 'p1',
  teamId: team,
  startDate,
  endDate: null,
  active: true,
  endReason: null,
  audit: [],
  ...extra,
});
const src = (s: Partial<HistorySources>): HistorySources => ({ memberships: [], blocks: [], enrollments: [], removed: [], overrides: [], ...s });
const actions = (s: Partial<HistorySources>) => sortHistory(deriveHistory(src(s))).reverse().map((e) => e.action);

describe('3E: deriveHistory', () => {
  it('cambio de equipo: un solo evento (sale de la participación nueva, no del MOVED)', () => {
    const events = deriveHistory(src({
      memberships: [
        m('1', 'A', '2027-01-01', { active: false, endDate: '2027-02-01', audit: [entry('REGISTERED', '2027-01-01'), entry('MOVED', '2027-02-01', { toTeamId: 'B' }, 'Se mudó')] }),
        m('2', 'B', '2027-02-01', { audit: [entry('REGISTERED', '2027-02-01', { fromTeamId: 'A' }, 'Se mudó')] }),
      ],
    }));
    expect(events.map((e) => e.action)).toEqual([A.REGISTERED, A.TRANSFER]);
    expect(events[1]).toMatchObject({ teamId: 'B', fromTeamId: 'A', reason: 'Se mudó', by: { userId: U, role: 'OWNER' }, legacy: false });
  });

  it('baja y vuelta: al mismo equipo = reincorporación; a otro (3D) = cambio de equipo', () => {
    const closed = m('1', 'A', '2027-01-01', { active: false, endDate: '2027-02-01', endReason: 'Lesión', audit: [entry('REGISTERED', '2027-01-01'), entry('UNREGISTERED', '2027-02-01', null, 'Lesión')] });
    expect(actions({ memberships: [closed, m('2', 'A', '2027-03-01', { audit: [entry('REGISTERED', '2027-03-01')] })] })).toEqual([A.REGISTERED, A.UNREGISTERED, A.REJOINED]);
    const other = deriveHistory(src({ memberships: [closed, m('2', 'B', '2027-03-01', { audit: [entry('REGISTERED', '2027-03-01', { previousTeamId: 'A' }, 'Lo fichó B')] })] }));
    expect(other.at(-1)).toMatchObject({ action: A.TRANSFER, fromTeamId: 'A', details: { afterUnregister: true } });
  });

  it('transferencia anulada: queda la transferencia (marcada) con sus excepciones y la anulación', () => {
    const annulled = { membershipId: 'x', teamId: 'B', jerseyNumber: 7, startDate: '2027-02-01', audit: [{ ...entry('REGISTERED', '2027-02-01', { fromTeamId: 'A' }, 'Error'), by: U }, { ...entry('KNOCKOUT_EXCEPTION', '2027-02-01', null, 'Final'), by: U }] };
    const events = deriveHistory(src({
      memberships: [m('1', 'A', '2027-01-01', { audit: [entry('REGISTERED', '2027-01-01'), entry('MOVED', '2027-02-01', { toTeamId: 'B' }), entry('TRANSFER_ANNULLED', '2027-02-02', { annulled, jerseyCleared: 9 }, 'Fue un error')] })],
    }));
    expect(events.map((e) => [e.action, e.details.annulled ?? false])).toEqual([
      [A.REGISTERED, false],
      [A.TRANSFER_ANNULLED, false],
      [A.TRANSFER, true],
      [A.EXCEPTION, true],
    ]);
    expect(events[1]).toMatchObject({ teamId: 'A', fromTeamId: 'B', reason: 'Fue un error', details: { jerseyCleared: 9 } });
    expect(events[2]).toMatchObject({ teamId: 'B', fromTeamId: 'A' });
    expect(events[3].details.kind).toBe('KNOCKOUT');
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it('anterior a 3A (sin auditoría): alta y fin por sus fechas, sin autor ni hora', () => {
    const events = deriveHistory(src({ memberships: [m('1', 'A', '2025-03-01', { active: false, endDate: '2025-05-01', endReason: 'Se fue' })] }));
    expect(events).toEqual([
      expect.objectContaining({ action: A.REGISTERED, at: null, date: '2025-03-01', by: null, legacy: true }),
      expect.objectContaining({ action: A.UNREGISTERED, at: null, date: '2025-05-01', by: null, legacy: true, reason: 'Se fue' }),
    ]);
    // Cerrada después de 3A (con auditoría de la baja): el alta es antigua, la baja no.
    const mixed = deriveHistory(src({ memberships: [m('1', 'A', '2025-03-01', { active: false, endDate: '2027-01-10', audit: [entry('UNREGISTERED', '2027-01-10', null, 'Baja')] })] }));
    expect(mixed.map((e) => [e.action, e.legacy])).toEqual([[A.REGISTERED, true], [A.UNREGISTERED, false]]);
  });

  it('excepciones, dorsal, bloqueos (retroactivo marcado), retiros, equipos quitados y misma fecha', () => {
    const events = deriveHistory(src({
      memberships: [m('1', 'A', '2027-01-01', { audit: [entry('REGISTERED', '2027-01-05'), entry('RETROACTIVE', '2027-01-05', { from: '2027-01-05', to: '2027-01-01' }, 'Jugó antes'), entry('OVER_LIMIT', '2027-01-05', { max: 20, count: 20 }, 'Cupo'), entry('JERSEY_CHANGED', '2027-01-09', { from: 7, to: 10 })] })],
      blocks: [{ _id: 'b1', playerId: 'p1', since: '2027-01-02', until: '2027-01-20', reason: 'Ficha', blockedBy: U, blockedRole: 'ADMIN', liftReason: 'Entregó', liftedBy: U, liftedRole: 'OWNER', liftedAt: at('2027-01-20'), createdAt: at('2027-01-06') }],
      enrollments: [{ _id: 'e1', teamId: 'A', audit: [entry('WITHDRAWN', '2027-03-01', { cancelledMatchIds: ['m1', 'm2'], closedMemberships: ['x'] }, 'Abandonó'), entry('REINSTATED', '2027-03-05', { withdrawnAt: '2027-03-01' }, 'Volvió')] }],
      removed: [{ _id: 'r1', teamId: 'C', removedBy: U, removedRole: 'OWNER', removedAt: at('2027-01-03'), memberships: [{ ...m('9', 'C', '2027-01-01', { playerId: 'p2', audit: [entry('REGISTERED', '2027-01-01')] }) }] }],
      overrides: [{ _id: 'o1', matchId: 'mt', actorId: U, actorRole: 'OWNER', reason: 'Acta', createdAt: at('2027-02-01'), changes: { sameDate: { to: [{ playerId: 'p1', teamId: 'A', matchId: 'other' }] } } }],
    }));
    const by = (a: A) => events.filter((e) => e.action === a);
    expect(by(A.EXCEPTION).map((e) => e.details.kind)).toEqual(['RETROACTIVE', 'OVER_LIMIT', 'SAME_DATE']);
    expect(by(A.JERSEY_CHANGED)[0].details).toMatchObject({ from: 7, to: 10 });
    expect(by(A.BLOCKED)[0]).toMatchObject({ date: '2027-01-02', reason: 'Ficha', by: { role: 'ADMIN' }, details: { retroactive: true } });
    expect(by(A.UNBLOCKED)[0]).toMatchObject({ date: '2027-01-20', reason: 'Entregó', details: {} });
    expect(by(A.TEAM_WITHDRAWN)[0]).toMatchObject({ teamId: 'A', playerId: null, details: { cancelledMatches: 2, closedMemberships: 1 } });
    expect(by(A.TEAM_REINSTATED)[0].reason).toBe('Volvió');
    expect(by(A.TEAM_REMOVED)[0]).toMatchObject({ teamId: 'C', details: { memberships: 1 } });
    expect(events.find((e) => e.playerId === 'p2')).toMatchObject({ action: A.REGISTERED, details: { removedTeam: true } });
  });
});

describe('3E: filtros, orden y equipo de un bloqueo', () => {
  const events = deriveHistory(src({
    memberships: [
      m('1', 'A', '2027-01-01', { active: false, endDate: '2027-02-01', audit: [entry('REGISTERED', '2027-01-01'), entry('MOVED', '2027-02-01')] }),
      m('2', 'B', '2027-02-01', { audit: [entry('REGISTERED', '2027-02-01', { fromTeamId: 'A' }, 'x')] }),
      m('3', 'C', '2026-12-01', { playerId: 'p2' }),
    ],
  }));

  it('por equipo incluye el origen de un cambio; por jugador, acción y periodo (inclusivo)', () => {
    expect(filterHistory(events, { teamId: 'A' }).map((e) => e.action)).toEqual([A.REGISTERED, A.TRANSFER]);
    expect(filterHistory(events, { playerId: 'p2' })).toHaveLength(1);
    expect(filterHistory(events, { actions: [A.TRANSFER] })).toHaveLength(1);
    expect(filterHistory(events, { from: '2027-01-01', to: '2027-01-01' }).map((e) => e.teamId)).toEqual(['A']);
    expect(filterHistory(events, { from: '2027-03-01' })).toHaveLength(0);
  });

  it('más reciente primero; lo antiguo por su fecha', () => {
    expect(sortHistory(events).map((e) => e.teamId)).toEqual(['B', 'A', 'C']);
  });

  it('teamOn: la participación que cubre la fecha o la última anterior', () => {
    const ms = [m('1', 'A', '2027-01-01', { endDate: '2027-02-01', active: false }), m('2', 'B', '2027-02-01')];
    expect(teamOn(ms, '2027-01-15')).toBe('A');
    expect(teamOn(ms, '2027-02-01')).toBe('B');
    expect(teamOn(ms, '2026-12-01')).toBeNull();
    const blocks = deriveHistory(src({ blocks: [{ _id: 'b', playerId: 'p1', since: '2027-01-10', until: '2027-02-05', reason: 'x', blockedBy: U, blockedRole: null, liftReason: 'y', liftedBy: U, liftedRole: null, liftedAt: at('2027-02-05'), createdAt: at('2027-01-10') }] }));
    assignBlockTeams(blocks, ms);
    expect(blocks.map((e) => e.teamId)).toEqual(['A', 'B']);
  });
});
