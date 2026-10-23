/**
 * 6B — búsqueda de fecha, hora y cancha para partidos ya definidos por el formato, sin base de datos.
 * Los cruces y las jornadas los decide el planificador de siempre (`competition/planner.ts`); aquí
 * solo se les busca un horario que cumpla las restricciones obligatorias de 6A (`evaluate`), sin
 * chocar en la cancha (margen de la sede) ni poner a un equipo en dos partidos a la vez.
 *
 * Algoritmo (voraz con reinicios, determinista):
 * - Jornada por jornada, en orden. Cada jornada empieza el día siguiente al último partido que la
 *   anterior jugó dentro de su ventana y, idealmente, en su fecha de siempre (inicio + n × días
 *   entre jornadas). Su ventana es de `daysBetweenRounds` días; si un partido no cabe, se busca en
 *   los días siguientes, hasta el fin del periodo: queda como partido pendiente, sin retrasar al
 *   resto del calendario. Por equipo el orden se respeta siempre: nadie juega un partido antes de
 *   terminar el de su jornada anterior.
 * - Dentro de la jornada, primero el partido con menos horarios posibles; se elige el horario con
 *   menor costo (ver `cost`). Se prueban hasta `attempts` órdenes (el primero, por restricción; los
 *   demás, barajados con semilla fija) y se queda el mejor: menos partidos sin horario, luego
 *   menor costo total. No garantiza el óptimo: es una heurística acotada.
 * - Límites: `maxEvaluations` horarios evaluados y `maxMs`. Al agotarse, lo que falta queda sin
 *   horario con el motivo SEARCH_LIMIT (no se inventa un horario).
 */
import { ConflictException } from '@nestjs/common';
import { addDays as addDaysRaw, clockOf, minutesOf as minutesOfRaw, overlaps } from '../venues/occupancy.js';
import { evaluate, toMinutes, weekdayOf, type Booked, type EvaluationContext, type Proposal, type Violation } from './scheduling-rules.js';

export interface Fixture {
  key: string;
  round: number;
  homeTeamId: string;
  awayTeamId: string;
}

export interface CandidateField {
  id: string;
  label: string;
  /** Margen de la sede (cambio entre partidos). */
  buffer: number;
}

export interface AutoOptions {
  /** Periodo de búsqueda, inclusive. */
  from: string;
  to: string;
  /** Días de la semana de la propuesta (0 = domingo). Vacío = cualquiera. */
  days: number[];
  firstKickoff: string;
  lastKickoff: string;
  /** Minutos entre inicios posibles. */
  step: number;
  daysBetweenRounds: number;
  /** Canchas a usar. Vacío = sin cancha (como el generador de siempre). */
  fields: CandidateField[];
  /** Sin cancha: partidos del torneo a la vez. */
  parallel: number;
  /** Partidos que ya ocupan las canchas (de cualquier torneo, incluido este si no se reemplaza). */
  fieldBookings: Booked[];
  /** Hora preferida (por defecto la primera): cuesta alejarse de ella. */
  preferredTime?: string;
  /** Orden de jornadas por equipo (generación). La reprogramación no lo exige: un pendiente puede ir después. */
  teamOrder?: boolean;
  attempts?: number;
  maxEvaluations?: number;
  maxMs?: number;
  now?: () => number;
}

export type ReasonCode = Violation['code'] | 'TEAM_OVERLAP' | 'TEAM_ORDER' | 'BRACKET_ORDER' | 'FIELD_BUSY' | 'CAPACITY' | 'NO_SLOTS' | 'SEARCH_LIMIT';

export interface Reason {
  code: ReasonCode;
  /** Horarios descartados por este motivo. */
  count: number;
  message: string;
  teamId: string | null;
  fieldId: string | null;
}

export interface Placement {
  key: string;
  round: number;
  homeTeamId: string;
  awayTeamId: string;
  date: string;
  time: string;
  fieldId: string | null;
  warnings: Violation[];
}

export interface Unplaced {
  key: string;
  round: number;
  homeTeamId: string;
  awayTeamId: string;
  /** Motivos más frecuentes primero. */
  reasons: Reason[];
}

export interface AutoMetrics {
  placed: number;
  unplaced: number;
  /** Partidos con alguna preferencia incumplida. */
  withWarnings: number;
  /** Jornadas que empiezan después de su fecha ideal, y días de retraso sumados. */
  lateRounds: number;
  lateDays: number;
  /** Descanso más corto entre dos partidos de un mismo equipo en la propuesta (horas; null = nadie juega dos). */
  shortestRestHours: number | null;
  /** Mayor espera de un equipo entre dos partidos (días). */
  longestGapDays: number | null;
  firstDate: string | null;
  lastDate: string | null;
  cost: number;
  evaluations: number;
  attempts: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface AutoResult {
  placements: Placement[];
  unplaced: Unplaced[];
  metrics: AutoMetrics;
}

export const AUTO_LIMITS = { attempts: 6, maxEvaluations: 250_000, maxMs: 8_000 };

/** Pesos del costo de un horario (menor es mejor). Ver docs/scheduling-6b.md § Criterios. */
export const COST = { warning: 1000, dayLate: 20, shortRestPerDay: 15, longGapPerDay: 5, minutesFromPreferred: 1 / 15 };

interface Candidate {
  date: string;
  time: string;
  fieldId: string | null;
  order: number;
}

class Budget {
  evaluations = 0;
  private readonly started: number;
  constructor(
    private readonly max: number,
    private readonly maxMs: number,
    private readonly now: () => number,
  ) {
    this.started = now();
  }
  get exhausted() {
    return this.evaluations >= this.max || this.now() - this.started > this.maxMs;
  }
  get elapsed() {
    return this.now() - this.started;
  }
}

export function autoSchedule(fixtures: Fixture[], ctx: EvaluationContext, opts: AutoOptions): AutoResult {
  const now = opts.now ?? Date.now;
  const budget = new Budget(opts.maxEvaluations ?? AUTO_LIMITS.maxEvaluations, opts.maxMs ?? AUTO_LIMITS.maxMs, now);
  const attempts = Math.max(1, opts.attempts ?? AUTO_LIMITS.attempts);
  const times = timesOf(opts);
  const preferred = toMinutes(opts.preferredTime ?? opts.firstKickoff);
  const rounds = [...new Set(fixtures.map((f) => f.round))].sort((a, b) => a - b);

  const placements: Placement[] = [];
  const unplaced: Unplaced[] = [];
  // Partidos del torneo que ya reservan (los existentes y los que se van colocando).
  const state = new State(ctx, opts);
  let prevLast: string | null = null;
  let lateRounds = 0;
  let lateDays = 0;
  let cost = 0;
  let usedAttempts = 0;

  rounds.forEach((round, index) => {
    const list = fixtures.filter((f) => f.round === round);
    const anchor = addDays(opts.from, index * opts.daysBetweenRounds);
    const floor = prevLast && addDays(prevLast, 1) > opts.from ? addDays(prevLast, 1) : opts.from;
    const ideal = anchor > floor ? anchor : floor;
    const windowEnd = minDate(opts.to, addDays(ideal, Math.max(1, opts.daysBetweenRounds) - 1));
    if (ideal > opts.to || budget.exhausted) {
      for (const f of list) unplaced.push(unplacedOf(f, [budget.exhausted ? limitReason() : noSlots(opts)]));
      return;
    }

    let best: RoundOutcome | null = null;
    const orders = orderings(list, round, attempts, (f) => state.feasibleCount(f, ideal, windowEnd, times, budget));
    for (const order of orders) {
      if (budget.exhausted && best) break;
      usedAttempts++;
      const outcome = placeRound(order, state.fork(), { ideal, windowEnd, anchor, times, preferred, budget, opts, ctx });
      if (!best || outcome.unplaced.length < best.unplaced.length || (outcome.unplaced.length === best.unplaced.length && outcome.cost < best.cost)) best = outcome;
      // Perfecto: todo colocado, sin preferencias incumplidas ni retraso.
      if (!outcome.unplaced.length && outcome.placed.every((p) => !p.warnings.length && p.date <= windowEnd)) break;
    }
    const chosen = best!;
    state.adopt(chosen.state);
    placements.push(...chosen.placed);
    unplaced.push(...chosen.unplaced);
    cost += chosen.cost;
    if (chosen.placed.length) {
      const dates = chosen.placed.map((p) => p.date).sort();
      // Los partidos que se fueron más allá de la ventana no arrastran a la jornada siguiente.
      const inWindow = dates.filter((d) => d <= windowEnd);
      prevLast = inWindow.length ? inWindow[inWindow.length - 1] : dates[dates.length - 1];
      const late = daysBetween(anchor, dates[0]);
      if (late > 0) {
        lateRounds++;
        lateDays += late;
      }
    }
  });

  placements.sort((a, b) => a.round - b.round || a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || (a.fieldId ?? '').localeCompare(b.fieldId ?? ''));
  return {
    placements,
    unplaced,
    metrics: { ...restMetrics(placements, ctx.duration), placed: placements.length, unplaced: unplaced.length, withWarnings: placements.filter((p) => p.warnings.length).length, lateRounds, lateDays, cost: Math.round(cost * 100) / 100, evaluations: budget.evaluations, attempts: usedAttempts, elapsedMs: budget.elapsed, truncated: unplaced.some((u) => u.reasons.some((r) => r.code === 'SEARCH_LIMIT')) },
  };
}

// ─── Una jornada ─────────────────────────────────────────────────────────────

interface RoundOutcome {
  state: State;
  placed: Placement[];
  unplaced: Unplaced[];
  cost: number;
}

function placeRound(
  order: Fixture[],
  state: State,
  p: { ideal: string; windowEnd: string; anchor: string; times: string[]; preferred: number; budget: Budget; opts: AutoOptions; ctx: EvaluationContext },
): RoundOutcome {
  const placed: Placement[] = [];
  const unplaced: Unplaced[] = [];
  let cost = 0;
  for (const f of order) {
    const reasons = new Reasons();
    const best: { found: { c: Candidate; warnings: Violation[]; cost: number } | null } = { found: null };
    const search = (dates: string[]) => {
      for (const d of dates) {
        for (const c of state.candidates(d, p.times)) {
          if (p.budget.exhausted) return;
          p.budget.evaluations++;
          const check = state.check(f, c, reasons);
          if (!check) continue;
          const total = candidateCost(state, f, c, check.warnings, p);
          const f0 = best.found;
          if (!f0 || total < f0.cost || (total === f0.cost && c.order < f0.c.order)) best.found = { c, warnings: check.warnings, cost: total };
        }
      }
    };
    // Primero toda la ventana de la jornada; si no cabe, día por día hasta el fin del periodo.
    search(datesBetween(p.ideal, p.windowEnd));
    for (let date = addDays(p.windowEnd, 1); !best.found && date <= p.opts.to && !p.budget.exhausted; date = addDays(date, 1)) search([date]);
    const found = best.found;
    if (found) {
      state.place(f, found.c);
      cost += found.cost;
      placed.push({ key: f.key, round: f.round, homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId, date: found.c.date, time: found.c.time, fieldId: found.c.fieldId, warnings: found.warnings });
    } else {
      unplaced.push(unplacedOf(f, p.budget.exhausted ? [limitReason(), ...reasons.list()] : reasons.list().length ? reasons.list() : [noSlots(p.opts)]));
    }
  }
  return { state, placed, unplaced, cost };
}

function candidateCost(state: State, f: Fixture, c: Candidate, warnings: Violation[], p: { anchor: string; preferred: number; opts: AutoOptions; ctx: EvaluationContext }) {
  const start = minutesOf(c.date, c.time);
  let total = warnings.length * COST.warning + Math.max(0, daysBetween(p.anchor, c.date)) * COST.dayLate;
  const target = Math.max(1, p.opts.daysBetweenRounds);
  for (const team of [f.homeTeamId, f.awayTeamId]) {
    const prevEnd = state.previousEnd(team, start);
    if (prevEnd === null) continue;
    const restDays = (start - prevEnd) / 1440;
    total += Math.max(0, target - restDays) * COST.shortRestPerDay + Math.max(0, restDays - 2 * target) * COST.longGapPerDay;
  }
  return total + Math.abs(toMinutes(c.time) - p.preferred) * COST.minutesFromPreferred;
}

// ─── Estado: lo ya reservado ─────────────────────────────────────────────────

class State {
  /** Partidos del torneo por fecha (existentes + colocados). */
  private byDate: Map<string, Booked[]>;
  /** Ocupación de cada cancha (todos los torneos) por fecha. */
  private fieldByDate: Map<string, Booked[]>;
  private placedCount: number;
  /** Fin del último partido colocado de cada equipo (orden de sus jornadas). */
  private lastEnd: Map<string, number>;
  /** Partidos cercanos por fecha y radio; se invalida al colocar uno. */
  private near = new Map<string, Booked[]>();

  constructor(
    private readonly ctx: EvaluationContext,
    private readonly opts: AutoOptions,
    seed?: { byDate: Map<string, Booked[]>; fieldByDate: Map<string, Booked[]>; placedCount: number; lastEnd: Map<string, number> },
  ) {
    if (seed) {
      this.byDate = seed.byDate;
      this.fieldByDate = seed.fieldByDate;
      this.placedCount = seed.placedCount;
      this.lastEnd = seed.lastEnd;
      return;
    }
    this.lastEnd = new Map();
    this.byDate = new Map();
    for (const b of ctx.tournamentMatches) push(this.byDate, b.date, b);
    this.fieldByDate = new Map();
    for (const b of opts.fieldBookings) push(this.fieldByDate, b.date, b);
    this.placedCount = 0;
  }

  fork() {
    const copy = (m: Map<string, Booked[]>) => new Map([...m].map(([k, v]) => [k, [...v]]));
    return new State(this.ctx, this.opts, { byDate: copy(this.byDate), fieldByDate: copy(this.fieldByDate), placedCount: this.placedCount, lastEnd: new Map(this.lastEnd) });
  }

  adopt(other: State) {
    this.byDate = other.byDate;
    this.fieldByDate = other.fieldByDate;
    this.placedCount = other.placedCount;
    this.lastEnd = other.lastEnd;
    this.near.clear();
  }

  candidates(date: string, times: string[]): Candidate[] {
    if (this.opts.days.length && !this.opts.days.includes(weekdayOf(date))) return [];
    const out: Candidate[] = [];
    let order = 0;
    for (const time of times) {
      if (this.opts.fields.length) for (const field of this.opts.fields) out.push({ date, time, fieldId: field.id, order: order++ });
      else out.push({ date, time, fieldId: null, order: order++ });
    }
    return out;
  }

  /** Horarios posibles de un partido en la ventana, con lo reservado ahora (para ordenar). */
  feasibleCount(f: Fixture, from: string, to: string, times: string[], budget: Budget) {
    let n = 0;
    for (const d of datesBetween(from, to)) {
      for (const c of this.candidates(d, times)) {
        if (budget.exhausted) return n;
        budget.evaluations++;
        if (this.check(f, c, null)) n++;
      }
    }
    return n;
  }

  /** null = horario imposible (los motivos se acumulan en `reasons`); si no, sus avisos. */
  check(f: Fixture, c: Candidate, reasons: Reasons | null): { warnings: Violation[] } | null {
    const duration = this.ctx.duration;
    const slot = { date: c.date, time: c.time, duration };
    const start = minutesOf(c.date, c.time);
    const end = start + duration;
    const nearby = this.nearby(c.date, 15);
    let blocked = false;
    // Orden de cada equipo: su partido de una jornada anterior (si quedó pendiente) va primero.
    for (const team of this.opts.teamOrder === false ? [] : [f.homeTeamId, f.awayTeamId]) {
      const last = this.lastEnd.get(team);
      if (last !== undefined && start < last) {
        blocked = true;
        reasons?.add('TEAM_ORDER', `${this.ctx.teamNames.get(team) ?? 'Un equipo'} todavía no juega su partido de la jornada anterior`, team, null);
      }
    }
    // Un equipo no juega dos partidos a la vez.
    for (const team of [f.homeTeamId, f.awayTeamId]) {
      const clash = nearby.find((b) => (b.homeTeamId === team || b.awayTeamId === team) && minutesOf(b.date, b.time) < end && start < minutesOf(b.date, b.time) + b.duration);
      if (clash) {
        blocked = true;
        reasons?.add('TEAM_OVERLAP', `${this.ctx.teamNames.get(team) ?? 'Un equipo'} ya juega a esa hora`, team, null);
      }
    }
    if (c.fieldId) {
      const field = this.opts.fields.find((x) => x.id === c.fieldId)!;
      const busy = this.fieldNearby(c.date).some((b) => b.fieldId === c.fieldId && overlaps({ ...slot, buffer: field.buffer }, { date: b.date, time: b.time, duration: b.duration, buffer: field.buffer }));
      if (busy) {
        blocked = true;
        reasons?.add('FIELD_BUSY', `${field.label} está ocupada (con el margen de la sede)`, null, c.fieldId);
      }
    } else if (Number.isFinite(this.opts.parallel)) {
      const at = nearby.filter((b) => minutesOf(b.date, b.time) < end && start < minutesOf(b.date, b.time) + b.duration).length;
      if (at >= this.opts.parallel) {
        blocked = true;
        reasons?.add('CAPACITY', `Ya hay ${at} ${at === 1 ? 'partido' : 'partidos'} del torneo a esa hora (a la vez: ${this.opts.parallel})`, null, null);
      }
    }
    if (blocked) return null;
    const proposal: Proposal = { key: f.key, matchId: null, homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId, date: c.date, time: c.time, fieldId: c.fieldId, round: f.round };
    const evaluation = evaluate([proposal], {
      ...this.ctx,
      tournamentMatches: nearby,
      otherFieldMatches: c.fieldId ? this.fieldNearby(c.date).filter((b) => b.tournamentId !== this.ctx.tournamentId) : [],
    }).get(f.key)!;
    if (!evaluation.valid) {
      for (const e of evaluation.errors) reasons?.add(e.code, e.message, e.teamId, e.fieldId);
      return null;
    }
    return { warnings: evaluation.warnings };
  }

  place(f: Fixture, c: Candidate) {
    const b: Booked = { id: `new:${f.key}`, tournamentId: this.ctx.tournamentId, homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId, date: c.date, time: c.time, fieldId: c.fieldId, duration: this.ctx.duration };
    push(this.byDate, c.date, b);
    if (c.fieldId) push(this.fieldByDate, c.date, b);
    this.placedCount++;
    const end = minutesOf(c.date, c.time) + this.ctx.duration;
    for (const team of [f.homeTeamId, f.awayTeamId]) this.lastEnd.set(team, Math.max(this.lastEnd.get(team) ?? -Infinity, end));
    this.near.clear();
  }

  /** Fin del último partido del equipo que empieza antes de `start` (en los 30 días previos). */
  previousEnd(team: string, start: number): number | null {
    let best: number | null = null;
    for (const b of this.nearby(dateOfMinute(start), 30)) {
      if (b.homeTeamId !== team && b.awayTeamId !== team) continue;
      const s = minutesOf(b.date, b.time);
      if (s < start && (best === null || s + b.duration > best)) best = s + b.duration;
    }
    return best;
  }

  /** Inicio del siguiente partido del equipo que empieza después de `end` (en los 30 días siguientes). */
  nextStart(team: string, end: number): number | null {
    let best: number | null = null;
    for (const b of this.nearby(dateOfMinute(end), 30)) {
      if (b.homeTeamId !== team && b.awayTeamId !== team) continue;
      const s = minutesOf(b.date, b.time);
      if (s >= end && (best === null || s < best)) best = s;
    }
    return best;
  }

  /** Partidos del equipo en esa fecha (para no acumular). */
  sameDate(team: string, date: string) {
    return (this.byDate.get(date) ?? []).filter((b) => b.homeTeamId === team || b.awayTeamId === team).length;
  }

  private nearby(date: string, days: number) {
    const k = `${date}|${days}`;
    let out = this.near.get(k);
    if (!out) {
      out = [];
      for (let i = -days; i <= days; i++) out.push(...(this.byDate.get(addDays(date, i)) ?? []));
      this.near.set(k, out);
    }
    return out;
  }

  private fieldNearby(date: string) {
    const k = `F${date}`;
    let out = this.near.get(k);
    if (!out) {
      out = [];
      for (let i = -2; i <= 2; i++) out.push(...(this.fieldByDate.get(addDays(date, i)) ?? []));
      this.near.set(k, out);
    }
    return out;
  }
}

// ─── 6C: reprogramación parcial ──────────────────────────────────────────────

export interface RescheduleItem extends Fixture {
  matchId: string;
  /** Horario actual; null = nunca tuvo (por programar). */
  origin: { date: string; time: string; fieldId: string | null } | null;
  /** Eliminatoria: no antes del fin de los partidos que lo alimentan, ni terminando después del inicio de los que dependen de él (minutos absolutos). */
  notBefore?: number | null;
  notAfter?: number | null;
  /** false = su horario actual no se puede conservar (p. ej. está pospuesto): hay que darle otro. */
  keepable?: boolean;
}

export interface RescheduleOptions extends Omit<AutoOptions, 'daysBetweenRounds' | 'teamOrder'> {
  /** Conservar el horario actual si sigue siendo válido (por defecto sí). */
  keepValid: boolean;
  avoidDates: string[];
  avoidFieldIds: string[];
  /** Descanso de referencia entre partidos de un equipo (días). */
  restDays: number;
}

export interface ReschedulePlacement extends Placement {
  matchId: string;
  changed: boolean;
}

export interface RescheduleMetrics {
  kept: number;
  moved: number;
  unplaced: number;
  dateChanges: number;
  timeChanges: number;
  fieldChanges: number;
  withWarnings: number;
  cost: number;
  evaluations: number;
  attempts: number;
  elapsedMs: number;
  truncated: boolean;
}

/**
 * Prioridades de la reprogramación (menor costo = mejor). Ver docs/scheduling-6c.md § Optimización:
 * 1) obligatorias (filtro, nunca costo) · 2) conservar lo válido (primera pasada, costo 0) ·
 * 3) cambiar la fecha · 4) la cancha y la hora · 5) descansos · 6) acumulación · 7) preferencias.
 */
export const RESCHEDULE_COST = { dateChange: 200, perDay: 10, fieldChange: 30, per15min: 2, shortRestPerDay: 15, sameDay: 100, warning: 25 };

/**
 * Busca horario SOLO para los partidos elegidos; el resto del calendario queda fijo (es contexto).
 * Primera pasada: los que siguen siendo válidos donde están se quedan. Segunda: los demás, el más
 * restringido primero, con hasta `attempts` órdenes (el primero por restricción; los demás con
 * semilla fija). Heurística acotada: no garantiza el mínimo global de cambios.
 */
export function rescheduleSearch(items: RescheduleItem[], ctx: EvaluationContext, opts: RescheduleOptions): { placements: ReschedulePlacement[]; unplaced: (Unplaced & { matchId: string })[]; metrics: RescheduleMetrics } {
  const now = opts.now ?? Date.now;
  const budget = new Budget(opts.maxEvaluations ?? AUTO_LIMITS.maxEvaluations, opts.maxMs ?? AUTO_LIMITS.maxMs, now);
  const auto: AutoOptions = { ...opts, daysBetweenRounds: Math.max(1, opts.restDays), teamOrder: false };
  const fields = opts.fields.filter((f) => !opts.avoidFieldIds.includes(f.id));
  const searchOpts: AutoOptions = { ...auto, fields };
  const state = new State(ctx, searchOpts);
  const times = timesOf(opts);
  const dates = datesBetween(opts.from, opts.to).filter((d) => !opts.avoidDates.includes(d) && (!opts.days.length || opts.days.includes(weekdayOf(d))));
  const inBounds = (it: RescheduleItem, date: string, time: string) => {
    const start = minutesOf(date, time);
    return (it.notBefore == null || start >= it.notBefore) && (it.notAfter == null || start + ctx.duration <= it.notAfter);
  };
  // Sin cancha se puede conservar siempre; con cancha, si sigue entre las elegidas.
  const fieldAllowed = (fieldId: string | null) => (fieldId ? fields.some((f) => f.id === fieldId) : true);

  const placements: ReschedulePlacement[] = [];
  const asPlacement = (it: RescheduleItem, c: { date: string; time: string; fieldId: string | null }, warnings: Violation[]): ReschedulePlacement => ({
    key: it.key, matchId: it.matchId, round: it.round, homeTeamId: it.homeTeamId, awayTeamId: it.awayTeamId, date: c.date, time: c.time, fieldId: c.fieldId, warnings,
    changed: it.keepable === false || !it.origin || it.origin.date !== c.date || it.origin.time !== c.time || (it.origin.fieldId ?? null) !== (c.fieldId ?? null),
  });

  // 1) Conservar lo que sigue siendo válido (en orden cronológico, para que se vean entre sí).
  const pending: RescheduleItem[] = [];
  const sorted = [...items].sort((a, b) => (a.origin ? minutesOf(a.origin.date, a.origin.time) : Infinity) - (b.origin ? minutesOf(b.origin.date, b.origin.time) : Infinity) || a.key.localeCompare(b.key));
  for (const it of sorted) {
    const o = it.origin;
    // Se conserva si sigue valiendo y está dentro del periodo pedido (fuera de él, moverlo es lo pedido).
    const keepable = opts.keepValid && it.keepable !== false && o && o.date >= opts.from && o.date <= opts.to && !opts.avoidDates.includes(o.date) && fieldAllowed(o.fieldId) && inBounds(it, o.date, o.time);
    if (keepable) {
      budget.evaluations++;
      const ok = state.check(it, { date: o.date, time: o.time, fieldId: o.fieldId, order: 0 }, null);
      if (ok) {
        state.place(it, { date: o.date, time: o.time, fieldId: o.fieldId, order: 0 });
        placements.push(asPlacement(it, o, ok.warnings));
        continue;
      }
    }
    pending.push(it);
  }

  // 2) Buscar para el resto.
  const cost = (st: State, it: RescheduleItem, c: Candidate, warnings: Violation[]) => {
    const o = it.origin;
    const start = minutesOf(c.date, c.time);
    const end = start + ctx.duration;
    let total = warnings.length * RESCHEDULE_COST.warning;
    if (o) {
      const days = Math.abs(daysBetween(o.date, c.date));
      if (days) total += RESCHEDULE_COST.dateChange + days * RESCHEDULE_COST.perDay;
      if ((o.fieldId ?? null) !== (c.fieldId ?? null)) total += RESCHEDULE_COST.fieldChange;
      total += (Math.abs(toMinutes(c.time) - toMinutes(o.time)) / 15) * RESCHEDULE_COST.per15min;
    } else {
      total += daysBetween(opts.from, c.date) * RESCHEDULE_COST.perDay + (Math.abs(toMinutes(c.time) - toMinutes(opts.preferredTime ?? opts.firstKickoff)) / 15) * RESCHEDULE_COST.per15min;
    }
    for (const team of [it.homeTeamId, it.awayTeamId]) {
      const prev = st.previousEnd(team, start);
      const next = st.nextStart(team, end);
      for (const gap of [prev === null ? null : (start - prev) / 1440, next === null ? null : (next - end) / 1440]) {
        if (gap !== null) total += Math.max(0, opts.restDays - gap) * RESCHEDULE_COST.shortRestPerDay;
      }
      total += st.sameDate(team, c.date) * RESCHEDULE_COST.sameDay;
    }
    return total;
  };
  const attempts = Math.max(1, opts.attempts ?? 3);
  type Outcome = { state: State; placed: ReschedulePlacement[]; unplaced: (Unplaced & { matchId: string })[]; cost: number };
  let best: Outcome | null = null;
  let usedAttempts = 0;
  if (pending.length) {
    const counts = new Map<string, number>();
    for (const it of pending) {
      let n = 0;
      // Solo para ordenar: los horarios posibles cerca del original (±7 días), no en todo el periodo.
      const center = centerOf(it);
      const near = center ? ring(it, dates).filter((x) => Math.abs(daysBetween(center, x)) <= 7) : dates.slice(0, 14);
      for (const d of near) for (const c of state.candidates(d, times)) {
        if (budget.exhausted) break;
        if (!inBounds(it, c.date, c.time)) continue;
        budget.evaluations++;
        if (state.check(it, c, null)) n++;
      }
      counts.set(it.key, n);
    }
    const first = [...pending].sort((a, b) => counts.get(a.key)! - counts.get(b.key)! || a.key.localeCompare(b.key));
    const random = mulberry32(pending.length * 7919 + items.length);
    const orders = [first];
    for (let k = 1; k < attempts && first.length > 1; k++) {
      const copy = [...first];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      orders.push(copy);
    }
    for (const order of orders) {
      if (budget.exhausted && best) break;
      usedAttempts++;
      const st = state.fork();
      const out: Outcome = { state: st, placed: [], unplaced: [], cost: 0 };
      for (const it of order) {
        const reasons = new Reasons();
        let found: { c: Candidate; warnings: Violation[]; cost: number } | null = null;
        // Fechas de la más cercana a la más lejana. Poda exacta: cambiar de fecha cuesta al menos
        // dateChange + perDay × días; cuando eso ya supera lo encontrado, las siguientes no pueden ganar.
        for (const d of ring(it, dates)) {
          if (found && minDateCost(it.origin ? daysBetween(it.origin.date, d) : 0) + (it.origin ? 0 : daysBetween(opts.from, d) * RESCHEDULE_COST.perDay) > found.cost) break;
          for (const c of st.candidates(d, times)) {
            if (budget.exhausted) break;
            if (!inBounds(it, c.date, c.time)) {
              reasons.add('BRACKET_ORDER', 'En la eliminatoria debe jugarse después de los partidos que lo definen y antes de los que dependen de él', null, null);
              continue;
            }
            // Sin conservar lo válido, el horario actual no cuenta como opción (moverlo es lo pedido).
            if (!opts.keepValid && it.origin && it.origin.date === c.date && it.origin.time === c.time && (it.origin.fieldId ?? null) === (c.fieldId ?? null)) continue;
            budget.evaluations++;
            const ok = st.check(it, c, reasons);
            if (!ok) continue;
            const total = cost(st, it, c, ok.warnings);
            if (!found || total < found.cost || (total === found.cost && (c.date < found.c.date || (c.date === found.c.date && c.order < found.c.order)))) found = { c, warnings: ok.warnings, cost: total };
          }
        }
        if (found) {
          st.place(it, found.c);
          out.cost += found.cost;
          out.placed.push(asPlacement(it, found.c, found.warnings));
        } else {
          const list = reasons.list();
          out.unplaced.push({ ...unplacedOf(it, budget.exhausted ? [limitReason(), ...list] : list.length ? list : [{ ...noSlots(opts as unknown as AutoOptions), message: 'No hay días del periodo que se puedan usar (revisa las fechas, los días y las fechas a evitar)' }]), matchId: it.matchId });
        }
      }
      if (!best || out.unplaced.length < best.unplaced.length || (out.unplaced.length === best.unplaced.length && out.cost < best.cost)) best = out;
      if (!out.unplaced.length && out.placed.every((p) => !p.warnings.length)) break;
    }
  }
  const all = [...placements, ...(best?.placed ?? [])].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.key.localeCompare(b.key));
  const byKey = new Map(items.map((i) => [i.key, i]));
  const moved = all.filter((p) => p.changed);
  const origin = (p: ReschedulePlacement) => byKey.get(p.key)!.origin;
  return {
    placements: all,
    unplaced: best?.unplaced ?? [],
    metrics: {
      kept: all.length - moved.length,
      moved: moved.length,
      unplaced: best?.unplaced.length ?? 0,
      dateChanges: moved.filter((p) => !origin(p) || origin(p)!.date !== p.date).length,
      timeChanges: moved.filter((p) => origin(p) && origin(p)!.time !== p.time).length,
      fieldChanges: moved.filter((p) => origin(p) && (origin(p)!.fieldId ?? null) !== (p.fieldId ?? null)).length,
      withWarnings: all.filter((p) => p.warnings.length).length,
      cost: Math.round((best?.cost ?? 0) * 100) / 100,
      evaluations: budget.evaluations,
      attempts: usedAttempts,
      elapsedMs: budget.elapsed,
      truncated: (best?.unplaced ?? []).some((u) => u.reasons.some((r) => r.code === 'SEARCH_LIMIT')),
    },
  };
}

/** Centro de la búsqueda de un partido: su fecha actual o, si nunca tuvo, el inicio del periodo. */
const centerOf = (it: RescheduleItem) => it.origin?.date ?? null;
/** Fechas ordenadas por cercanía al centro (a igualdad, la anterior); sin centro, en orden. */
function ring(it: RescheduleItem, dates: string[]) {
  const c = centerOf(it);
  if (!c) return dates;
  return [...dates].sort((a, b) => Math.abs(daysBetween(c, a)) - Math.abs(daysBetween(c, b)) || a.localeCompare(b));
}
const minDateCost = (days: number) => (days ? RESCHEDULE_COST.dateChange + Math.abs(days) * RESCHEDULE_COST.perDay : 0);

// ─── Motivos ─────────────────────────────────────────────────────────────────

class Reasons {
  private map = new Map<string, Reason>();
  add(code: ReasonCode, message: string, teamId: string | null, fieldId: string | null) {
    const key = `${code}|${teamId ?? ''}|${fieldId ?? ''}`;
    const r = this.map.get(key);
    if (r) r.count++;
    else this.map.set(key, { code, count: 1, message, teamId, fieldId });
  }
  list() {
    return [...this.map.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, 5);
  }
}

const limitReason = (): Reason => ({ code: 'SEARCH_LIMIT', count: 0, message: 'Se alcanzó el límite de búsqueda antes de encontrarle horario: reduce el periodo o las canchas, o programa este partido a mano', teamId: null, fieldId: null });
const noSlots = (opts: AutoOptions): Reason => ({
  code: 'NO_SLOTS',
  count: 0,
  message: `No quedan días del periodo (hasta el ${opts.to}) para esta jornada: amplía la fecha final`,
  teamId: null,
  fieldId: null,
});
const unplacedOf = (f: Fixture, reasons: Reason[]): Unplaced => ({ key: f.key, round: f.round, homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId, reasons });

// ─── Utilidades ──────────────────────────────────────────────────────────────

// La búsqueda calcula millones de fechas y minutos sobre pocos valores distintos: con caché
// (perfil: `addDays` era el 64 % del tiempo).
const shifted = new Map<string, string>();
function addDays(date: string, days: number) {
  const k = `${date}|${days}`;
  let v = shifted.get(k);
  if (v === undefined) {
    if (shifted.size > 200_000) shifted.clear();
    v = addDaysRaw(date, days);
    shifted.set(k, v);
  }
  return v;
}
const minutes = new Map<string, number>();
function minutesOf(date: string, time: string) {
  const k = `${date} ${time}`;
  let v = minutes.get(k);
  if (v === undefined) {
    if (minutes.size > 200_000) minutes.clear();
    v = minutesOfRaw(date, time);
    minutes.set(k, v);
  }
  return v;
}

/** Inicios posibles del día: de `firstKickoff` a `lastKickoff` cada `step` minutos. */
export function timesOf(opts: Pick<AutoOptions, 'firstKickoff' | 'lastKickoff' | 'step'>) {
  const out: string[] = [];
  const step = Math.max(5, opts.step);
  for (let m = toMinutes(opts.firstKickoff); m <= toMinutes(opts.lastKickoff); m += step) out.push(clockOf(m));
  return out;
}

/** Órdenes a probar: primero el más restringido; después, barajados con semilla fija. */
function orderings(list: Fixture[], round: number, attempts: number, feasible: (f: Fixture) => number): Fixture[][] {
  const counts = new Map(list.map((f) => [f.key, feasible(f)]));
  const first = [...list].sort((a, b) => counts.get(a.key)! - counts.get(b.key)!);
  const out = [first];
  const random = mulberry32(round * 7919 + list.length);
  for (let k = 1; k < attempts && list.length > 1; k++) {
    const copy = [...first];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    out.push(copy);
  }
  return out;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function restMetrics(placements: Placement[], duration: number) {
  const byTeam = new Map<string, number[]>();
  for (const p of placements) for (const t of [p.homeTeamId, p.awayTeamId]) push(byTeam, t, minutesOf(p.date, p.time));
  let shortest: number | null = null;
  let longest: number | null = null;
  for (const starts of byTeam.values()) {
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      const rest = starts[i] - (starts[i - 1] + duration);
      shortest = shortest === null ? rest : Math.min(shortest, rest);
      longest = longest === null ? rest : Math.max(longest, rest);
    }
  }
  const dates = placements.map((p) => p.date).sort();
  return {
    shortestRestHours: shortest === null ? null : Math.round((shortest / 60) * 10) / 10,
    longestGapDays: longest === null ? null : Math.round((longest / 1440) * 10) / 10,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

const minDate = (a: string, b: string) => (a < b ? a : b);
const daysBetween = (a: string, b: string) => Math.round((minutesOf(b, '00:00') - minutesOf(a, '00:00')) / 1440);
const dateOfMinute = (m: number) => new Date(Math.floor(m / 1440) * 86_400_000).toISOString().slice(0, 10);

export function datesBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ─── Confirmación ────────────────────────────────────────────────────────────

/** Identidad de un partido del formato dentro del calendario (jornada + local + visitante). */
export const fixtureKey = (m: { round: number; homeTeamId: string; awayTeamId: string }) => `${m.round}|${m.homeTeamId}|${m.awayTeamId}`;

export interface Assignment {
  round: number;
  homeTeamId: string;
  awayTeamId: string;
  date: string;
  time: string;
  fieldId?: string | null;
}

/**
 * Aplica los horarios confirmados a los partidos que vuelve a planear el servidor. No puede haber
 * partidos de más ni repetidos (si el formato, la siembra o los inscritos cambiaron desde la vista
 * previa: 409 PROPOSAL_STALE). 6C: los que no traen horario quedan POR PROGRAMAR solo si
 * `allowPending` es exactamente cuántos son (confirmación explícita); si no, 409 PENDING_NOT_CONFIRMED.
 */
export function applyAssignments<T extends { round: number; homeTeamId: string; awayTeamId: string; date: string; time: string }>(
  planned: T[],
  assignments: Assignment[],
  allowPending = 0,
): (T & { fieldId: string | null; pending: boolean })[] {
  const byKey = new Map<string, Assignment>();
  for (const a of assignments) {
    const k = fixtureKey(a);
    if (byKey.has(k)) throw stale(`El partido de la jornada ${a.round} aparece dos veces en la propuesta`);
    byKey.set(k, a);
  }
  const keys = new Set(planned.map(fixtureKey));
  if ([...byKey.keys()].some((k) => !keys.has(k))) throw stale('La propuesta tiene partidos que el formato ya no genera: genera una propuesta nueva');
  const missing = planned.filter((m) => !byKey.has(fixtureKey(m)));
  if (missing.length !== allowPending) {
    throw new ConflictException({
      statusCode: 409,
      error: missing.length ? 'PENDING_NOT_CONFIRMED' : 'PROPOSAL_STALE',
      message: missing.length
        ? `${missing.length === 1 ? 'Queda 1 partido' : `Quedan ${missing.length} partidos`} sin horario: para guardarlos como «por programar» confírmalo (allowPending: ${missing.length})`
        : 'La propuesta ya no deja partidos sin horario: genera una propuesta nueva',
      pending: missing.length,
    });
  }
  return planned.map((m) => {
    const a = byKey.get(fixtureKey(m));
    return a ? { ...m, date: a.date, time: a.time, fieldId: a.fieldId ?? null, pending: false } : { ...m, fieldId: null, pending: true };
  });
}

/** La fecha de cada jornada es la de su primer partido (con horarios de una propuesta, 6B). */
export function roundsWithDates<R extends { number: number; date: string }>(rounds: R[], matches: { round: number; date: string; pending?: boolean }[]): R[] {
  return rounds.map((r) => {
    const dates = matches.filter((m) => m.round === r.number && !m.pending).map((m) => m.date).sort();
    return dates.length ? { ...r, date: dates[0] } : r;
  });
}

const stale = (message: string) => new ConflictException({ statusCode: 409, error: 'PROPOSAL_STALE', message });
