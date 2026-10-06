/**
 * Lecturas de carrera derivadas SOLO de los partidos oficiales del jugador (PlayerMatchStats
 * played=true de un Match FINISHED): por año, por equipo, hitos, récords y mejores actuaciones.
 * Funciones puras y deterministas; nada se guarda ni se captura a mano.
 *
 * - Año = año natural de `Match.date` (no existen "temporadas" en el modelo).
 * - Equipo = `PlayerMatchStats.teamId`: el equipo con el que jugó ESE partido (no las memberships).
 * - Orden cronológico: fecha, hora, id del partido.
 * - Mejores actuaciones: goles ↓, asistencias ↓, fecha ↓ (más reciente), id. Solo partidos con G+A > 0.
 * - Doblete = exactamente 2 goles; hat-trick = 3 o más.
 */
import type { TeamRef } from '../../common/utils/public.js';
import type { ProfileEntry, StatLine } from './player-profile.js';

export const GOAL_MARKS = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500];
export const MATCH_MARKS = [25, 50, 100, 150, 200, 250, 300, 400, 500];
export const BEST_PERFORMANCES = 5;

export type MilestoneType = 'FIRST_MATCH' | 'FIRST_GOAL' | 'FIRST_ASSIST' | 'GOALS' | 'MATCHES' | 'FIRST_BRACE' | 'FIRST_HAT_TRICK';

const chrono = (a: ProfileEntry, b: ProfileEntry) => `${a.date}${a.time}${a.matchId}`.localeCompare(`${b.date}${b.time}${b.matchId}`);

function line(entries: ProfileEntry[]): StatLine {
  return entries.reduce(
    (l, e) => ({
      appearances: l.appearances + 1,
      goals: l.goals + e.goals,
      assists: l.assists + e.assists,
      yellowCards: l.yellowCards + e.yellowCards,
      redCards: l.redCards + e.redCards,
    }),
    { appearances: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0 },
  );
}

function groupBy<K>(entries: ProfileEntry[], key: (e: ProfileEntry) => K) {
  const map = new Map<K, ProfileEntry[]>();
  for (const e of entries) map.set(key(e), [...(map.get(key(e)) ?? []), e]);
  return map;
}

/** Por año natural del partido, más reciente primero. */
export function statsByYear(entries: ProfileEntry[]) {
  return [...groupBy(entries, (e) => e.date.slice(0, 4)).entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, list]) => ({ year, stats: line(list), competitions: new Set(list.map((e) => e.tournamentId)).size }));
}

/** Por equipo representado en cada partido; más partidos primero, luego el más reciente. */
export function statsByTeam(entries: ProfileEntry[], teams: Map<string, TeamRef>) {
  return [...groupBy(entries, (e) => e.teamId).entries()]
    .map(([teamId, list]) => {
      const dates = list.map((e) => e.date).sort();
      return {
        team: teams.get(teamId) ?? null,
        stats: line(list),
        competitions: new Set(list.map((e) => e.tournamentId)).size,
        firstDate: dates[0],
        lastDate: dates.at(-1)!,
      };
    })
    .sort((a, b) => b.stats.appearances - a.stats.appearances || b.lastDate.localeCompare(a.lastDate));
}

/** Hitos en orden cronológico (el más reciente al final). `value` = la marca (gol #25, partido #50). */
export function milestonesOf(entries: ProfileEntry[]): { type: MilestoneType; value: number | null; entry: ProfileEntry }[] {
  const out: { type: MilestoneType; value: number | null; entry: ProfileEntry }[] = [];
  let goals = 0;
  let firstAssist = false;
  let firstBrace = false;
  let firstHatTrick = false;
  [...entries].sort(chrono).forEach((e, i) => {
    const played = i + 1;
    if (played === 1) out.push({ type: 'FIRST_MATCH', value: null, entry: e });
    if (MATCH_MARKS.includes(played)) out.push({ type: 'MATCHES', value: played, entry: e });
    if (e.goals > 0 && goals === 0) out.push({ type: 'FIRST_GOAL', value: null, entry: e });
    for (const mark of GOAL_MARKS) if (goals < mark && goals + e.goals >= mark) out.push({ type: 'GOALS', value: mark, entry: e });
    goals += e.goals;
    if (e.assists > 0 && !firstAssist) {
      firstAssist = true;
      out.push({ type: 'FIRST_ASSIST', value: null, entry: e });
    }
    if (e.goals >= 2 && !firstBrace) {
      firstBrace = true;
      out.push({ type: 'FIRST_BRACE', value: null, entry: e });
    }
    if (e.goals >= 3 && !firstHatTrick) {
      firstHatTrick = true;
      out.push({ type: 'FIRST_HAT_TRICK', value: null, entry: e });
    }
  });
  return out;
}

/** Récords personales; cada uno null si no hay dato que lo sostenga. */
export function recordsOf(entries: ProfileEntry[]) {
  const ordered = [...entries].sort(chrono);
  // A igualdad, el primero en lograrlo (orden cronológico estable).
  const maxBy = (pick: (e: ProfileEntry) => number) => {
    let best: ProfileEntry | null = null;
    for (const e of ordered) if (pick(e) > 0 && (!best || pick(e) > pick(best))) best = e;
    return best ? { value: pick(best), entry: best } : null;
  };
  let streak = { value: 0, from: '', to: '' };
  let run = 0;
  let start = '';
  for (const e of ordered) {
    if (e.goals > 0) {
      if (run === 0) start = e.date;
      run++;
      if (run > streak.value) streak = { value: run, from: start, to: e.date };
    } else run = 0;
  }
  const years = statsByYear(entries);
  const busiest = years.reduce<(typeof years)[number] | null>((b, y) => (!b || y.stats.appearances > b.stats.appearances ? y : b), null);
  return {
    mostGoalsInMatch: maxBy((e) => e.goals),
    mostAssistsInMatch: maxBy((e) => e.assists),
    longestScoringStreak: streak.value >= 2 ? streak : null,
    mostMatchesInYear: busiest ? { value: busiest.stats.appearances, year: busiest.year } : null,
    hatTricks: entries.filter((e) => e.goals >= 3).length,
    braces: entries.filter((e) => e.goals === 2).length,
  };
}

/** Mejores actuaciones por contribución objetiva (ver cabecera). */
export function bestPerformances(entries: ProfileEntry[], limit = BEST_PERFORMANCES) {
  return entries
    .filter((e) => e.goals + e.assists > 0)
    .sort(
      (a, b) =>
        b.goals - a.goals ||
        b.assists - a.assists ||
        `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`) ||
        a.matchId.localeCompare(b.matchId),
    )
    .slice(0, limit);
}

// ─── Portero ────────────────────────────────────────────────────────────────
/**
 * Lectura de PORTERO (posición GOALKEEPER). Sin datos de minutos ni atajadas: "goles recibidos" son
 * los que recibió su equipo en los partidos oficiales que jugó, y "portería en cero" un partido
 * suyo en que su equipo no recibió gol.
 */
export const CLEAN_SHEET_MARKS = [5, 10, 25, 50, 75, 100, 150, 200];
export const KEEPER_BEST = 5;

export const concededIn = (e: ProfileEntry) => (e.teamId === e.homeTeamId ? e.awayScore : e.homeScore);

function keeperLine(entries: ProfileEntry[]) {
  const conceded = entries.reduce((n, e) => n + concededIn(e), 0);
  const cleanSheets = entries.filter((e) => concededIn(e) === 0).length;
  const n = entries.length;
  return {
    appearances: n,
    conceded,
    cleanSheets,
    concededPerMatch: n ? Math.round((conceded / n) * 100) / 100 : null,
    cleanSheetRate: n ? Math.round((cleanSheets / n) * 100) : null,
  };
}

export function goalkeepingOf(entries: ProfileEntry[], teams: Map<string, TeamRef>) {
  const ordered = [...entries].sort(chrono);
  let streak = { value: 0, from: '', to: '' };
  let run = 0;
  let start = '';
  let clean = 0;
  const milestones: { type: 'FIRST_CLEAN_SHEET' | 'CLEAN_SHEETS'; value: number | null; entry: ProfileEntry }[] = [];
  for (const e of ordered) {
    if (concededIn(e) === 0) {
      if (run === 0) start = e.date;
      run++;
      if (run > streak.value) streak = { value: run, from: start, to: e.date };
      clean++;
      if (clean === 1) milestones.push({ type: 'FIRST_CLEAN_SHEET', value: null, entry: e });
      if (CLEAN_SHEET_MARKS.includes(clean)) milestones.push({ type: 'CLEAN_SHEETS', value: clean, entry: e });
    } else run = 0;
  }
  const own = (e: ProfileEntry) => (e.teamId === e.homeTeamId ? e.homeScore : e.awayScore);
  return {
    career: keeperLine(entries),
    longestCleanSheetStreak: streak.value >= 2 ? streak : null,
    byYear: [...groupBy(entries, (e) => e.date.slice(0, 4)).entries()].sort(([a], [b]) => b.localeCompare(a)).map(([year, list]) => ({ year, ...keeperLine(list) })),
    byTeam: [...groupBy(entries, (e) => e.teamId).entries()]
      .map(([teamId, list]) => ({ team: teams.get(teamId) ?? null, ...keeperLine(list) }))
      .sort((a, b) => b.appearances - a.appearances),
    byTournament: [...groupBy(entries, (e) => e.tournamentId).entries()].map(([tournamentId, list]) => ({ tournamentId, ...keeperLine(list) })),
    milestones,
    /** Porterías en cero: victorias primero, luego la más reciente. */
    best: entries
      .filter((e) => concededIn(e) === 0)
      .sort((a, b) => Number(own(b) > 0) - Number(own(a) > 0) || `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`) || a.matchId.localeCompare(b.matchId))
      .slice(0, KEEPER_BEST),
  };
}
