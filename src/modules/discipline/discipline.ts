/**
 * Cálculo disciplinario de un torneo, sin base de datos: a partir de las tarjetas capturadas
 * (PlayerMatchStats), el reglamento, el calendario y las decisiones humanas (Sanction).
 *
 * Las sanciones automáticas NO se guardan: se derivan cada vez. Así volver a guardar un
 * resultado no las duplica, corregir tarjetas las recalcula y mover el calendario no hace que
 * una sanción se cumpla dos veces. Cada una tiene una clave estable (`RED-…`, `ACC-…`) a la que
 * se enlazan los ajustes del organizador.
 *
 * Orden de cumplimiento (determinista): fase → fecha → hora → jornada → id del partido. La fase
 * va primero porque es estructural (una eliminatoria siempre va después de su fase previa); el
 * resto desempata siempre igual aunque dos partidos compartan fecha. El momento de la captura
 * no interviene: un resultado capturado tarde ocupa el lugar de su partido, no el de la captura.
 * Al reprogramar, el partido toma su lugar según la nueva fecha.
 *
 * Fecha sin actualizar: un partido que se pospuso y volvió a programarse (o se capturó) con la
 * MISMA fecha que tenía al posponerse no tiene un lugar fiable en el orden. No cuenta ni reserva
 * hasta que se le ponga su fecha real, y se avisa (`staleMatchIds`).
 *
 * Las sanciones son del jugador dentro del torneo: se cumplen con los partidos del equipo con el
 * que esté en cada momento (TeamMembership). Tras un cambio de equipo, el nuevo cuenta solo desde
 * su incorporación y el anterior solo hasta su salida: nunca hay cumplimiento retroactivo.
 */
import { MatchStatus, SanctionCause, SanctionKind, SanctionStatus, SendOff, TournamentStatus } from '../../common/enums/index.js';
import type { DisciplineRules } from './schemas/discipline-rules.schema.js';

export interface DMatch {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  status: MatchStatus;
  date: string;
  time: string;
  round: number;
  phase: number;
  /** Pospuesto que conserva su fecha original (ver cabecera). */
  stale?: boolean;
}

/** Participación del jugador con un equipo en el torneo (TeamMembership). */
export interface DMembership {
  playerId: string;
  teamId: string;
  startDate: string;
  endDate: string | null;
  active: boolean;
}

/** Lugar en el orden de un partido (copia guardada en la sanción manual, por si se borra). */
export type DPosition = Pick<DMatch, 'phase' | 'date' | 'time' | 'round'>;

export interface DStat {
  matchId: string;
  playerId: string;
  teamId: string;
  played: boolean;
  yellowCards: number;
  redCards: number;
  /** undefined = captura sin clasificar (anterior al módulo). */
  sendOff?: SendOff | null;
}

/** Decisión humana persistida (ver Sanction). */
export interface DRecord {
  id: string;
  kind: SanctionKind;
  key: string | null;
  playerId: string;
  teamId: string;
  cause: SanctionCause;
  matchId: string;
  matches: number | null;
  reason: string | null;
  annulled: boolean;
  /** MANUAL: posición del partido de inicio al registrarla (si ese partido deja de existir). */
  start?: DPosition | null;
}

export interface SanctionView {
  /** Id de la manual o clave de la automática: identifica la sanción en la API. */
  ref: string;
  kind: SanctionKind;
  cause: SanctionCause;
  playerId: string;
  teamId: string;
  /** AUTO: partido que la originó. MANUAL: partido desde el que aplica. */
  matchId: string;
  /** Partidos de suspensión vigentes (con el ajuste, si lo hay). */
  matches: number;
  /** Lo que marca el reglamento (solo AUTO). */
  ruleMatches: number | null;
  adjusted: boolean;
  reason: string | null;
  served: number;
  remaining: number;
  status: SanctionStatus;
  /** Partidos que abarca: cumplidos, con incidencia y próximos reservados. */
  coveredMatchIds: string[];
  upcomingMatchIds: string[];
  /** Partidos en que jugó estando suspendido (no cuentan como cumplidos). */
  incidentMatchIds: string[];
  /** Partidos dentro de su alcance con la fecha sin actualizar (no cuentan hasta corregirla). */
  staleMatchIds: string[];
}

export interface PlayerDiscipline {
  playerId: string;
  teamId: string;
  /** Amarillas que cuentan para acumulación (sin las de una doble amarilla). */
  yellows: number;
  /** Amarillas acumuladas desde la última suspensión (en la fase actual si se reinicia). */
  towardNext: number;
  directReds: number;
  secondYellows: number;
  unclassified: number;
  remaining: number;
  suspended: boolean;
}

export interface DisciplineResult {
  sanctions: SanctionView[];
  /** Ajustes de sanciones automáticas que ya no se derivan (tras corregir tarjetas o reglas). */
  orphans: DRecord[];
  players: PlayerDiscipline[];
  /** Expulsiones de capturas anteriores sin clasificar: no generan sanción automática. */
  unclassified: { matchId: string; playerId: string; teamId: string; yellowCards: number; redCards: number }[];
  incidents: { ref: string; matchId: string; playerId: string; teamId: string }[];
  /** Pospuestos que volvieron a programarse o se capturaron con su fecha original. */
  staleMatchIds: string[];
}

export interface DisciplineInput {
  rules: DisciplineRules;
  tournamentStatus: TournamentStatus;
  matches: DMatch[];
  stats: DStat[];
  records: DRecord[];
  memberships?: DMembership[];
}

type Classified = { accumulate: number; sendOff: SendOff | null; unclassified: boolean };

/**
 * Qué significa una fila de tarjetas. Con `sendOff` explícito (capturas nuevas) no hay duda.
 * Sin él (capturas anteriores) solo una amarilla sin roja es inequívoca; roja o dos amarillas
 * quedan por clasificar: ni sancionan ni acumulan hasta que se vuelva a capturar el partido.
 */
export function classify(s: Pick<DStat, 'yellowCards' | 'redCards' | 'sendOff'>): Classified {
  if (s.sendOff === SendOff.SECOND_YELLOW) return { accumulate: 0, sendOff: SendOff.SECOND_YELLOW, unclassified: false };
  if (s.sendOff === SendOff.DIRECT) return { accumulate: Math.min(s.yellowCards, 1), sendOff: SendOff.DIRECT, unclassified: false };
  if (s.sendOff === null) return { accumulate: Math.min(s.yellowCards, 1), sendOff: null, unclassified: false };
  if (s.redCards > 0 || s.yellowCards > 1) return { accumulate: 0, sendOff: null, unclassified: true };
  return { accumulate: s.yellowCards, sendOff: null, unclassified: false };
}

/** Clave de orden de cumplimiento (ver cabecera). */
export function orderKey(m: DPosition & { id: string }) {
  return `${String(m.phase).padStart(3, '0')}|${m.date}|${m.time}|${String(m.round).padStart(4, '0')}|${m.id}`;
}

export const redKey = (matchId: string, playerId: string) => `RED-${matchId}-${playerId}`;
export const accumulationKey = (matchId: string, playerId: string) => `ACC-${matchId}-${playerId}`;

interface Derived {
  key: string;
  cause: SanctionCause;
  playerId: string;
  teamId: string;
  matchId: string;
  ruleMatches: number;
}

/** Sanciones que marca el reglamento con las tarjetas actuales. */
export function deriveAutomatic(rules: DisciplineRules, matches: DMatch[], stats: DStat[]): Derived[] {
  if (!rules.enabled) return [];
  const byId = new Map(matches.map((m) => [m.id, m]));
  const rows = stats
    .filter((s) => byId.has(s.matchId))
    .sort((a, b) => orderKey(byId.get(a.matchId)!).localeCompare(orderKey(byId.get(b.matchId)!)));
  const out: Derived[] = [];
  const counters = new Map<string, number>();
  for (const s of rows) {
    const c = classify(s);
    if (c.sendOff) {
      const ruleMatches = c.sendOff === SendOff.DIRECT ? rules.directRedMatches : rules.secondYellowMatches;
      if (ruleMatches > 0) {
        out.push({
          key: redKey(s.matchId, s.playerId),
          cause: c.sendOff === SendOff.DIRECT ? SanctionCause.DIRECT_RED : SanctionCause.SECOND_YELLOW,
          playerId: s.playerId,
          teamId: s.teamId,
          matchId: s.matchId,
          ruleMatches,
        });
      }
    }
    if (!c.accumulate || !rules.yellowsForSuspension || rules.accumulationMatches <= 0) continue;
    const scope = rules.resetAccumulationOnPhaseChange ? `${s.playerId}|${byId.get(s.matchId)!.phase}` : s.playerId;
    const count = (counters.get(scope) ?? 0) + c.accumulate;
    if (count >= rules.yellowsForSuspension) {
      out.push({
        key: accumulationKey(s.matchId, s.playerId),
        cause: SanctionCause.ACCUMULATION,
        playerId: s.playerId,
        teamId: s.teamId,
        matchId: s.matchId,
        ruleMatches: rules.accumulationMatches,
      });
      counters.set(scope, count - rules.yellowsForSuspension);
    } else counters.set(scope, count);
  }
  return out;
}

/**
 * Cumplimiento de una sanción: recorre los partidos de su equipo en orden, después del partido
 * que la originó (o desde el partido indicado, en las manuales). Cancelados y pospuestos no
 * cuentan ni reservan (un pospuesto vuelve a contar cuando se reprograma, en su nueva fecha); un
 * partido terminado cuenta si el jugador no jugó (si jugó, es incidencia y no cuenta); uno por
 * jugar (programado o en juego) queda reservado. Se detiene al completar la duración
 * entre cumplidos y reservados, así que nunca abarca más partidos de los necesarios.
 */
export function serve(
  sanction: { playerId: string; matches: number; inclusive: boolean },
  playerMatches: DMatch[],
  originKey: string,
  played: Set<string>,
) {
  let served = 0;
  let reserved = 0;
  const covered: string[] = [];
  const upcoming: string[] = [];
  const incidents: string[] = [];
  const stale: string[] = [];
  for (const m of playerMatches) {
    const k = orderKey(m);
    if (sanction.inclusive ? k < originKey : k <= originKey) continue;
    if (served + reserved >= sanction.matches) break;
    if (m.status === MatchStatus.CANCELLED || m.status === MatchStatus.POSTPONED) continue;
    if (m.stale) {
      stale.push(m.id);
      continue;
    }
    covered.push(m.id);
    if (m.status === MatchStatus.FINISHED) {
      if (played.has(`${m.id}|${sanction.playerId}`)) incidents.push(m.id);
      else served++;
    } else {
      reserved++;
      upcoming.push(m.id);
    }
  }
  return { served, covered, upcoming, incidents, stale };
}

/**
 * Periodos del jugador con cada equipo en el torneo. El primero no tiene inicio (las capturas
 * atrasadas registran al jugador después de sus partidos); tras un cambio de equipo, el nuevo
 * empieza en su fecha de alta. Uno cerrado termina en su fecha de baja.
 */
export function periodsOf(memberships: DMembership[]) {
  const sorted = [...memberships].sort((a, b) => a.startDate.localeCompare(b.startDate) || Number(a.active) - Number(b.active));
  return sorted.map((m, i) => ({ teamId: m.teamId, from: i === 0 ? '' : m.startDate, to: m.active || !m.endDate ? '9999-12-31' : m.endDate }));
}

/** Partidos (en orden) que el jugador puede cumplir: los de su equipo en cada momento. */
export function matchesOfPlayer(ordered: DMatch[], memberships: DMembership[], fallbackTeamId: string) {
  const periods = memberships.length ? periodsOf(memberships) : [{ teamId: fallbackTeamId, from: '', to: '9999-12-31' }];
  return ordered.filter((m) => periods.some((p) => (p.teamId === m.homeTeamId || p.teamId === m.awayTeamId) && p.from <= m.date && m.date <= p.to));
}

export function computeDiscipline(input: DisciplineInput): DisciplineResult {
  const { rules, matches, stats, records } = input;
  const byId = new Map(matches.map((m) => [m.id, m]));
  const ordered = [...matches].sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
  const membershipsOf = new Map<string, DMembership[]>();
  for (const m of input.memberships ?? []) {
    if (!membershipsOf.has(m.playerId)) membershipsOf.set(m.playerId, []);
    membershipsOf.get(m.playerId)!.push(m);
  }
  const played = new Set(stats.filter((s) => s.played && byId.has(s.matchId)).map((s) => `${s.matchId}|${s.playerId}`));

  const derived = deriveAutomatic(rules, matches, stats);
  const derivedKeys = new Set(derived.map((d) => d.key));
  const overrides = new Map(records.filter((r) => r.kind === SanctionKind.AUTO && r.key).map((r) => [r.key!, r]));

  const base = [
    ...derived.map((d) => {
      const o = overrides.get(d.key);
      return {
        ref: d.key,
        kind: SanctionKind.AUTO,
        cause: d.cause,
        playerId: d.playerId,
        teamId: d.teamId,
        matchId: d.matchId,
        matches: o?.matches ?? d.ruleMatches,
        ruleMatches: d.ruleMatches,
        adjusted: !!o && (o.matches !== null || o.annulled),
        reason: o?.reason ?? null,
        annulled: o?.annulled ?? false,
        inclusive: false,
        startKey: null as string | null,
      };
    }),
    ...records
      // Si su partido de inicio se borró (p. ej. al regenerar el calendario), se usa la posición guardada.
      .filter((r) => r.kind === SanctionKind.MANUAL && (byId.has(r.matchId) || r.start))
      .map((r) => ({
        ref: r.id,
        kind: SanctionKind.MANUAL,
        cause: SanctionCause.MANUAL,
        playerId: r.playerId,
        teamId: r.teamId,
        matchId: r.matchId,
        matches: r.matches ?? 1,
        ruleMatches: null,
        adjusted: false,
        reason: r.reason,
        annulled: r.annulled,
        inclusive: true,
        startKey: byId.has(r.matchId) ? null : orderKey({ ...r.start!, id: '' }),
      })),
  ];

  const finished = input.tournamentStatus === TournamentStatus.FINISHED;
  const sanctions: SanctionView[] = base.map(({ annulled, inclusive, startKey, ...s }) => {
    const own = matchesOfPlayer(ordered, membershipsOf.get(s.playerId) ?? [], s.teamId);
    const r = serve({ ...s, inclusive }, own, startKey ?? orderKey(byId.get(s.matchId)!), played);
    const remaining = Math.max(0, s.matches - r.served);
    const status = annulled
      ? SanctionStatus.ANNULLED
      : remaining === 0
        ? SanctionStatus.SERVED
        : !finished && r.upcoming.length
          ? SanctionStatus.ACTIVE
          : SanctionStatus.PENDING;
    return {
      ...s,
      served: r.served,
      remaining: annulled ? 0 : remaining,
      status,
      coveredMatchIds: annulled ? [] : r.covered,
      upcomingMatchIds: annulled ? [] : r.upcoming,
      incidentMatchIds: annulled ? [] : r.incidents,
      staleMatchIds: annulled ? [] : r.stale,
    };
  });

  const incidents = sanctions.flatMap((s) => s.incidentMatchIds.map((matchId) => ({ ref: s.ref, matchId, playerId: s.playerId, teamId: s.teamId })));

  // Resumen por jugador (equipo = el de su última tarjeta o sanción).
  const players = new Map<string, PlayerDiscipline>();
  const lastPhase = ordered.at(-1)?.phase ?? 0;
  const counters = new Map<string, { phase: number; count: number }>();
  const unclassified: DisciplineResult['unclassified'] = [];
  const statRows = stats.filter((s) => byId.has(s.matchId)).sort((a, b) => orderKey(byId.get(a.matchId)!).localeCompare(orderKey(byId.get(b.matchId)!)));
  const row = (playerId: string, teamId: string) => {
    let p = players.get(playerId);
    if (!p) {
      p = { playerId, teamId, yellows: 0, towardNext: 0, directReds: 0, secondYellows: 0, unclassified: 0, remaining: 0, suspended: false };
      players.set(playerId, p);
    }
    p.teamId = teamId;
    return p;
  };
  for (const s of statRows) {
    if (!s.yellowCards && !s.redCards) continue;
    const c = classify(s);
    const p = row(s.playerId, s.teamId);
    p.yellows += c.accumulate;
    if (c.sendOff === SendOff.DIRECT) p.directReds++;
    if (c.sendOff === SendOff.SECOND_YELLOW) p.secondYellows++;
    if (c.unclassified) {
      p.unclassified++;
      unclassified.push({ matchId: s.matchId, playerId: s.playerId, teamId: s.teamId, yellowCards: s.yellowCards, redCards: s.redCards });
    }
    if (c.accumulate && rules.yellowsForSuspension) {
      const phase = byId.get(s.matchId)!.phase;
      const prev = counters.get(s.playerId);
      const reset = rules.resetAccumulationOnPhaseChange && prev && prev.phase !== phase;
      const count = (reset || !prev ? 0 : prev.count) + c.accumulate;
      counters.set(s.playerId, { phase, count: count % rules.yellowsForSuspension });
    }
  }
  for (const [playerId, c] of counters) {
    const p = players.get(playerId)!;
    p.towardNext = rules.resetAccumulationOnPhaseChange && c.phase !== lastPhase ? 0 : c.count;
  }
  for (const s of sanctions) {
    if (s.status !== SanctionStatus.ACTIVE && s.status !== SanctionStatus.PENDING) continue;
    const p = row(s.playerId, s.teamId);
    p.remaining += s.remaining;
    if (s.status === SanctionStatus.ACTIVE) p.suspended = true;
  }

  return {
    sanctions,
    orphans: records.filter((r) => r.kind === SanctionKind.AUTO && r.key && !derivedKeys.has(r.key)),
    players: [...players.values()],
    unclassified,
    incidents,
    staleMatchIds: matches.filter((m) => m.stale && m.status !== MatchStatus.POSTPONED && m.status !== MatchStatus.CANCELLED).map((m) => m.id),
  };
}

/** Jugadores suspendidos para un partido: los que alguna sanción vigente abarca. */
export function suspendedIn(result: DisciplineResult, matchId: string) {
  return result.sanctions.filter((s) => s.status !== SanctionStatus.ANNULLED && s.coveredMatchIds.includes(matchId));
}
