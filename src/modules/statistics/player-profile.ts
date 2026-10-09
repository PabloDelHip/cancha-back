/**
 * Perfil deportivo de un Player (GET /players/:id/profile). Función pura: recibe lo que el
 * service leyó de la base (solo datos de ESE jugador) y arma el agregado. Es la única
 * implementación de estas reglas; el frontend solo las representa.
 *
 * Reglas:
 * - Estadística oficial = PlayerMatchStats con played = true de un Match FINISHED (el service
 *   ya filtra ambos). SCHEDULED, LIVE, POSTPONED y CANCELLED no suman en nada.
 * - La identidad es el playerId. Cada PlayerMatchStats es un partido (índice único partido+jugador).
 * - Agrupación: competición (torneo) → equipo. El mismo equipo en dos torneos son dos
 *   participaciones; cambiar de equipo dentro de un torneo, también.
 * - Participación ACTUAL = TeamMembership activa en un torneo NO finalizado. Finalizar un
 *   torneo no modifica sus memberships (siguen `active`), pero pasan a ser historia.
 * - Fin de una participación: baja/cambio (endDate) o, si el torneo terminó, su endDate o el
 *   último partido jugado.
 * - V2 · Resultado de la competición (campeón, finalista, fase alcanzada, posición final) y
 *   honors: de la estructura oficial del torneo FINALIZADO (competition-outcome.ts). El jugador
 *   "participó" en el resultado de un equipo solo si jugó al menos un partido oficial con ese
 *   equipo en ese torneo (estar en la plantilla sin jugar no da títulos).
 * - V2 · Por año, por equipo, hitos, récords y mejores actuaciones: player-insights.ts.
 */
import type { PublicPlayer, TeamRef, TournamentRef } from '../../common/utils/public.js';
import { CompetitionSystem, PlayerPosition } from '../../common/enums/index.js';
import { structureOf, teamOutcome, topScorerOf, type CompetitionContext } from './competition-outcome.js';
import { bestPerformances, goalkeepingOf, milestonesOf, recordsOf, statsByTeam, statsByYear } from './player-insights.js';

export type Result = 'W' | 'D' | 'L';

export interface StatLine {
  appearances: number;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
}

/** Un partido FINISHED del jugador con su línea estadística. */
export interface ProfileEntry {
  matchId: string;
  tournamentId: string;
  round: number;
  date: string;
  time: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  /** Equipo con el que jugó ESE partido. */
  teamId: string;
  goals: number;
  assists: number;
  yellowCards: number;
  redCards: number;
}

export interface ProfileMembership {
  tournamentId: string;
  teamId: string;
  jerseyNumber: number | null;
  startDate: string;
  endDate: string | null;
  active: boolean;
}

export interface ProfileInput {
  player: PublicPlayer;
  entries: ProfileEntry[];
  memberships: ProfileMembership[];
  tournaments: Map<string, TournamentRef>;
  teams: Map<string, TeamRef>;
  recentLimit?: number;
  /** Torneos del jugador con formato, fases, partidos e inscritos (resultado oficial). */
  competitionContexts?: Map<string, CompetitionContext>;
  /** Torneos FINALIZADOS → goles oficiales por jugador (goleador del torneo). */
  tournamentGoals?: Map<string, Map<string, number>>;
}

export type HonorType = 'CHAMPION' | 'TOP_SCORER' | 'RUNNER_UP';
const HONOR_ORDER: HonorType[] = ['CHAMPION', 'TOP_SCORER', 'RUNNER_UP'];

export const RECENT_MATCHES = 5;
const FORM_LENGTH = 5;
const FINISHED = 'FINISHED';

export function emptyLine(): StatLine {
  return { appearances: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0 };
}

function addEntry(line: StatLine, e: ProfileEntry): StatLine {
  return {
    appearances: line.appearances + 1,
    goals: line.goals + e.goals,
    assists: line.assists + e.assists,
    yellowCards: line.yellowCards + e.yellowCards,
    redCards: line.redCards + e.redCards,
  };
}

function addLines(a: StatLine, b: StatLine): StatLine {
  return {
    appearances: a.appearances + b.appearances,
    goals: a.goals + b.goals,
    assists: a.assists + b.assists,
    yellowCards: a.yellowCards + b.yellowCards,
    redCards: a.redCards + b.redCards,
  };
}

export function resultOf(e: Pick<ProfileEntry, 'homeTeamId' | 'homeScore' | 'awayScore' | 'teamId'>): Result {
  const own = e.teamId === e.homeTeamId ? e.homeScore : e.awayScore;
  const rival = e.teamId === e.homeTeamId ? e.awayScore : e.homeScore;
  return own > rival ? 'W' : own < rival ? 'L' : 'D';
}

/** Más reciente primero (fecha, hora y, a igualdad, id: orden estable). */
export function byMostRecent(a: Pick<ProfileEntry, 'date' | 'time' | 'matchId'>, b: typeof a) {
  return `${b.date}${b.time}${b.matchId}`.localeCompare(`${a.date}${a.time}${a.matchId}`);
}

export function buildPlayerProfile(input: ProfileInput) {
  const { tournaments, teams } = input;
  const entries = [...input.entries].sort(byMostRecent);
  const team = (id: string) => teams.get(id) ?? null;
  const nameOf = (id: string) => teams.get(id)?.name ?? '';

  // Competición → equipo → { memberships, partidos }
  const groups = new Map<string, Map<string, { memberships: ProfileMembership[]; entries: ProfileEntry[] }>>();
  const slot = (tournamentId: string, teamId: string) => {
    const byTeam = groups.get(tournamentId) ?? new Map();
    groups.set(tournamentId, byTeam);
    const found = byTeam.get(teamId) ?? { memberships: [], entries: [] };
    byTeam.set(teamId, found);
    return found;
  };
  for (const m of input.memberships) slot(m.tournamentId, m.teamId).memberships.push(m);
  for (const e of entries) slot(e.tournamentId, e.teamId).entries.push(e);

  const competitions = [...groups.entries()]
    .filter(([tournamentId]) => tournaments.has(tournamentId))
    .map(([tournamentId, byTeam]) => {
      const tournament = { ...tournaments.get(tournamentId)!, dataCoverage: 'FULL' as const };
      const finished = tournament.status === FINISHED;

      const ctx = input.competitionContexts?.get(tournamentId);
      const structure = ctx && finished ? structureOf(ctx, nameOf) : null;
      const teamParticipations = [...byTeam.entries()].map(([teamId, g]) => {
        const latest = [...g.memberships].sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
        const current = !finished && g.memberships.some((m) => m.active);
        const matchDates = g.entries.map((e) => e.date).sort();
        const ended = g.memberships.map((m) => m.endDate).filter((d): d is string => d !== null).sort();
        return {
          team: team(teamId),
          jerseyNumber: latest?.jerseyNumber ?? null,
          startDate: [...g.memberships.map((m) => m.startDate), ...matchDates].sort()[0] ?? null,
          endDate: current ? null : (ended.at(-1) ?? tournament.endDate ?? matchDates.at(-1) ?? null),
          current,
          stats: g.entries.reduce(addEntry, emptyLine()),
          // Solo si jugó con este equipo: el resultado del equipo no es suyo si no disputó partidos.
          outcome: ctx && structure && g.entries.length ? teamOutcome(teamId, ctx, structure, nameOf) : null,
        };
      });
      teamParticipations.sort(
        (a, b) => Number(b.current) - Number(a.current) || (b.startDate ?? '').localeCompare(a.startDate ?? ''),
      );
      const stats = teamParticipations.map((t) => t.stats).reduce(addLines, emptyLine());
      return {
        tournament,
        system: (ctx?.tournament.system ?? null) as CompetitionSystem | null,
        stats,
        teams: teamParticipations,
        topScorer: finished && stats.appearances ? topScorerOf(input.player.id, input.tournamentGoals?.get(tournamentId)) : null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.teams.some((t) => t.current)) - Number(a.teams.some((t) => t.current)) ||
        b.tournament.startDate.localeCompare(a.tournament.startDate) ||
        a.tournament.id.localeCompare(b.tournament.id),
    );

  const currentParticipations = competitions.flatMap((c) =>
    c.teams
      .filter((t) => t.current)
      .map((t) => ({ tournament: c.tournament, team: t.team, jerseyNumber: t.jerseyNumber, startDate: t.startDate, stats: t.stats })),
  );

  // Palmarés: resultados oficiales de torneos finalizados (ver cabecera).
  const honors = competitions
    .flatMap((c) => {
      const year = Number(c.tournament.startDate.slice(0, 4));
      const tournament = { id: c.tournament.id, name: c.tournament.name };
      const list: { type: HonorType; tournament: typeof tournament; team: TeamRef | null; year: number; decidedBy?: 'LEAGUE_TABLE' | 'FINAL'; goals?: number; shared?: boolean }[] = [];
      for (const t of c.teams) {
        if (t.outcome?.champion) {
          list.push({ type: 'CHAMPION', tournament, team: t.team, year, decidedBy: c.system === CompetitionSystem.LEAGUE ? 'LEAGUE_TABLE' : 'FINAL' });
        }
        if (t.outcome?.runnerUp) list.push({ type: 'RUNNER_UP', tournament, team: t.team, year });
      }
      if (c.topScorer) list.push({ type: 'TOP_SCORER', tournament, team: null, year, goals: c.topScorer.goals, shared: c.topScorer.shared });
      return list;
    })
    .sort((a, b) => b.year - a.year || HONOR_ORDER.indexOf(a.type) - HONOR_ORDER.indexOf(b.type) || a.tournament.name.localeCompare(b.tournament.name));

  // Trayectoria por año de inicio de cada participación (más reciente primero).
  const years = new Map<string, HistoryItem[]>();
  for (const c of competitions) {
    for (const t of c.teams) {
      const year = (t.startDate ?? c.tournament.startDate).slice(0, 4);
      years.set(year, [
        ...(years.get(year) ?? []),
        {
          tournament: { id: c.tournament.id, name: c.tournament.name, status: c.tournament.status },
          team: t.team,
          jerseyNumber: t.jerseyNumber,
          startDate: t.startDate,
          endDate: t.endDate,
          current: t.current,
        },
      ]);
    }
  }
  const history = [...years.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, participations]) => ({
      year,
      participations: participations.sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? '')),
    }));

  const totals = entries.reduce(addEntry, emptyLine());
  const asMatch = (e: ProfileEntry) => profileMatch(e, tournaments, teams);
  const records = recordsOf(entries);
  const keeper = input.player.position === PlayerPosition.GOALKEEPER ? goalkeepingOf(entries, teams) : null;
  const perMatch = (n: number) => (totals.appearances ? Math.round((n / totals.appearances) * 100) / 100 : null);
  return {
    player: input.player,
    currentParticipations,
    career: {
      ...totals,
      goalsPerMatch: perMatch(totals.goals),
      assistsPerMatch: perMatch(totals.assists),
      competitions: competitions.length,
      /** Equipos distintos con los que jugó partidos oficiales. */
      teams: new Set(entries.map((e) => e.teamId)).size,
      titles: honors.filter((h) => h.type === 'CHAMPION').length,
    },
    /** Últimos resultados, del más antiguo al más reciente (todas las competiciones). */
    form: entries.slice(0, FORM_LENGTH).map(resultOf).reverse(),
    competitions,
    history,
    recentMatches: entries.slice(0, input.recentLimit ?? RECENT_MATCHES).map(asMatch),
    honors,
    byYear: statsByYear(entries),
    byTeam: statsByTeam(entries, teams),
    /** Más reciente primero. */
    milestones: milestonesOf(entries)
      .reverse()
      .map((m) => ({ type: m.type, value: m.value, match: asMatch(m.entry) })),
    records: {
      mostGoalsInMatch: records.mostGoalsInMatch && { value: records.mostGoalsInMatch.value, match: asMatch(records.mostGoalsInMatch.entry) },
      mostAssistsInMatch: records.mostAssistsInMatch && { value: records.mostAssistsInMatch.value, match: asMatch(records.mostAssistsInMatch.entry) },
      longestScoringStreak: records.longestScoringStreak,
      mostMatchesInYear: records.mostMatchesInYear,
      hatTricks: records.hatTricks,
      braces: records.braces,
    },
    /** La primera es el "partido destacado". */
    bestPerformances: bestPerformances(entries).map(asMatch),
    /** Solo porteros: goles recibidos, porterías en cero, rachas e hitos propios del puesto. */
    goalkeeping: keeper && {
      career: keeper.career,
      longestCleanSheetStreak: keeper.longestCleanSheetStreak,
      byYear: keeper.byYear,
      byTeam: keeper.byTeam,
      byTournament: keeper.byTournament,
      milestones: keeper.milestones.reverse().map((m) => ({ type: m.type, value: m.value, match: asMatch(m.entry) })),
      bestMatches: keeper.best.map(asMatch),
    },
  };
}

export interface HistoryItem {
  tournament: { id: string; name: string; status: string };
  team: TeamRef | null;
  jerseyNumber: number | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
}

/** Partido del jugador listo para pintar: marcador, contexto y su aporte. */
export function profileMatch(e: ProfileEntry, tournaments: Map<string, TournamentRef>, teams: Map<string, TeamRef>) {
  const tournament = tournaments.get(e.tournamentId);
  return {
    id: e.matchId,
    date: e.date,
    time: e.time,
    round: e.round,
    status: FINISHED,
    tournament: tournament ? { id: tournament.id, name: tournament.name } : null,
    homeTeam: teams.get(e.homeTeamId) ?? null,
    awayTeam: teams.get(e.awayTeamId) ?? null,
    homeScore: e.homeScore,
    awayScore: e.awayScore,
    playerTeamId: e.teamId,
    result: resultOf(e),
    stats: { goals: e.goals, assists: e.assists, yellowCards: e.yellowCards, redCards: e.redCards },
  };
}

export type PlayerProfile = ReturnType<typeof buildPlayerProfile>;
export type ProfileMatch = ReturnType<typeof profileMatch>;
