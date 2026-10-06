import { Types } from 'mongoose';
import { MatchStatus } from '../../common/enums/index.js';
import { publicPlayer, type PublicPlayer, type TeamRef } from '../../common/utils/public.js';
import { buildTrackedSummary } from './tracked-summary.js';
import type { TPMatch } from './team-profile.js';

const ref = (id: string, name = `Equipo ${id}`): TeamRef => ({ id, name, shortName: id.toUpperCase(), logoUrl: null, colors: { primary: '#000000', secondary: '#ffffff' } });
const P = (id: string, lastName: string): PublicPlayer => ({
  ...publicPlayer({ _id: new Types.ObjectId(), firstName: 'J', lastName, birthDate: '2000-01-01', position: 'FORWARD' }, '2027-06-01'),
  id,
});
let seq = 0;
const M = (home: string, away: string, hs: number | null, as: number | null, date: string, status: string = MatchStatus.FINISHED): TPMatch => ({
  id: `m${String(++seq).padStart(3, '0')}`, tournamentId: 't', round: seq, date, time: '18:00', status: status as MatchStatus,
  homeTeamId: home, awayTeamId: away, homeScore: hs, awayScore: as, stage: null, penalties: null,
});
const tournament = { id: 't', name: 'Liga', status: 'ACTIVE', category: 'Libre', format: 'FOOTBALL_7', startDate: '2027-01-01', endDate: null, dataCoverage: 'PARTIAL' as const };
const build = (over: Partial<Parameters<typeof buildTrackedSummary>[0]> = {}) =>
  buildTrackedSummary({
    tournament,
    trackedTeamIds: ['b', 'a'],
    matches: [],
    stats: [],
    teams: new Map([ref('a', 'Atlético'), ref('b', 'Deportivo'), ref('c', 'Caribe')].map((t) => [t.id, t])),
    players: new Map([P('p1', 'Pérez'), P('p2', 'López'), P('p3', 'Gómez')].map((p) => [p.id, p])),
    squadSizes: new Map(),
    ...over,
  });

describe('buildTrackedSummary', () => {
  it('equipos seguidos sin partidos: tarjetas con 0 PJ, sin último partido ni goleador (la UI dice "Aún sin partidos registrados")', () => {
    const s = build();
    expect(s.trackedTeams.map((c) => c.team.name)).toEqual(['Atlético', 'Deportivo']); // por nombre, no por "posición"
    expect(s.trackedTeams[0]).toMatchObject({ record: { matchesPlayed: 0 }, form: [], lastMatch: null, nextMatch: null, topScorer: null, topAssist: null, squadSize: 0 });
  });

  it('cada tarjeta solo con SUS partidos; A vs B cuenta para ambos desde su lado; pendientes fuera del balance', () => {
    const s = build({
      matches: [M('a', 'c', 3, 1, '2027-02-01'), M('c', 'b', 1, 1, '2027-02-02'), M('a', 'b', 1, 0, '2027-02-03'), M('b', 'a', null, null, '2027-03-01', MatchStatus.SCHEDULED)],
      stats: [
        { playerId: 'p1', teamId: 'a', goals: 2, assists: 1 },
        { playerId: 'p2', teamId: 'a', goals: 2, assists: 0 },
        { playerId: 'p1', teamId: 'a', goals: 1, assists: 0 },
        { playerId: 'p3', teamId: 'b', goals: 1, assists: 0 },
      ],
      squadSizes: new Map([['a', 12]]),
    });
    const [a, b] = s.trackedTeams;
    expect(a.record).toMatchObject({ matchesPlayed: 2, wins: 2, goalsFor: 4, goalsAgainst: 1 });
    expect(a.form).toEqual(['W', 'W']);
    expect(a.lastMatch).toMatchObject({ homeScore: 1, awayScore: 0, result: 'W' });
    expect(a.nextMatch).toMatchObject({ status: MatchStatus.SCHEDULED });
    expect(a.topScorer).toMatchObject({ player: { id: 'p1' }, goals: 3 });
    expect(a.topAssist).toMatchObject({ player: { id: 'p1' }, assists: 1 });
    expect(a.squadSize).toBe(12);
    expect(b.record).toMatchObject({ matchesPlayed: 2, wins: 0, draws: 1, losses: 1 });
    expect(b.lastMatch).toMatchObject({ result: 'L' });
    expect(b.topScorer).toMatchObject({ player: { id: 'p3' }, goals: 1 });
    expect(b.topAssist).toBeNull();
  });

  it('un id seguido sin equipo (borrado) se ignora sin romper', () => {
    expect(build({ trackedTeamIds: ['a', 'zz'] }).trackedTeams.map((c) => c.team.id)).toEqual(['a']);
  });
});
