import { Types } from 'mongoose';
import { MatchStatus } from '../../common/enums/index.js';
import { publicPlayer, type TeamRef, type TournamentRef } from '../../common/utils/public.js';
import { buildPlayerProfile, type ProfileEntry, type ProfileMembership } from './player-profile.js';
import { bestPerformances, milestonesOf, recordsOf, statsByTeam, statsByYear } from './player-insights.js';
import { topScorerOf, type CompetitionContext } from './competition-outcome.js';
import type { StagedMatch } from '../competition/tables.js';

const player = { ...publicPlayer({ _id: new Types.ObjectId(), firstName: 'Juan', lastName: 'Pérez', position: 'FORWARD' }, '2028-01-01'), id: 'juan' };
const team = (id: string): TeamRef => ({ id, name: `Equipo ${id}`, shortName: id.slice(0, 3).toUpperCase(), logoUrl: null, colors: { primary: '#000', secondary: '#fff' } });
const teams = new Map(['dep', 'tig', 'riv', 'otro'].map((id) => [id, team(id)]));
let seq = 0;
const e = (date: string, goals = 0, assists = 0, extra: Partial<ProfileEntry> = {}): ProfileEntry => ({
  matchId: `m${String(++seq).padStart(3, '0')}`,
  tournamentId: 'liga',
  round: 1,
  date,
  time: '18:00',
  homeTeamId: 'dep',
  awayTeamId: 'riv',
  homeScore: 2,
  awayScore: 1,
  teamId: 'dep',
  goals,
  assists,
  yellowCards: 0,
  redCards: 0,
  ...extra,
});

describe('player insights (derivadas de partidos oficiales)', () => {
  it('por año: año natural de la fecha del partido, más reciente primero, con competiciones distintas', () => {
    const rows = statsByYear([e('2026-11-07', 1), e('2027-01-16', 2, 1), e('2027-03-01', 0, 0, { tournamentId: 'copa' }), e('2028-02-01', 3)]);
    expect(rows.map((r) => [r.year, r.stats.appearances, r.stats.goals, r.stats.assists, r.competitions])).toEqual([
      ['2028', 1, 3, 0, 1],
      ['2027', 2, 2, 1, 2],
      ['2026', 1, 1, 0, 1],
    ]);
  });

  it('por equipo: el equipo representado en cada partido (transferencia = dos equipos), más partidos primero', () => {
    const rows = statsByTeam(
      [e('2027-01-01', 1), e('2027-01-08', 0, 1), e('2027-02-01', 2, 0, { teamId: 'tig', homeTeamId: 'tig' }), e('2027-03-01', 1, 0, { tournamentId: 'copa' })],
      teams,
    );
    expect(rows.map((r) => [r.team?.id, r.stats.appearances, r.stats.goals, r.stats.assists, r.competitions, r.firstDate, r.lastDate])).toEqual([
      ['dep', 3, 2, 1, 2, '2027-01-01', '2027-03-01'],
      ['tig', 1, 2, 0, 1, '2027-02-01', '2027-02-01'],
    ]);
  });

  it('hitos: cronológicos y deterministas; una marca de goles se alcanza aunque se salte en un partido', () => {
    const entries = [e('2027-01-01'), e('2027-01-08', 0, 1), e('2027-01-15', 2), e('2027-01-22', 7), e('2027-01-29', 3)];
    const m = milestonesOf(entries).map((x) => [x.type, x.value, x.entry.date]);
    expect(m).toEqual([
      ['FIRST_MATCH', null, '2027-01-01'],
      ['FIRST_ASSIST', null, '2027-01-08'],
      ['FIRST_GOAL', null, '2027-01-15'],
      ['FIRST_BRACE', null, '2027-01-15'],
      ['FIRST_HAT_TRICK', null, '2027-01-22'],
      ['GOALS', 10, '2027-01-29'], // 2 + 7 = 9 → 12: el gol #10 cae en el quinto partido
    ]);
    const many = Array.from({ length: 50 }, (_, i) => e(`2027-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`));
    expect(milestonesOf(many).filter((x) => x.type === 'MATCHES').map((x) => x.value)).toEqual([25, 50]);
  });

  it('récords: máximo por partido (el primero a igualdad), racha goleadora consecutiva, año con más partidos; sin datos → null', () => {
    const r = recordsOf([e('2027-01-01', 3), e('2027-01-08', 1, 2), e('2027-01-15', 3), e('2027-01-22', 0), e('2028-01-01', 2), e('2028-01-08', 1)]);
    expect(r.mostGoalsInMatch).toMatchObject({ value: 3, entry: { date: '2027-01-01' } });
    expect(r.mostAssistsInMatch).toMatchObject({ value: 2, entry: { date: '2027-01-08' } });
    expect(r.longestScoringStreak).toEqual({ value: 3, from: '2027-01-01', to: '2027-01-15' });
    expect(r.mostMatchesInYear).toEqual({ value: 4, year: '2027' });
    expect([r.hatTricks, r.braces]).toEqual([2, 1]);
    expect(recordsOf([e('2027-01-01')])).toMatchObject({ mostGoalsInMatch: null, mostAssistsInMatch: null, longestScoringStreak: null });
  });

  it('mejores actuaciones: goles → asistencias → más reciente; nunca partidos sin aporte', () => {
    const best = bestPerformances([e('2027-01-01', 2, 0), e('2027-01-08', 2, 1), e('2027-02-01', 2, 1), e('2027-03-01', 0, 0), e('2027-04-01', 0, 3)]);
    expect(best.map((x) => [x.date, x.goals, x.assists])).toEqual([
      ['2027-02-01', 2, 1],
      ['2027-01-08', 2, 1],
      ['2027-01-01', 2, 0],
      ['2027-04-01', 0, 3],
    ]);
  });

  it('goleador del torneo: máximo > 0; empate → compartido; sin goles → null', () => {
    expect(topScorerOf('juan', new Map([['juan', 5], ['x', 3]]))).toEqual({ goals: 5, shared: false });
    expect(topScorerOf('juan', new Map([['juan', 5], ['x', 5]]))).toEqual({ goals: 5, shared: true });
    expect(topScorerOf('juan', new Map([['juan', 4], ['x', 5]]))).toBeNull();
    expect(topScorerOf('juan', new Map())).toBeNull();
  });
});

describe('buildPlayerProfile V2 · honors con la estructura oficial', () => {
  const T = (id: string, status: string): TournamentRef => ({ id, name: `Liga ${id}`, status, category: 'Libre', format: 'FOOTBALL_7', startDate: '2027-01-01', endDate: null });
  const match = (id: string, home: string, away: string, hs: number, as: number): StagedMatch => ({
    id, tournamentId: 'liga', round: 1, date: '2027-01-10', time: '18:00', status: MatchStatus.FINISHED,
    homeTeamId: home, awayTeamId: away, homeScore: hs, awayScore: as, stage: null, penalties: null,
  });
  const ctx = (status: string): CompetitionContext => ({
    tournament: { ...T('liga', status), system: 'LEAGUE', points: { win: 3, draw: 1, loss: 0 }, phases: [] },
    matches: [match('a', 'dep', 'riv', 2, 0), match('b', 'tig', 'otro', 1, 1)],
    teamIds: ['dep', 'riv', 'tig', 'otro'],
  });
  const mem = (teamId: string): ProfileMembership => ({ tournamentId: 'liga', teamId, jerseyNumber: 10, startDate: '2027-01-01', endDate: null, active: true });
  const build = (status: string, entries: ProfileEntry[], memberships: ProfileMembership[], goals = new Map([['juan', 2]])) =>
    buildPlayerProfile({
      player,
      entries,
      memberships,
      tournaments: new Map([['liga', T('liga', status)]]),
      teams,
      competitionContexts: new Map([['liga', ctx(status)]]),
      tournamentGoals: new Map([['liga', goals]]),
    });

  it('campeón de liga verificable: título, posición final y goleador; solo con partido oficial con ese equipo', () => {
    const p = build('FINISHED', [{ ...e('2027-01-10', 2), matchId: 'a' }], [mem('dep')]);
    expect(p.competitions[0].teams[0].outcome).toEqual({ champion: true, runnerUp: false, reached: null, finalPosition: { position: 1, teams: 4 } });
    expect(p.honors.map((h) => [h.type, h.team?.id ?? null, h.decidedBy ?? null])).toEqual([
      ['CHAMPION', 'dep', 'LEAGUE_TABLE'],
      ['TOP_SCORER', null, null],
    ]);
    expect(p.career).toMatchObject({ titles: 1, teams: 1, assistsPerMatch: 0 });
  });

  it('en la plantilla del campeón pero sin partidos: no recibe el título', () => {
    const p = build('FINISHED', [], [mem('dep')]);
    expect(p.competitions[0].teams[0].outcome).toBeNull();
    expect(p.honors).toEqual([]);
    expect(p.career.titles).toBe(0);
  });

  it('torneo en curso: ningún resultado oficial ni honor', () => {
    const p = build('ACTIVE', [{ ...e('2027-01-10', 2), matchId: 'a' }], [mem('dep')]);
    expect(p.competitions[0].teams[0].outcome).toBeNull();
    expect(p.competitions[0].topScorer).toBeNull();
    expect(p.honors).toEqual([]);
    expect(p.currentParticipations[0].stats).toMatchObject({ appearances: 1, goals: 2 });
  });
});
