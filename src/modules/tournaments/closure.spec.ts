import { PhaseType, TournamentStatus } from '../../common/enums/index.js';
import type { StructureView } from '../competition/structure.js';
import { closureBlockers, pendingWarnings, runnerUpOf } from './closure.js';

const codes = (x: { code: string }[]) => x.map((i) => i.code);

describe('closure (10A)', () => {
  it('bloqueantes: estado, competición incompleta y partidos en juego', () => {
    expect(closureBlockers(TournamentStatus.ACTIVE, [], 0)).toEqual([]);
    expect(codes(closureBlockers(TournamentStatus.DRAFT, [], 0))).toEqual(['NOT_STARTED']);
    expect(codes(closureBlockers(TournamentStatus.FINISHED, [], 0))).toEqual(['ALREADY_FINISHED']);
    expect(codes(closureBlockers(TournamentStatus.ACTIVE, ['La final aún no tiene ganador'], 2))).toEqual(['COMPETITION_INCOMPLETE', 'LIVE_MATCHES']);
    expect(closureBlockers(TournamentStatus.ACTIVE, [], 1)[0]!.message).toMatch(/^Hay 1 partido en juego/);
    expect(closureBlockers(TournamentStatus.ACTIVE, [], 3)[0]).toMatchObject({ count: 3, message: expect.stringMatching(/^Hay 3 partidos en juego/) });
  });

  it('advertencias: solo los tipos con partidos, en singular o plural', () => {
    expect(pendingWarnings({ scheduled: 0, postponed: 0, pendingSchedule: 0, suspended: 0 })).toEqual([]);
    const w = pendingWarnings({ scheduled: 1, postponed: 2, pendingSchedule: 0, suspended: 1 });
    expect(codes(w)).toEqual(['SCHEDULED_MATCHES', 'POSTPONED_MATCHES', 'SUSPENDED_MATCHES']);
    expect(w[0]!.message).toBe('1 partido programado sin jugar');
    expect(w[1]!.message).toMatch(/^2 partidos pospuestos/);
  });

  it('subcampeón: solo con la final decidida', () => {
    const view = (tie: Record<string, unknown> | undefined) => ({ phases: [{ type: PhaseType.KNOCKOUT, rounds: tie ? [{ ties: [tie] }] : [] }] }) as unknown as StructureView;
    expect(runnerUpOf(view({ homeTeamId: 'a', awayTeamId: 'b', winnerTeamId: 'a' }))).toBe('b');
    expect(runnerUpOf(view({ homeTeamId: 'a', awayTeamId: 'b', winnerTeamId: 'b' }))).toBe('a');
    expect(runnerUpOf(view({ homeTeamId: 'a', awayTeamId: 'b', winnerTeamId: null }))).toBeNull();
    expect(runnerUpOf(view(undefined))).toBeNull();
    expect(runnerUpOf({ phases: [{ type: PhaseType.LEAGUE }] } as unknown as StructureView)).toBeNull();
  });
});
