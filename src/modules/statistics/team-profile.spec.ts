import { Types } from 'mongoose';
import { MatchStatus } from '../../common/enums/index.js';
import { publicPlayer, type PublicPlayer, type TeamRef } from '../../common/utils/public.js';
import { buildTeamProfile, recordOf, type TPMatch, type TPMembership, type TPStat, type TPTournament } from './team-profile.js';

const ref = (id: string): TeamRef => ({ id, name: `Equipo ${id}`, shortName: id.slice(0, 3).toUpperCase(), logoUrl: null, colors: { primary: '#000000', secondary: '#ffffff' } });
const T = (id: string, status: string, startDate: string, system = 'LEAGUE'): TPTournament => ({
  id,
  name: `Torneo ${id}`,
  status,
  category: 'Libre',
  format: 'FOOTBALL_7',
  startDate,
  endDate: null,
  system,
  points: { win: 3, draw: 1, loss: 0 },
});
let seq = 0;
const M = (tournamentId: string, home: string, away: string, hs: number | null, as: number | null, date: string, status: string = MatchStatus.FINISHED): TPMatch => ({
  id: `m${String(++seq).padStart(3, '0')}`,
  tournamentId,
  round: 1,
  date,
  time: '18:00',
  status: status as MatchStatus,
  homeTeamId: home,
  awayTeamId: away,
  homeScore: hs,
  awayScore: as,
  stage: null,
  penalties: null,
});
const P = (id: string, lastName: string): PublicPlayer => ({
  ...publicPlayer({ _id: new Types.ObjectId(), firstName: 'J', lastName, birthDate: '2000-01-01', position: 'FORWARD' }, '2027-06-01'),
  id,
});
const mem = (playerId: string, tournamentId: string, extra: Partial<TPMembership> = {}): TPMembership => ({
  playerId,
  tournamentId,
  jerseyNumber: 9,
  startDate: '2027-01-01',
  active: true,
  ...extra,
});
const stat = (playerId: string, tournamentId: string, goals: number, assists = 0): TPStat => ({ matchId: `s${++seq}`, tournamentId, playerId, goals, assists });

function build(opts: {
  tournaments: TPTournament[];
  matches: TPMatch[];
  enrolled?: string[];
  tournamentTeams?: Record<string, string[]>;
  stats?: TPStat[];
  memberships?: TPMembership[];
  players?: PublicPlayer[];
  globalRoster?: { playerId: string; joinedAt: string }[];
}) {
  const byT = new Map<string, TPMatch[]>();
  for (const m of opts.matches) byT.set(m.tournamentId, [...(byT.get(m.tournamentId) ?? []), m]);
  const tt = new Map(Object.entries(opts.tournamentTeams ?? {}));
  for (const t of opts.tournaments) if (!tt.has(t.id)) tt.set(t.id, ['a', 'b', 'c', 'd']);
  return buildTeamProfile({
    team: { ...ref('a'), city: 'Mazatlán', coverUrl: null, coverPosition: { x: 50, y: 50 } },
    tournaments: new Map(opts.tournaments.map((t) => [t.id, t])),
    enrolledTournamentIds: new Set(opts.enrolled ?? opts.tournaments.map((t) => t.id)),
    tournamentMatches: byT,
    tournamentTeams: tt,
    stats: opts.stats ?? [],
    memberships: opts.memberships ?? [],
    players: new Map((opts.players ?? []).map((p) => [p.id, p])),
    teams: new Map(['a', 'b', 'c', 'd'].map((id) => [id, ref(id)])),
    globalRoster: opts.globalRoster,
  });
}

describe('buildTeamProfile', () => {
  it('equipo sin partidos ni torneos: todo en cero y vacío', () => {
    const p = build({ tournaments: [], matches: [] });
    expect(p.career).toEqual({ matchesPlayed: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, competitions: 0 });
    expect(p).toMatchObject({ currentParticipations: [], competitions: [], rosters: [], topScorers: [], recentMatches: [], history: [], honors: [], form: [] });
    expect(p.team).toMatchObject({ id: 'a', city: 'Mazatlán' });
  });

  it('balance como local y visitante: victoria, empate y derrota; solo FINISHED con marcador', () => {
    const r = recordOf('a', [
      M('t', 'a', 'b', 3, 1, '2027-01-01'), // local, gana
      M('t', 'c', 'a', 2, 2, '2027-01-08'), // visitante, empata
      M('t', 'd', 'a', 2, 0, '2027-01-15'), // visitante, pierde
      M('t', 'a', 'c', null, null, '2027-01-22', MatchStatus.SCHEDULED),
      M('t', 'a', 'd', 5, 0, '2027-01-29', MatchStatus.LIVE),
      M('t', 'a', 'b', null, null, '2027-02-05', MatchStatus.POSTPONED),
      M('t', 'b', 'a', null, null, '2027-02-12', MatchStatus.CANCELLED),
      M('t', 'b', 'c', 9, 0, '2027-02-19'), // no es del equipo
    ]);
    expect(r).toEqual({ matchesPlayed: 3, wins: 1, draws: 1, losses: 1, goalsFor: 5, goalsAgainst: 5, goalDifference: 0 });
  });

  it('varios torneos: competiciones sin duplicar, actuales primero, total = suma; historial por año', () => {
    const p = build({
      tournaments: [T('copa', 'FINISHED', '2026-11-01'), T('liga', 'ACTIVE', '2027-01-10'), T('vet', 'DRAFT', '2027-04-10')],
      matches: [M('copa', 'a', 'b', 2, 0, '2026-11-07'), M('liga', 'c', 'a', 1, 3, '2027-01-16'), M('liga', 'a', 'd', 0, 0, '2027-01-23')],
    });
    expect(p.competitions.map((c) => [c.tournament.id, c.current, c.record.matchesPlayed])).toEqual([
      ['vet', true, 0],
      ['liga', true, 2],
      ['copa', false, 1],
    ]);
    expect(p.career).toMatchObject({ matchesPlayed: 3, wins: 2, draws: 1, goalsFor: 5, goalsAgainst: 1, competitions: 3 });
    expect(p.currentParticipations.map((c) => c.tournament.id)).toEqual(['vet', 'liga']);
    expect(p.currentParticipations[1].standing).toMatchObject({ position: 1, teams: 4 });
    expect(p.currentParticipations[0].standing).toBeNull(); // sin resultados todavía
    expect(p.history.map((h) => [h.year, h.competitions.map((c) => c.tournament.id)])).toEqual([
      ['2027', ['vet', 'liga']],
      ['2026', ['copa']],
    ]);
  });

  it('torneo finalizado completo y sin empate: posición final y título de liga', () => {
    const p = build({
      tournaments: [T('copa', 'FINISHED', '2026-11-01')],
      matches: [M('copa', 'a', 'b', 2, 0, '2026-11-07'), M('copa', 'c', 'd', 1, 1, '2026-11-07')],
    });
    expect(p.competitions[0].finalStanding).toEqual({ position: 1, teams: 4, points: 3 });
    expect(p.honors).toEqual([{ type: 'CHAMPION', tournament: { id: 'copa', name: 'Torneo copa' }, year: 2026, decidedBy: 'LEAGUE_TABLE' }]);
  });

  it('sin título: torneo activo, con partidos pendientes, o empate en puntos/DG/GF', () => {
    const active = build({ tournaments: [T('t', 'ACTIVE', '2027-01-01')], matches: [M('t', 'a', 'b', 2, 0, '2027-01-07')] });
    expect(active.honors).toEqual([]);
    expect(active.competitions[0].finalStanding).toBeNull();

    const pending = build({
      tournaments: [T('t', 'FINISHED', '2027-01-01')],
      matches: [M('t', 'a', 'b', 2, 0, '2027-01-07'), M('t', 'c', 'd', null, null, '2027-01-14', MatchStatus.POSTPONED)],
    });
    expect(pending.honors).toEqual([]);
    expect(pending.competitions[0].finalStanding).toBeNull();

    // a y c: mismos puntos, DG y GF → el orden lo decidiría el nombre: ambiguo
    const tie = build({
      tournaments: [T('t', 'FINISHED', '2027-01-01')],
      matches: [M('t', 'a', 'b', 1, 0, '2027-01-07'), M('t', 'c', 'd', 1, 0, '2027-01-07')],
    });
    expect(tie.honors).toEqual([]);
    expect(tie.competitions[0].finalStanding).toBeNull();
  });

  it('sistema que no es liga: nunca se deriva campeón', () => {
    const p = build({ tournaments: [T('k', 'FINISHED', '2027-01-01', 'KNOCKOUT')], matches: [M('k', 'a', 'b', 2, 0, '2027-01-07')] });
    expect(p.honors).toEqual([]);
  });

  it('plantillas por competición: memberships históricos se conservan (active=false) con sus partidos', () => {
    const players = [P('p1', 'Uno'), P('p2', 'Dos'), P('p3', 'Tres')];
    const p = build({
      tournaments: [T('copa', 'FINISHED', '2026-11-01'), T('liga', 'ACTIVE', '2027-01-10')],
      matches: [M('liga', 'a', 'b', 1, 0, '2027-01-16')],
      players,
      memberships: [
        mem('p1', 'copa'),
        mem('p2', 'copa', { active: false }),
        mem('p1', 'liga', { jerseyNumber: 10 }),
        mem('p3', 'liga', { active: false, jerseyNumber: 7 }),
      ],
      stats: [stat('p3', 'liga', 1), stat('p1', 'copa', 2)],
    });
    expect(p.rosters.map((r) => [r.tournament.id, r.players.map((x) => [x.player.id, x.active, x.jerseyNumber, x.appearances, x.goals])])).toEqual([
      ['liga', [['p1', true, 10, 0, 0], ['p3', false, 7, 1, 1]]],
      ['copa', [['p1', true, 9, 1, 2], ['p2', false, 9, 0, 0]]],
    ]);
  });

  it('goleadores: solo lo hecho con este equipo; desempate determinista', () => {
    const players = [P('p1', 'Alfa'), P('p2', 'Beta'), P('p3', 'Gama'), P('p4', 'Delta')];
    const p = build({
      tournaments: [T('liga', 'ACTIVE', '2027-01-10')],
      matches: [],
      players,
      // p1: 3 goles en 2 PJ · p2: 3 goles en 1 PJ · p3: 3 goles en 1 PJ con 1 asistencia · p4: 0 goles
      stats: [stat('p1', 'liga', 2), stat('p1', 'liga', 1), stat('p2', 'liga', 3), stat('p3', 'liga', 3, 1), stat('p4', 'liga', 0, 2)],
    });
    expect(p.topScorers.map((s) => [s.player.id, s.goals, s.appearances, s.assists])).toEqual([
      ['p3', 3, 1, 1],
      ['p2', 3, 1, 0],
      ['p1', 3, 2, 0],
    ]);
    expect(p.topScorers[0].player).not.toHaveProperty('birthDate');
  });

  it('partidos: 5 recientes FINISHED (más reciente primero), próximos solo en torneos no finalizados, forma', () => {
    const matches = [
      ...['2027-01-02', '2027-01-09', '2027-01-16', '2027-01-23', '2027-01-30', '2027-02-06'].map((d, i) => M('liga', i % 2 ? 'b' : 'a', i % 2 ? 'a' : 'b', i, 1, d)),
      M('liga', 'a', 'c', null, null, '2027-03-06', MatchStatus.SCHEDULED),
      M('liga', 'd', 'a', null, null, '2027-02-27', MatchStatus.LIVE),
      M('old', 'a', 'd', null, null, '2026-12-01', MatchStatus.SCHEDULED), // torneo finalizado: no es "próximo"
    ];
    const p = build({ tournaments: [T('liga', 'ACTIVE', '2027-01-01'), T('old', 'FINISHED', '2026-11-01')], matches });
    expect(p.recentMatches.map((m) => m.date)).toEqual(['2027-02-06', '2027-01-30', '2027-01-23', '2027-01-16', '2027-01-09']);
    expect(p.recentMatches[0]).toMatchObject({ homeTeam: { id: 'b' }, awayTeam: { id: 'a' }, homeScore: 5, awayScore: 1, result: 'L', tournament: { id: 'liga' } });
    expect(p.upcomingMatches.map((m) => [m.date, m.status, m.result])).toEqual([
      ['2027-02-27', 'LIVE', null],
      ['2027-03-06', 'SCHEDULED', null],
    ]);
    expect(p.form).toHaveLength(5);
  });

  it('plantilla global actual (currentRoster): separada de las plantillas por torneo y sin efecto en balance ni goleadores', () => {
    const players = [P('p1', 'Zeta'), { ...P('p2', 'Alfa'), position: 'GOALKEEPER' }];
    const p = build({ tournaments: [], matches: [], players, globalRoster: [{ playerId: 'p1', joinedAt: '2027-01-01' }, { playerId: 'p2', joinedAt: '2027-02-01' }, { playerId: 'ghost', joinedAt: '2027-02-01' }] });
    expect(p.currentRoster.map((r) => [r.player.id, r.joinedAt])).toEqual([['p2', '2027-02-01'], ['p1', '2027-01-01']]); // portero primero
    expect(p).toMatchObject({ rosters: [], topScorers: [], career: { matchesPlayed: 0, competitions: 0 } });
    expect(build({ tournaments: [], matches: [] }).currentRoster).toEqual([]);
  });

  it('la cobertura antigua no oculta posiciones ni títulos', () => {
    const matches = [M('liga', 'a', 'b', 2, 0, '2026-11-07'), M('liga', 'c', 'd', 1, 1, '2026-11-07')];
    const stats = [stat('p1', 'liga', 2), stat('p2', 'liga', 0, 2)];
    const players = [P('p1', 'Pérez'), P('p2', 'López')];
    const full = build({ tournaments: [T('liga', 'FINISHED', '2026-11-01')], matches, stats, players });
    const partial = build({ tournaments: [{ ...T('liga', 'FINISHED', '2026-11-01'), dataCoverage: 'PARTIAL' }], matches, stats, players });
    expect(full.honors).toHaveLength(1);
    expect(full.competitions[0].finalStanding).not.toBeNull();
    expect(partial.honors).toEqual(full.honors);
    expect(partial.competitions).toEqual(full.competitions);
    for (const k of ['career', 'form', 'recentMatches', 'topScorers', 'topAssists'] as const) expect(partial[k]).toEqual(full[k]);
    expect(partial.career).toMatchObject({ matchesPlayed: 1, wins: 1, goalsFor: 2 });
    // En curso: tampoco hay posición en la tabla.
    const live = build({ tournaments: [{ ...T('liga', 'ACTIVE', '2026-11-01'), dataCoverage: 'PARTIAL' }], matches });
    expect(live.currentParticipations[0].standing).not.toBeNull();
    expect(build({ tournaments: [T('liga', 'ACTIVE', '2026-11-01')], matches }).currentParticipations[0].standing).not.toBeNull();
  });

  it('asistidores: solo con este equipo y assists > 0; desempate determinista', () => {
    const p = build({
      tournaments: [T('t1', 'ACTIVE', '2027-01-01')],
      matches: [],
      stats: [stat('p1', 't1', 0, 1), stat('p2', 't1', 1, 3), stat('p3', 't1', 4, 0), stat('p4', 't1', 0, 1), stat('p4', 't1', 0, 0)],
      players: [P('p1', 'Zúñiga'), P('p2', 'Álvarez'), P('p3', 'Gómez'), P('p4', 'Arce')],
    });
    // p2 3 asist.; p1 y p4 con 1: p1 jugó menos partidos.
    expect(p.topAssists.map((r) => [r.player.id, r.assists])).toEqual([['p2', 3], ['p1', 1], ['p4', 1]]);
  });
});
