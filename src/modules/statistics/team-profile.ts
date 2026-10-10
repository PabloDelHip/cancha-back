/**
 * Perfil público de un equipo (GET /teams/:id/profile). Función pura: recibe lo que el service leyó
 * (solo lo relacionado con ESE equipo y sus torneos) y arma el agregado. Es la única
 * implementación de estas reglas; el frontend solo las representa.
 *
 * Reglas:
 * - Identidad global: un Team = un perfil en todos sus torneos y organizadores (nunca por createdBy).
 * - Balance: solo partidos FINISHED con marcador, como local o visitante.
 * - Competiciones: torneos donde está inscrito (TournamentTeam) o donde jugó partidos.
 * - Participación actual: inscripción en un torneo NO finalizado.
 * - Plantillas de competición (`rosters`): SIEMPRE por torneo (TeamMembership.tournamentId). Un
 *   jugador que salió sigue en la plantilla histórica (active=false).
 * - Plantilla GLOBAL actual (`currentRoster`, 6B): TeamRoster ACTIVE. Es pertenencia al equipo, no
 *   participación: no demuestra partidos jugados y no alimenta balance, goleadores ni honors.
 * - Goleadores: solo PlayerMatchStats con teamId = este equipo (played=true, partido FINISHED):
 *   lo hecho con esta camiseta, nunca los goles de carrera del jugador.
 * - Posiciones: las de la tabla de su fase (liga regular o su grupo), con la misma función
 *   computeStandings y puntuación que GET /standings; los playoffs nunca cuentan en la tabla.
 * - Posición final verificable (solo formato LEAGUE): torneo FINISHED, sin partidos pendientes y sin
 *   empate en puntos, diferencia y goles a favor con el vecino (si no, lo decidiría el nombre).
 * - Honors: CHAMPION = campeón OFICIAL del formato (competition/structure.ts), solo de torneos
 *   FINISHED. Liga: líder verificable de la tabla final. Eliminación, grupos + eliminación y liga +
 *   playoffs: ganador de la final. Ser 1º de la fase regular NO es ser campeón. Se calcula, no se guarda.
 * - Asistidores (6F): como los goleadores, solo con esta camiseta (assists > 0).
 */
import { CompetitionSystem, KnockoutTiebreak, MatchStatus, PhaseType, PlayerPosition } from '../../common/enums/index.js';
import type { PublicPlayer, TeamRef, TournamentRef } from '../../common/utils/public.js';
import { computeStandings, type PointsRule, type Result, type StandingRow } from './calculations.js';
import { buildStructure } from '../competition/structure.js';
import { phaseMatches, type StagedMatch } from '../competition/tables.js';
import type { TournamentPhase } from '../competition/types.js';

export const RECENT_TEAM_MATCHES = 5;
const UPCOMING_MATCHES = 3;
const TOP_SCORERS = 10;
const TOP_ASSISTS = 10;
const FORM_LENGTH = 5;
const POSITION_ORDER = [PlayerPosition.GOALKEEPER, PlayerPosition.DEFENDER, PlayerPosition.MIDFIELDER, PlayerPosition.FORWARD];
const OPEN = new Set<string>([MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.POSTPONED, MatchStatus.SUSPENDED]);

export type TPMatch = StagedMatch;

/** PlayerMatchStats oficial (played=true, partido FINISHED) registrado con este equipo. */
export interface TPStat {
  matchId: string;
  tournamentId: string;
  playerId: string;
  goals: number;
  assists: number;
  yellowCards?: number;
  redCards?: number;
}

export interface TPMembership {
  playerId: string;
  tournamentId: string;
  jerseyNumber: number | null;
  startDate: string;
  active: boolean;
}

export type TPTournament = TournamentRef & {
  system: string;
  points: PointsRule;
  phases?: TournamentPhase[];
  playoffTeams?: number | null;
  qualifiersPerGroup?: number | null;
  knockoutTiebreak?: KnockoutTiebreak;
  finalTiebreak?: KnockoutTiebreak | null;
};

export interface TeamProfileInput {
  team: TeamRef & { city: string | null; coverUrl: string | null; coverPosition: { x: number; y: number } };
  tournaments: Map<string, TPTournament>;
  enrolledTournamentIds: Set<string>;
  /** Todos los partidos de los torneos del equipo (para tablas y pendientes). */
  tournamentMatches: Map<string, TPMatch[]>;
  /** Equipos inscritos en cada torneo (filas de la tabla). */
  tournamentTeams: Map<string, string[]>;
  stats: TPStat[];
  memberships: TPMembership[];
  players: Map<string, PublicPlayer>;
  /** Periodos ACTIVE de la plantilla global (TeamRoster). */
  globalRoster?: { playerId: string; joinedAt: string }[];
  /** Equipos de esos torneos (nombres para la tabla y los partidos). */
  teams: Map<string, TeamRef>;
}

export interface TeamRecord {
  matchesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
}

export interface TeamStanding {
  position: number;
  teams: number;
  points: number;
}

type Played = TPMatch & { homeScore: number; awayScore: number };
const isFinished = (m: TPMatch): m is Played =>
  m.status === MatchStatus.FINISHED && m.homeScore !== null && m.awayScore !== null;
const byKickoff = (a: TPMatch, b: TPMatch) => `${a.date}${a.time}${a.id}`.localeCompare(`${b.date}${b.time}${b.id}`);

export function resultFor(m: Played, teamId: string): Result {
  const own = m.homeTeamId === teamId ? m.homeScore : m.awayScore;
  const rival = m.homeTeamId === teamId ? m.awayScore : m.homeScore;
  return own > rival ? 'W' : own < rival ? 'L' : 'D';
}

export function recordOf(teamId: string, matches: TPMatch[]): TeamRecord {
  const r: TeamRecord = { matchesPlayed: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0 };
  for (const m of matches) {
    if (!isFinished(m) || (m.homeTeamId !== teamId && m.awayTeamId !== teamId)) continue;
    const own = m.homeTeamId === teamId ? m.homeScore : m.awayScore;
    const rival = m.homeTeamId === teamId ? m.awayScore : m.homeScore;
    r.matchesPlayed++;
    r.goalsFor += own;
    r.goalsAgainst += rival;
    if (own > rival) r.wins++;
    else if (own < rival) r.losses++;
    else r.draws++;
  }
  r.goalDifference = r.goalsFor - r.goalsAgainst;
  return r;
}

const tied = (a: StandingRow | undefined, b: StandingRow) =>
  !!a && a.points === b.points && a.goalDifference === b.goalDifference && a.goalsFor === b.goalsFor;

/** Posición final solo si es verificable (ver cabecera). */
export function verifiableFinal(teamId: string, tournament: TPTournament, matches: TPMatch[], rows: StandingRow[]): TeamStanding | null {
  if (tournament.status !== 'FINISHED') return null;
  if (matches.some((m) => OPEN.has(m.status))) return null;
  const i = rows.findIndex((r) => r.teamId === teamId);
  if (i < 0 || rows[i].played === 0) return null;
  if (tied(rows[i - 1], rows[i]) || tied(rows[i + 1], rows[i])) return null;
  return { position: rows[i].position, teams: rows.length, points: rows[i].points };
}

export function buildTeamProfile(input: TeamProfileInput) {
  const { team, tournaments, teams, players } = input;
  const tournamentList = [...tournaments.values()];
  const teamMatches = [...input.tournamentMatches.values()]
    .flat()
    .filter((m) => m.homeTeamId === team.id || m.awayTeamId === team.id)
    .sort(byKickoff);

  const nameOf = (id: string) => teams.get(id)?.name ?? '';

  const competitions = tournamentList
    .map((t) => {
      const all = input.tournamentMatches.get(t.id) ?? [];
      const current = t.status !== 'FINISHED' && input.enrolledTournamentIds.has(t.id);

      const hasResults = all.some(isFinished);
      const structure = buildStructure({
        system: t.system as CompetitionSystem,
        points: t.points,
        playoffTeams: t.playoffTeams ?? null,
        qualifiersPerGroup: t.qualifiersPerGroup ?? null,
        knockoutTiebreak: t.knockoutTiebreak ?? KnockoutTiebreak.PENALTIES,
        finalTiebreak: t.finalTiebreak ?? null,
        phases: t.phases ?? [],
        matches: all,
        teamIds: input.tournamentTeams.get(t.id) ?? [],
        nameOf,
      });
      // Posición en la tabla de su fase: liga regular, o su propio grupo.
      const first = structure.phases[0];
      const rows =
        first?.type === PhaseType.LEAGUE ? first.table : first?.type === PhaseType.GROUPS ? (first.groups.find((g) => g.teamIds.includes(team.id))?.table ?? []) : [];
      const row = hasResults ? rows.find((r) => r.teamId === team.id) : undefined;
      const classic = t.system === CompetitionSystem.LEAGUE;
      const leagueRows = classic && hasResults ? computeStandings(input.tournamentTeams.get(t.id) ?? [], phaseMatches(all, 0), nameOf, t.points) : [];
      // Finalista: perdió la final del cuadro (torneo finalizado y con la competición completa).
      const ko = structure.phases.find((p) => p.type === PhaseType.KNOCKOUT);
      const final = ko?.type === PhaseType.KNOCKOUT ? ko.rounds.at(-1)?.ties[0] : undefined;
      const runnerUp =
        t.status === 'FINISHED' && !!final?.winnerTeamId && final.winnerTeamId !== team.id && (final.homeTeamId === team.id || final.awayTeamId === team.id);
      const { system: _system, points: _points, phases: _phases, playoffTeams: _p, qualifiersPerGroup: _q, knockoutTiebreak: _k, finalTiebreak: _f, ...tournament } = t;
      return {
        tournament: { ...tournament, dataCoverage: 'FULL' as const },
        system: t.system,
        current,
        record: recordOf(team.id, all),
        standing: current && row ? { position: row.position, teams: rows.length, points: row.points } : null,
        finalStanding: classic && hasResults ? verifiableFinal(team.id, t, all, leagueRows) : null,
        champion: t.status === 'FINISHED' && structure.championTeamId === team.id,
        runnerUp,
      };
    })
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.tournament.startDate.localeCompare(a.tournament.startDate) ||
        a.tournament.id.localeCompare(b.tournament.id),
    );

  // Plantillas por competición, con lo que cada jugador hizo con este equipo en ese torneo.
  const rosters = competitions
    .map(({ tournament }) => {
      const inT = input.memberships
        .filter((m) => m.tournamentId === tournament.id)
        .sort((a, b) => b.startDate.localeCompare(a.startDate))
        .filter((m, i, list) => list.findIndex((x) => x.playerId === m.playerId) === i);
      const statsInT = input.stats.filter((s) => s.tournamentId === tournament.id);
      const rows = inT
        .filter((m) => players.has(m.playerId))
        .map((m) => {
          const own = statsInT.filter((s) => s.playerId === m.playerId);
          return {
            player: players.get(m.playerId)!,
            jerseyNumber: m.jerseyNumber,
            active: m.active,
            appearances: own.length,
            goals: own.reduce((sum, s) => sum + s.goals, 0),
          };
        })
        .sort(
          (a, b) =>
            Number(b.active) - Number(a.active) ||
            POSITION_ORDER.indexOf(a.player.position as PlayerPosition) - POSITION_ORDER.indexOf(b.player.position as PlayerPosition) ||
            (a.jerseyNumber ?? 99) - (b.jerseyNumber ?? 99) ||
            a.player.id.localeCompare(b.player.id),
        );
      return { tournament: { id: tournament.id, name: tournament.name, status: tournament.status }, players: rows };
    })
    .filter((r) => r.players.length);

  const topScorers = rankContributors(input.stats, players, 'goals', TOP_SCORERS);
  const topAssists = rankContributors(input.stats, players, 'assists', TOP_ASSISTS);
  const playerStats = teamPlayerStats(input, players, tournaments, teams);

  const finished = teamMatches.filter(isFinished).reverse();
  const toMatch = (m: TPMatch) => teamMatch(m, team.id, tournaments, teams);

  const years = new Map<string, { tournament: { id: string; name: string; status: string }; record: TeamRecord; finalStanding: TeamStanding | null; current: boolean }[]>();
  for (const c of competitions) {
    const year = c.tournament.startDate.slice(0, 4);
    years.set(year, [
      ...(years.get(year) ?? []),
      { tournament: { id: c.tournament.id, name: c.tournament.name, status: c.tournament.status }, record: c.record, finalStanding: c.finalStanding, current: c.current },
    ]);
  }

  const record = recordOf(team.id, teamMatches);
  return {
    team,
    career: { ...record, competitions: competitions.length },
    /** Últimos resultados, del más antiguo al más reciente. */
    form: finished.slice(0, FORM_LENGTH).map((m) => resultFor(m, team.id)).reverse(),
    currentParticipations: competitions.filter((c) => c.current).map((c) => ({ tournament: c.tournament, standing: c.standing })),
    competitions: competitions.map(({ system: _system, champion: _champion, runnerUp: _runnerUp, ...c }) => c),
    rosters,
    currentRoster: (input.globalRoster ?? [])
      .filter((r) => players.has(r.playerId))
      .map((r) => ({ player: players.get(r.playerId)!, joinedAt: r.joinedAt }))
      .sort(
        (a, b) =>
          POSITION_ORDER.indexOf(a.player.position as PlayerPosition) - POSITION_ORDER.indexOf(b.player.position as PlayerPosition) ||
          a.player.lastName.localeCompare(b.player.lastName) ||
          a.player.id.localeCompare(b.player.id),
      ),
    topScorers,
    topAssists,
    playerStats,
    records: teamRecords(team.id, finished, competitions, toMatch),
    recentMatches: finished.slice(0, RECENT_TEAM_MATCHES).map(toMatch),
    upcomingMatches: teamMatches
      .filter((m) => (m.status === MatchStatus.SCHEDULED || m.status === MatchStatus.LIVE) && tournaments.get(m.tournamentId)?.status !== 'FINISHED')
      .slice(0, UPCOMING_MATCHES)
      .map(toMatch),
    history: [...years.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([year, list]) => ({ year, competitions: list })),
    honors: competitions
      .filter((c) => c.champion)
      .map((c) => ({
        type: 'CHAMPION' as const,
        tournament: { id: c.tournament.id, name: c.tournament.name },
        year: Number(c.tournament.startDate.slice(0, 4)),
        // Cómo se decidió el título: tabla final de la liga clásica o final del cuadro.
        decidedBy: c.system === CompetitionSystem.LEAGUE ? ('LEAGUE_TABLE' as const) : ('FINAL' as const),
      })),
    /** Finales perdidas (aparte de `honors`, que son solo títulos). */
    runnerUps: competitions
      .filter((c) => c.runnerUp)
      .map((c) => ({ tournament: { id: c.tournament.id, name: c.tournament.name }, year: Number(c.tournament.startDate.slice(0, 4)) })),
  };
}

/**
 * Récords del equipo con partidos oficiales finalizados:
 * - Mayor victoria / derrota: mayor diferencia de goles; a igualdad, más goles anotados (o recibidos)
 *   y después el más reciente.
 * - Porterías en cero: partidos sin recibir gol.
 * - Mejor / peor torneo: por puntos por partido (3/1/0, igual para todos los formatos y comparable
 *   entre torneos), luego diferencia de goles por partido; un título pesa más que cualquier
 *   promedio. El peor solo existe con dos o más torneos jugados.
 */
function teamRecords<C extends { tournament: { id: string }; record: TeamRecord; champion: boolean }, M>(
  teamId: string,
  finishedNewestFirst: TPMatch[],
  competitions: C[],
  toMatch: (m: TPMatch) => M,
) {
  const side = (m: TPMatch) => {
    const own = (m.homeTeamId === teamId ? m.homeScore : m.awayScore) ?? 0;
    const rival = (m.homeTeamId === teamId ? m.awayScore : m.homeScore) ?? 0;
    return { m, own, rival };
  };
  const rows = finishedNewestFirst.map(side); // ya viene del más reciente al más antiguo
  const pick = (list: typeof rows, key: (r: (typeof rows)[number]) => [number, number]) =>
    list.reduce<(typeof rows)[number] | null>((best, r) => {
      if (!best) return r;
      const [a1, a2] = key(r);
      const [b1, b2] = key(best);
      return a1 > b1 || (a1 === b1 && a2 > b2) ? r : best; // a igualdad se queda el más reciente
    }, null);
  const win = pick(rows.filter((r) => r.own > r.rival), (r) => [r.own - r.rival, r.own]);
  const loss = pick(rows.filter((r) => r.own < r.rival), (r) => [r.rival - r.own, r.rival]);
  const clean = rows.filter((r) => r.rival === 0).length;

  const ppg = (r: TeamRecord) => (r.wins * 3 + r.draws) / r.matchesPlayed;
  const gdpg = (r: TeamRecord) => r.goalDifference / r.matchesPlayed;
  const played = competitions.filter((c) => c.record.matchesPlayed > 0);
  const best = [...played].sort((a, b) => Number(b.champion) - Number(a.champion) || ppg(b.record) - ppg(a.record) || gdpg(b.record) - gdpg(a.record))[0];
  const worst = played.length > 1 ? [...played].sort((a, b) => ppg(a.record) - ppg(b.record) || gdpg(a.record) - gdpg(b.record))[0] : undefined;
  const summary = (c: C | undefined) => (c ? { ...c, pointsPerMatch: Math.round(ppg(c.record) * 100) / 100 } : null);
  const score = (r: (typeof rows)[number] | null) => r && { match: toMatch(r.m), goalsFor: r.own, goalsAgainst: r.rival };
  return {
    biggestWin: score(win),
    biggestLoss: score(loss),
    cleanSheets: { count: clean, played: rows.length, rate: rows.length ? Math.round((clean / rows.length) * 100) : null },
    bestTournament: summary(best),
    worstTournament: worst && worst !== best ? summary(worst) : null,
  };
}

/**
 * Todos los jugadores que jugaron con el equipo (partidos oficiales finalizados): partidos, goles,
 * asistencias, tarjetas y en qué partidos vio cada tarjeta. Ordenados por goles; la UI arma sus
 * tops (goles, asistencias, promedio, amarillas, rojas) y el "ver más".
 */
function teamPlayerStats(input: TeamProfileInput, players: Map<string, PublicPlayer>, tournaments: Map<string, TPTournament>, teams: Map<string, TeamRef>) {
  const teamId = input.team.id;
  const matchById = new Map([...input.tournamentMatches.values()].flat().map((m) => [m.id, m]));
  const rows = new Map<string, { appearances: number; goals: number; assists: number; yellowCards: number; redCards: number; conceded: number; cleanSheets: number; cards: { match: { id: string; date: string; tournament: { id: string; name: string } | null; opponent: TeamRef | null }; yellow: number; red: number }[] }>();
  for (const s of input.stats) {
    if (!players.has(s.playerId)) continue;
    const row = rows.get(s.playerId) ?? { appearances: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, conceded: 0, cleanSheets: 0, cards: [] };
    row.appearances++;
    row.goals += s.goals;
    row.assists += s.assists;
    row.yellowCards += s.yellowCards ?? 0;
    row.redCards += s.redCards ?? 0;
    const m = matchById.get(s.matchId);
    // Goles que recibió el equipo con el jugador en cancha (la UI lo usa para los porteros).
    const against = m ? (m.homeTeamId === teamId ? m.awayScore : m.homeScore) ?? 0 : 0;
    row.conceded += against;
    if (m && against === 0) row.cleanSheets++;
    if (m && (s.yellowCards || s.redCards)) {
      const t = tournaments.get(m.tournamentId);
      row.cards.push({
        match: { id: m.id, date: m.date, tournament: t ? { id: t.id, name: t.name } : null, opponent: teams.get(m.homeTeamId === teamId ? m.awayTeamId : m.homeTeamId) ?? null },
        yellow: s.yellowCards ?? 0,
        red: s.redCards ?? 0,
      });
    }
    rows.set(s.playerId, row);
  }
  return [...rows.entries()]
    .map(([id, r]) => ({ player: players.get(id)!, ...r, cards: r.cards.sort((a, b) => b.match.date.localeCompare(a.match.date)) }))
    .sort((a, b) => b.goals - a.goals || a.appearances - b.appearances || a.player.id.localeCompare(b.player.id));
}

export interface Contributor {
  player: PublicPlayer;
  goals: number;
  assists: number;
  appearances: number;
}

/**
 * Goleadores (`goals`) o asistidores (`assists`) a partir de PlayerMatchStats oficiales YA filtrados
 * por equipo (una fila = un partido jugado). Solo quien tiene > 0 en la métrica. Desempate
 * determinista: menos partidos, más de la otra métrica, apellido y nombre, id. Única implementación:
 * la usan el Team Profile y el resumen de equipos en seguimiento (6G).
 */
export function rankContributors(
  stats: Pick<TPStat, 'playerId' | 'goals' | 'assists'>[],
  players: Map<string, PublicPlayer>,
  metric: 'goals' | 'assists',
  limit: number,
): Contributor[] {
  const rows = new Map<string, { goals: number; assists: number; appearances: number }>();
  for (const s of stats) {
    const row = rows.get(s.playerId) ?? { goals: 0, assists: 0, appearances: 0 };
    row.goals += s.goals;
    row.assists += s.assists;
    row.appearances++;
    rows.set(s.playerId, row);
  }
  const other = metric === 'goals' ? 'assists' : 'goals';
  return [...rows.entries()]
    .filter(([id, row]) => row[metric] > 0 && players.has(id))
    .map(([id, row]) => ({ player: players.get(id)!, ...row }))
    .sort(
      (a, b) =>
        b[metric] - a[metric] ||
        a.appearances - b.appearances ||
        b[other] - a[other] ||
        `${a.player.lastName} ${a.player.firstName}`.localeCompare(`${b.player.lastName} ${b.player.firstName}`) ||
        a.player.id.localeCompare(b.player.id),
    )
    .slice(0, limit);
}

/** Partido desde el lado del equipo del perfil. */
export function teamMatch(m: TPMatch, teamId: string, tournaments: Map<string, TournamentRef>, teams: Map<string, TeamRef>) {
  const t = tournaments.get(m.tournamentId);
  return {
    id: m.id,
    date: m.date,
    time: m.time,
    round: m.round,
    status: m.status,
    tournament: t ? { id: t.id, name: t.name } : null,
    homeTeam: teams.get(m.homeTeamId) ?? null,
    awayTeam: teams.get(m.awayTeamId) ?? null,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    result: isFinished(m) ? resultFor(m, teamId) : null,
  };
}

export type TeamProfile = ReturnType<typeof buildTeamProfile>;
