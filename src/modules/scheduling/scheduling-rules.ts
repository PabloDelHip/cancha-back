/**
 * 6A — restricciones de calendario, sin base de datos. Un partido ocupa `[inicio, inicio + duración)`
 * en minutos absolutos de la hora local del torneo (como la ocupación de canchas): un partido que
 * cruza la medianoche sigue contando para el horario, el descanso y los simultáneos.
 *
 * Severidad:
 * - ERROR: restricción obligatoria; no se puede confirmar la programación (409 SCHEDULE_CONSTRAINTS).
 * - WARNING: preferencia (de un equipo marcado como preferencia, o disponibilidad de cancha en modo
 *   aviso); se informa y se puede continuar.
 *
 * Estas reglas NO sustituyen las validaciones de siempre (cancha ocupada, árbitros, jornada, estados):
 * esas siguen en sus servicios y se aplican antes.
 */
import { BadRequestException } from '@nestjs/common';
import { availabilityWarnings, clockOf, minutesOf, type Availability } from '../venues/occupancy.js';
import { appTimeZone } from '../../common/utils/dates.js';

export const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'] as const;
/** «los domingos», «los lunes». */
const everyWeekday = (d: number) => `los ${WEEKDAYS[d].endsWith('s') ? WEEKDAYS[d] : `${WEEKDAYS[d]}s`}`;

export interface TournamentRules {
  timeZone: string | null;
  days: number[];
  startTime: string | null;
  endTime: string | null;
  fieldGapMinutes: number | null;
  maxMatchesPerDay: number | null;
  maxSimultaneous: number | null;
  fieldAvailability: 'WARN' | 'BLOCK';
  /**
   * 6B: reglas generales que son preferencia (avisan) en vez de obligatorias. Solo las que no son
   * integridad deportiva ni un recurso real: separación en cancha y simultáneos siempre bloquean.
   */
  softRules: SoftRule[];
}

export const SOFT_RULES = ['DAYS', 'HOURS', 'DAILY_LIMIT'] as const;
export type SoftRule = (typeof SOFT_RULES)[number];

export interface TimeRange {
  day: number | null;
  from: string;
  to: string;
}

export interface TeamRules {
  unavailableDays: number[];
  unavailableDates: string[];
  unavailableTimes: TimeRange[];
  minRestHours: number | null;
  maxMatchesPerDay: number | null;
  strict: boolean;
  notes: string | null;
}

export const DEFAULT_TOURNAMENT_RULES: TournamentRules = {
  timeZone: null,
  days: [],
  startTime: null,
  endTime: null,
  fieldGapMinutes: null,
  maxMatchesPerDay: null,
  maxSimultaneous: null,
  fieldAvailability: 'WARN',
  softRules: [],
};

export const DEFAULT_TEAM_RULES: TeamRules = {
  unavailableDays: [],
  unavailableDates: [],
  unavailableTimes: [],
  minRestHours: null,
  maxMatchesPerDay: null,
  strict: true,
  notes: null,
};

const pick = <T extends object>(defaults: T, value: Partial<T> | null | undefined): T =>
  Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, (value as Record<string, unknown> | null | undefined)?.[k] ?? d])) as T;

/** Reglas del torneo con sus valores por defecto (también los torneos anteriores a 6A). */
export const rulesOf = (t: { scheduling?: Partial<TournamentRules> | null } | null | undefined): TournamentRules => pick(DEFAULT_TOURNAMENT_RULES, t?.scheduling);
export const teamRulesOf = (e: { scheduling?: Partial<TeamRules> | null } | null | undefined): TeamRules => pick(DEFAULT_TEAM_RULES, e?.scheduling);

/** Zona horaria efectiva del torneo (la suya o la de las ligas). */
export const timeZoneOf = (rules: Pick<TournamentRules, 'timeZone'>) => rules.timeZone ?? appTimeZone();

export const hasTeamRules = (r: TeamRules) =>
  r.unavailableDays.length > 0 || r.unavailableDates.length > 0 || r.unavailableTimes.length > 0 || r.minRestHours !== null || r.maxMatchesPerDay !== null;

export const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const weekdayOf = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
export const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// ─── Validación de la configuración ──────────────────────────────────────────

/** Coherencia de las reglas del torneo con la duración de sus partidos (400 si no). */
export function assertTournamentRules(r: TournamentRules, duration: number) {
  if (r.timeZone !== null && !isValidTimeZone(r.timeZone)) throw new BadRequestException(`Zona horaria desconocida: ${r.timeZone}`);
  if (r.startTime && r.endTime) {
    const window = toMinutes(r.endTime) - toMinutes(r.startTime);
    if (window <= 0) throw new BadRequestException(`Horario inválido (${r.startTime}–${r.endTime}): el fin debe ser posterior al inicio`);
    if (window < duration) {
      throw new BadRequestException(`Un partido dura ${duration} min y no cabe en el horario ${r.startTime}–${r.endTime}: amplía el horario o reduce la duración`);
    }
  } else if (r.endTime && toMinutes(r.endTime) < duration) {
    // (Solo con inicio no hay tope: el último partido puede terminar después de medianoche.)
    throw new BadRequestException(`Un partido dura ${duration} min: no puede terminar a las ${r.endTime}`);
  }
}

/** Coherencia de las reglas de un equipo, también frente a las del torneo (400 si no). */
export function assertTeamRules(r: TeamRules, tournament: TournamentRules, teamName = 'El equipo') {
  for (const t of r.unavailableTimes) {
    if (toMinutes(t.to) <= toMinutes(t.from)) throw new BadRequestException(`Rango inválido (${t.from}–${t.to}): el fin debe ser posterior al inicio`);
  }
  if (!r.strict) return;
  // Con los días del torneo como preferencia, el equipo puede jugar cualquier otro.
  const playable = tournament.days.length && !tournament.softRules.includes('DAYS') ? tournament.days : [0, 1, 2, 3, 4, 5, 6];
  const blocked = new Set(r.unavailableDays);
  // Un rango de todo el día (00:00–24:00) también bloquea el día.
  for (const t of r.unavailableTimes) {
    if (t.from === '00:00' && t.to === '24:00') (t.day === null ? playable : [t.day]).forEach((d) => blocked.add(d));
  }
  if (playable.every((d) => blocked.has(d))) {
    throw new BadRequestException(
      `${teamName} no podría jugar ningún día del torneo (${playable.map((d) => WEEKDAYS[d]).join(', ')}): quita algún día no disponible o márcalo como preferencia`,
    );
  }
}

// ─── Evaluación ──────────────────────────────────────────────────────────────

export type ConstraintCode =
  | 'DAY_NOT_ALLOWED'
  | 'OUTSIDE_HOURS'
  | 'TOURNAMENT_DAILY_LIMIT'
  | 'SIMULTANEOUS_LIMIT'
  | 'FIELD_GAP'
  | 'FIELD_UNAVAILABLE'
  | 'TEAM_DAY'
  | 'TEAM_DATE'
  | 'TEAM_TIME'
  | 'TEAM_REST'
  | 'TEAM_DAILY_LIMIT';

export interface Violation {
  code: ConstraintCode;
  severity: 'ERROR' | 'WARNING';
  scope: 'TOURNAMENT' | 'TEAM' | 'FIELD';
  message: string;
  teamId: string | null;
  fieldId: string | null;
  /** Otros partidos que intervienen (el que choca en descanso, los del mismo día…). */
  relatedMatchIds: string[];
}

export interface Evaluation {
  valid: boolean;
  errors: Violation[];
  warnings: Violation[];
}

/** Partido que se quiere programar (nuevo o movido). `key` lo identifica en el resultado. */
export interface Proposal {
  key: string;
  matchId: string | null;
  homeTeamId: string;
  awayTeamId: string;
  date: string;
  time: string;
  fieldId: string | null;
  /** Solo para los mensajes. */
  round?: number;
}

/** Partido que ya ocupa su horario (de este torneo o, en una cancha, de cualquiera). */
export interface Booked {
  id: string;
  tournamentId: string;
  homeTeamId: string;
  awayTeamId: string;
  date: string;
  time: string;
  fieldId: string | null;
  duration: number;
}

export interface EvaluationContext {
  tournamentId: string;
  duration: number;
  rules: TournamentRules;
  teamRules: Map<string, TeamRules>;
  teamNames: Map<string, string>;
  /** Partidos del torneo que reservan horario (sin los propuestos). */
  tournamentMatches: Booked[];
  /** Partidos de otros torneos en las canchas propuestas (sin los propuestos). */
  otherFieldMatches: Booked[];
  fields: Map<string, { label: string; availability: Availability | null }>;
}

const span = (b: { date: string; time: string; duration: number }) => {
  const start = minutesOf(b.date, b.time);
  return { start, end: start + b.duration };
};
const describeEnd = (start: number, end: number) => `${clockOf(end)}${Math.floor((end - 1) / 1440) !== Math.floor(start / 1440) ? ' del día siguiente' : ''}`;

/**
 * Evalúa cada propuesta contra las reglas, los partidos ya programados y las demás propuestas
 * (un calendario generado se evalúa completo). Devuelve una evaluación por `key`.
 */
export function evaluate(proposals: Proposal[], ctx: EvaluationContext): Map<string, Evaluation> {
  const asBooked = (p: Proposal): Booked => ({ id: p.matchId ?? `new:${p.key}`, tournamentId: ctx.tournamentId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, date: p.date, time: p.time, fieldId: p.fieldId, duration: ctx.duration });
  const proposed = proposals.map(asBooked);
  const result = new Map<string, Evaluation>();
  proposals.forEach((p, i) => {
    const self = proposed[i];
    const others = [...ctx.tournamentMatches, ...proposed.filter((_, j) => j !== i)];
    const violations = check(p, self, others, ctx, proposed.filter((_, j) => j !== i));
    const errors = violations.filter((v) => v.severity === 'ERROR');
    result.set(p.key, { valid: errors.length === 0, errors, warnings: violations.filter((v) => v.severity === 'WARNING') });
  });
  return result;
}

const realIds = (bs: Booked[]) => bs.map((b) => b.id).filter((id) => !id.startsWith('new:'));

function check(p: Proposal, self: Booked, others: Booked[], ctx: EvaluationContext, otherProposals: Booked[]): Violation[] {
  const out: Violation[] = [];
  const r = ctx.rules;
  const { start, end } = span(self);
  const base = minutesOf(p.date, '00:00');
  const day = weekdayOf(p.date);
  const add = (v: Omit<Violation, 'teamId' | 'fieldId' | 'relatedMatchIds'> & Partial<Violation>) => out.push({ teamId: null, fieldId: null, relatedMatchIds: [], ...v });

  // Días, horario y máximo diario del torneo: obligatorios salvo que se marquen como preferencia (6B).
  const soft = (rule: SoftRule) => (r.softRules.includes(rule) ? { severity: 'WARNING' as const, pref: ' (preferencia)' } : { severity: 'ERROR' as const, pref: '' });
  if (r.days.length && !r.days.includes(day)) {
    const { severity, pref } = soft('DAYS');
    add({ code: 'DAY_NOT_ALLOWED', severity, scope: 'TOURNAMENT', message: `El torneo no programa partidos en ${WEEKDAYS[day]} (${p.date}). Días permitidos: ${r.days.map((d) => WEEKDAYS[d]).join(', ')}${pref}.` });
  }
  const early = r.startTime !== null && start < base + toMinutes(r.startTime);
  const late = r.endTime !== null && end > base + toMinutes(r.endTime);
  if (early || late) {
    const { severity, pref } = soft('HOURS');
    add({
      code: 'OUTSIDE_HOURS',
      severity,
      scope: 'TOURNAMENT',
      message: `El partido (${p.time}–${describeEnd(start, end)}) queda fuera del horario del torneo (${r.startTime ? `desde las ${r.startTime}` : ''}${r.startTime && r.endTime ? ' ' : ''}${r.endTime ? `hasta las ${r.endTime}` : ''})${pref}.`,
    });
  }

  // Límites del torneo.
  const sameDay = others.filter((o) => o.date === p.date);
  if (r.maxMatchesPerDay !== null && sameDay.length + 1 > r.maxMatchesPerDay) {
    const { severity, pref } = soft('DAILY_LIMIT');
    add({ code: 'TOURNAMENT_DAILY_LIMIT', severity, scope: 'TOURNAMENT', message: `El ${p.date} ya hay ${sameDay.length} ${sameDay.length === 1 ? 'partido' : 'partidos'} del torneo: el máximo es ${r.maxMatchesPerDay} por día${pref}.`, relatedMatchIds: realIds(sameDay) });
  }
  if (r.maxSimultaneous !== null) {
    const overlapping = others.filter((o) => {
      const s = span(o);
      return s.start < end && start < s.end;
    });
    const points = [start, ...overlapping.map((o) => span(o).start).filter((x) => x > start && x < end)];
    const peak = Math.max(...points.map((x) => 1 + overlapping.filter((o) => span(o).start <= x && x < span(o).end).length));
    if (peak > r.maxSimultaneous) {
      add({ code: 'SIMULTANEOUS_LIMIT', severity: 'ERROR', scope: 'TOURNAMENT', message: `Habría ${peak} partidos del torneo jugándose a la vez (máximo ${r.maxSimultaneous}).`, relatedMatchIds: realIds(overlapping) });
    }
  }

  // Cancha: separación del torneo y disponibilidad del catálogo.
  if (p.fieldId) {
    const field = ctx.fields.get(p.fieldId);
    const label = field?.label ?? 'la cancha';
    if (r.fieldGapMinutes) {
      const neighbours = [...ctx.otherFieldMatches, ...ctx.tournamentMatches, ...otherProposals].filter((o) => o.fieldId === p.fieldId);
      const close = neighbours.filter((o) => {
        const s = span(o);
        return s.start < end + r.fieldGapMinutes! && start < s.end + r.fieldGapMinutes!;
      });
      if (close.length) {
        const first = close.sort((a, b) => span(a).start - span(b).start)[0];
        add({
          code: 'FIELD_GAP',
          severity: 'ERROR',
          scope: 'FIELD',
          fieldId: p.fieldId,
          message: `En ${label} debe haber al menos ${r.fieldGapMinutes} min entre partidos: ya hay uno el ${first.date} de ${first.time} a ${clockOf(span(first).end)}.`,
          relatedMatchIds: realIds(close),
        });
      }
    }
    for (const message of availabilityWarnings(field?.availability, { date: p.date, time: p.time, duration: ctx.duration, buffer: 0 })) {
      add({ code: 'FIELD_UNAVAILABLE', severity: r.fieldAvailability === 'BLOCK' ? 'ERROR' : 'WARNING', scope: 'FIELD', fieldId: p.fieldId, message: `${message} (${label}).` });
    }
  }

  // Equipos (solo en este torneo).
  for (const teamId of [p.homeTeamId, p.awayTeamId]) {
    const tr = ctx.teamRules.get(teamId);
    if (!tr || !hasTeamRules(tr)) continue;
    const name = ctx.teamNames.get(teamId) ?? 'El equipo';
    const severity = tr.strict ? 'ERROR' : 'WARNING';
    const pref = tr.strict ? '' : ' (preferencia)';
    const team = (v: Omit<Violation, 'teamId' | 'fieldId' | 'relatedMatchIds' | 'severity' | 'scope'> & Partial<Violation>) => add({ severity, scope: 'TEAM', teamId, ...v });
    if (tr.unavailableDays.includes(day)) team({ code: 'TEAM_DAY', message: `${name} no puede jugar ${everyWeekday(day)}${pref}.` });
    if (tr.unavailableDates.includes(p.date)) team({ code: 'TEAM_DATE', message: `${name} no puede jugar el ${p.date}${pref}.` });
    // Rangos del día de inicio y, si cruza la medianoche, del día siguiente.
    for (let offset = 0; offset * 1440 + base < end; offset++) {
      const d = (day + offset) % 7;
      for (const t of tr.unavailableTimes) {
        if (t.day !== null && t.day !== d) continue;
        const from = base + offset * 1440 + toMinutes(t.from);
        const to = base + offset * 1440 + toMinutes(t.to);
        if (from < end && start < to) {
          team({ code: 'TEAM_TIME', message: `${name} no puede jugar ${t.day === null ? '' : `${everyWeekday(t.day)} `}de ${t.from} a ${t.to}${pref}.` });
        }
      }
    }
    const own = others.filter((o) => o.homeTeamId === teamId || o.awayTeamId === teamId);
    if (tr.minRestHours) {
      const rest = tr.minRestHours * 60;
      const tooClose = own.filter((o) => {
        const s = span(o);
        return s.start < end + rest && start < s.end + rest;
      });
      if (tooClose.length) {
        const o = tooClose.sort((a, b) => Math.abs(span(a).start - start) - Math.abs(span(b).start - start))[0];
        team({ code: 'TEAM_REST', message: `${name} necesita ${tr.minRestHours} h de descanso entre partidos y también juega el ${o.date} a las ${o.time}${pref}.`, relatedMatchIds: realIds(tooClose) });
      }
    }
    if (tr.maxMatchesPerDay !== null) {
      const sameDate = own.filter((o) => o.date === p.date);
      if (sameDate.length + 1 > tr.maxMatchesPerDay) {
        team({ code: 'TEAM_DAILY_LIMIT', message: `${name} jugaría ${sameDate.length + 1} partidos el ${p.date} (máximo ${tr.maxMatchesPerDay})${pref}.`, relatedMatchIds: realIds(sameDate) });
      }
    }
  }
  return out;
}
