/**
 * Ocupación de canchas, sin base de datos. Un partido ocupa su cancha desde su fecha y hora
 * locales durante la duración del torneo más el margen de la sede (cambio entre partidos):
 * [inicio, inicio + duración + margen). Se trabaja en minutos absolutos, así que un partido que
 * cruza la medianoche choca también con los del día siguiente.
 */
import { MatchStatus } from '../../common/enums/index.js';

/** Duración si el torneo no la configura (decisión del organizador, 2026-10-09). */
export const DEFAULT_MATCH_MINUTES = 60;
export const DEFAULT_BUFFER_MINUTES = 15;

/** Duración de los partidos de un torneo (la de su configuración o la de por defecto). */
export const durationOf = (t: { information?: { schedule?: { durationMinutes?: number | null } } } | null | undefined) =>
  t?.information?.schedule?.durationMinutes ?? DEFAULT_MATCH_MINUTES;

/**
 * Cancelados y pospuestos no reservan: un pospuesto vuelve a reservar al reprogramarse. Un
 * suspendido conserva su horario (ya lo ocupó) hasta que se decida qué pasa con él.
 */
export const RESERVING = [MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.FINISHED, MatchStatus.SUSPENDED];
export const reserves = (status: MatchStatus) => RESERVING.includes(status);

/** Minutos absolutos de una fecha y hora locales (`YYYY-MM-DD`, `HH:mm`). */
export function minutesOf(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d) / 60000 + hh * 60 + mm;
}

export function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `HH:mm` de un minuto absoluto (para mensajes). */
export function clockOf(minutes: number) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface Slot {
  date: string;
  time: string;
  /** Duración del partido (la del torneo). */
  duration: number;
  /** Margen de la sede. */
  buffer: number;
}

export function interval(s: Slot) {
  const start = minutesOf(s.date, s.time);
  return { start, end: start + s.duration + s.buffer };
}

export const overlaps = (a: Slot, b: Slot) => {
  const x = interval(a);
  const y = interval(b);
  return x.start < y.end && y.start < x.end;
};

export interface Availability {
  /** Ventanas por día de la semana (0 = domingo). Vacío = sin restricción. `to` admite `24:00`. */
  weekly: { day: number; from: string; to: string }[];
  /** Fechas `YYYY-MM-DD` en que la cancha no está disponible. */
  closedDates: string[];
}

/**
 * Advertencias de disponibilidad (nunca bloquean). Se compara el partido sin el margen: el
 * margen es para el cambio entre partidos, no tiempo de juego.
 */
export function availabilityWarnings(a: Availability | null | undefined, s: Slot, who: { subject: string; of: string } = { subject: 'La cancha', of: 'de la cancha' }): string[] {
  if (!a) return [];
  const warnings: string[] = [];
  if (a.closedDates.includes(s.date)) warnings.push(`${who.subject} no está disponible el ${s.date}`);
  if (a.weekly.length) {
    const [y, m, d] = s.date.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const start = minutesOf(s.date, s.time);
    const end = start + s.duration;
    const base = minutesOf(s.date, '00:00');
    const fits = a.weekly.some((w) => w.day === day && base + toMin(w.from) <= start && end <= base + toMin(w.to));
    if (!fits) warnings.push(`El partido (${s.time}–${clockOf(end)}) queda fuera del horario configurado ${who.of} para ese día`);
  }
  return warnings;
}

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

/** Pares que se solapan entre varios partidos (barrido por inicio). */
export function conflictsAmong<T extends Slot & { id: string }>(slots: T[]): [T, T][] {
  const sorted = [...slots].sort((a, b) => interval(a).start - interval(b).start);
  const pairs: [T, T][] = [];
  for (let i = 0; i < sorted.length; i++) {
    const end = interval(sorted[i]).end;
    for (let j = i + 1; j < sorted.length && interval(sorted[j]).start < end; j++) pairs.push([sorted[i], sorted[j]]);
  }
  return pairs;
}
