import { Types } from 'mongoose';
import { buildPlayerProfile, type ProfileEntry, type ProfileMembership } from './player-profile.js';
import { ageOn } from '../../common/utils/dates.js';
import { publicPlayer, type TeamRef, type TournamentRef } from '../../common/utils/public.js';

const player = publicPlayer({
  _id: new Types.ObjectId(),
  firstName: 'Pablo',
  lastName: 'Hipólito',
  birthDate: '2001-04-18',
  position: 'FORWARD',
  photoUrl: null,
}, '2027-03-01');

const T = (id: string, status: string, startDate: string, endDate: string | null = null): TournamentRef => ({
  id,
  name: `Torneo ${id}`,
  status,
  category: 'Libre',
  format: 'FOOTBALL_7',
  startDate,
  endDate,
});
const team = (id: string): TeamRef => ({
  id,
  name: `Equipo ${id}`,
  shortName: id.toUpperCase().slice(0, 3),
  logoUrl: null,
  colors: { primary: '#000000', secondary: '#ffffff' },
});

let seq = 0;
const entry = (tournamentId: string, teamId: string, date: string, extra: Partial<ProfileEntry> = {}): ProfileEntry => ({
  matchId: `m${String(++seq).padStart(3, '0')}`,
  tournamentId,
  round: 1,
  date,
  time: '18:00',
  homeTeamId: teamId,
  awayTeamId: 'rival',
  homeScore: 1,
  awayScore: 0,
  teamId,
  goals: 0,
  assists: 0,
  yellowCards: 0,
  redCards: 0,
  ...extra,
});
const membership = (tournamentId: string, teamId: string, startDate: string, extra: Partial<ProfileMembership> = {}): ProfileMembership => ({
  tournamentId,
  teamId,
  jerseyNumber: 9,
  startDate,
  endDate: null,
  active: true,
  ...extra,
});

const tournaments = new Map(
  [
    T('copa', 'FINISHED', '2026-11-07', '2026-11-21'),
    T('apertura', 'ACTIVE', '2027-01-16'),
    T('cancun', 'ACTIVE', '2027-02-06'),
    T('veteranos', 'DRAFT', '2027-04-10'),
  ].map((t) => [t.id, t]),
);
const teams = new Map(['halcones', 'jaguares', 'tigres', 'rival'].map((id) => [id, team(id)]));
const build = (entries: ProfileEntry[], memberships: ProfileMembership[], recentLimit?: number) =>
  buildPlayerProfile({ player, entries, memberships, tournaments, teams, recentLimit });

describe('buildPlayerProfile', () => {
  it('jugador sin participaciones: todo vacío y en cero, sin inventar datos', () => {
    const p = build([], []);
    expect(p.player).toMatchObject({ firstName: 'Pablo', age: 25 });
    expect(p.player).not.toHaveProperty('birthDate');
    expect(p.career).toEqual({
      appearances: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0,
      goalsPerMatch: null, assistsPerMatch: null, competitions: 0, teams: 0, titles: 0,
    });
    expect(p).toMatchObject({ currentParticipations: [], competitions: [], history: [], recentMatches: [], form: [] });
    expect(p).toMatchObject({ honors: [], byYear: [], byTeam: [], milestones: [], bestPerformances: [] });
    expect(p.records).toEqual({ mostGoalsInMatch: null, mostAssistsInMatch: null, longestScoringStreak: null, mostMatchesInYear: null, hatTricks: 0, braces: 0 });
  });

  it('carrera = suma de los partidos recibidos; goles/partido redondeado a 2 decimales', () => {
    const p = build(
      [
        entry('apertura', 'halcones', '2027-01-16', { goals: 2, assists: 1, yellowCards: 1 }),
        entry('apertura', 'halcones', '2027-01-23', { goals: 0, redCards: 1 }),
        entry('copa', 'halcones', '2026-11-07', { goals: 1 }),
      ],
      [membership('apertura', 'halcones', '2027-01-16'), membership('copa', 'halcones', '2026-11-07')],
    );
    expect(p.career).toMatchObject({ appearances: 3, goals: 3, assists: 1, yellowCards: 1, redCards: 1, goalsPerMatch: 1, competitions: 2 });
  });

  it('agrupa por competición y equipo: mismo equipo en dos torneos = dos participaciones', () => {
    const p = build(
      [entry('apertura', 'halcones', '2027-01-16', { goals: 2 }), entry('copa', 'halcones', '2026-11-07', { goals: 1 })],
      [membership('apertura', 'halcones', '2027-01-16'), membership('copa', 'halcones', '2026-11-07')],
    );
    expect(p.competitions.map((c) => [c.tournament.id, c.teams.map((t) => t.team?.id), c.stats.goals])).toEqual([
      ['apertura', ['halcones'], 2],
      ['copa', ['halcones'], 1],
    ]);
  });

  it('participaciones simultáneas: dos torneos activos → dos actuales', () => {
    const p = build(
      [entry('apertura', 'halcones', '2027-02-06'), entry('cancun', 'jaguares', '2027-02-06', { goals: 2 })],
      [membership('apertura', 'halcones', '2027-01-16'), membership('cancun', 'jaguares', '2027-02-06', { jerseyNumber: 23 })],
    );
    expect(p.currentParticipations.map((c) => [c.tournament.id, c.team?.id, c.jerseyNumber])).toEqual([
      ['cancun', 'jaguares', 23],
      ['apertura', 'halcones', 9],
    ]);
  });

  it('torneo FINISHED: su membership sigue active pero pasa a historia, con fin = cierre del torneo', () => {
    const p = build([entry('copa', 'tigres', '2026-11-14')], [membership('copa', 'tigres', '2026-11-07', { jerseyNumber: 14 })]);
    expect(p.currentParticipations).toEqual([]);
    expect(p.competitions[0].teams[0]).toMatchObject({ current: false, startDate: '2026-11-07', endDate: '2026-11-21', jerseyNumber: 14 });
    expect(p.history).toEqual([
      {
        year: '2026',
        participations: [
          expect.objectContaining({ tournament: { id: 'copa', name: 'Torneo copa', status: 'FINISHED' }, current: false }),
        ],
      },
    ]);
  });

  it('torneo DRAFT con membership activa es actual (por empezar), sin partidos', () => {
    const p = build([], [membership('veteranos', 'tigres', '2027-04-10')]);
    expect(p.currentParticipations).toHaveLength(1);
    expect(p.competitions[0].stats.appearances).toBe(0);
  });

  it('cambio de equipo dentro de un torneo: dos participaciones separadas, la actual primero', () => {
    const p = build(
      [entry('apertura', 'tigres', '2027-01-16', { goals: 1 }), entry('apertura', 'halcones', '2027-02-20', { goals: 3 })],
      [
        membership('apertura', 'tigres', '2027-01-16', { active: false, endDate: '2027-02-01', jerseyNumber: 14 }),
        membership('apertura', 'halcones', '2027-02-01', { jerseyNumber: 7 }),
      ],
    );
    expect(p.competitions).toHaveLength(1);
    expect(p.competitions[0].teams.map((t) => [t.team?.id, t.current, t.endDate, t.stats.goals])).toEqual([
      ['halcones', true, null, 3],
      ['tigres', false, '2027-02-01', 1],
    ]);
    expect(p.competitions[0].stats.goals).toBe(4);
    expect(p.currentParticipations.map((c) => c.team?.id)).toEqual(['halcones']);
  });

  it('partido sin membership (p. ej. baja posterior) igual cuenta en su competición', () => {
    const p = build([entry('apertura', 'tigres', '2027-01-16', { goals: 1 })], []);
    expect(p.competitions[0].teams[0]).toMatchObject({ jerseyNumber: null, startDate: '2027-01-16', current: false });
    expect(p.career.goals).toBe(1);
  });

  it('partidos recientes: más reciente primero, máximo 5 (configurable), con aporte y resultado', () => {
    const entries = ['2027-01-16', '2027-02-20', '2027-01-23', '2027-02-13', '2027-01-30', '2027-02-06'].map((d, i) =>
      entry('apertura', 'halcones', d, { goals: i, homeScore: i % 3, awayScore: 1 }),
    );
    const p = build(entries, [membership('apertura', 'halcones', '2027-01-16')]);
    expect(p.recentMatches.map((m) => m.date)).toEqual(['2027-02-20', '2027-02-13', '2027-02-06', '2027-01-30', '2027-01-23']);
    expect(p.recentMatches[0]).toMatchObject({
      tournament: { id: 'apertura', name: 'Torneo apertura' },
      homeTeam: { id: 'halcones' },
      awayTeam: { id: 'rival' },
      playerTeamId: 'halcones',
      status: 'FINISHED',
      stats: { goals: 1 },
    });
    expect(build(entries, [], 2).recentMatches).toHaveLength(2);
  });

  it('forma: últimos 5 resultados del más antiguo al más reciente, desde el lado del jugador', () => {
    const p = build(
      [
        entry('apertura', 'halcones', '2027-01-16', { homeScore: 0, awayScore: 1 }), // L
        entry('apertura', 'halcones', '2027-01-23', { homeScore: 1, awayScore: 1 }), // D
        entry('apertura', 'halcones', '2027-01-30', { homeTeamId: 'rival', awayTeamId: 'halcones', homeScore: 0, awayScore: 2 }), // W como visitante
      ],
      [],
    );
    expect(p.form).toEqual(['L', 'D', 'W']);
  });
});

describe('buildPlayerProfile — cobertura PARTIAL (6F)', () => {
  // Copa finalizada, liga clásica de 2 equipos: halcones ganó su único partido y el jugador metió 2.
  const run = (dataCoverage?: 'PARTIAL') => {
    const copa = { ...T('copa', 'FINISHED', '2026-11-07', '2026-11-21'), ...(dataCoverage ? { dataCoverage } : {}) };
    const matches = [{ id: 'm-copa', tournamentId: 'copa', round: 1, date: '2026-11-07', time: '18:00', status: 'FINISHED', homeTeamId: 'halcones', awayTeamId: 'rival', homeScore: 2, awayScore: 0, stage: null, penalties: null }];
    return buildPlayerProfile({
      player,
      entries: [entry('copa', 'halcones', '2026-11-07', { homeScore: 2, awayScore: 0, goals: 2, assists: 1 })],
      memberships: [membership('copa', 'halcones', '2026-11-01')],
      tournaments: new Map([['copa', copa]]),
      teams,
      competitionContexts: new Map([
        ['copa', { tournament: { ...copa, system: 'LEAGUE', points: { win: 3, draw: 1, loss: 0 } }, matches: matches as never, teamIds: ['halcones', 'rival'] }],
      ]),
      tournamentGoals: new Map([['copa', new Map([[player.id, 2]])]]),
    });
  };

  it('los campos antiguos no ocultan campeón ni goleador', () => {
    const full = run();
    const partial = run('PARTIAL');
    expect(full.honors.map((h) => h.type).sort()).toEqual(['CHAMPION', 'TOP_SCORER']);
    expect(partial.honors).toEqual(full.honors);
    expect(partial.competitions[0].topScorer).toEqual(full.competitions[0].topScorer);
    expect(partial.competitions[0].teams[0].outcome).toEqual(full.competitions[0].teams[0].outcome);
    expect(partial.career).toEqual(full.career);
    expect(partial.career).toMatchObject({ appearances: 1, goals: 2, assists: 1 });
    expect(partial.recentMatches.map(({ id: _id, ...m }) => m)).toEqual(full.recentMatches.map(({ id: _id, ...m }) => m));
  });
});

describe('ageOn', () => {
  it('edad cumplida; antes del cumpleaños resta uno; sin fecha → null', () => {
    expect(ageOn('2001-04-18', '2027-04-18')).toBe(26);
    expect(ageOn('2001-04-18', '2027-04-17')).toBe(25);
    expect(ageOn('2008-02-29', '2027-02-28')).toBe(18);
    expect(ageOn(null, '2027-01-01')).toBeNull();
  });
});
