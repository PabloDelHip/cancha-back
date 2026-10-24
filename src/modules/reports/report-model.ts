/**
 * Módulo 8A — modelo de reporte independiente del formato. Los constructores (report-builders.ts)
 * producen un ReportDoc con datos ya calculados por los servicios de cada módulo; los renderizadores
 * (render/pdf.ts, render/xlsx.ts, render/csv.ts) solo lo dibujan. Ningún renderizador consulta la
 * base ni recalcula: lo que dice el PDF es lo mismo que dicen el Excel y el CSV.
 */

export type ReportId = 'standings' | 'matches' | 'players' | 'rosters' | 'discipline' | 'finance' | 'summary';
export type ReportFormat = 'pdf' | 'xlsx' | 'csv';
export const REPORT_FORMATS: ReportFormat[] = ['pdf', 'xlsx', 'csv'];

/**
 * Tipo de cada columna: decide alineación, formato y tipo de celda en Excel.
 * - money: CENTAVOS enteros (como finance_entries); se muestran en unidades.
 * - date: 'YYYY-MM-DD' (fecha deportiva, sin zona horaria).
 * - decimal: número con un decimal (promedios).
 * - diff: entero con signo visible (+2, −1, 0): diferencia de goles.
 */
export type ColumnType = 'text' | 'int' | 'diff' | 'decimal' | 'money' | 'date' | 'time';

export interface ReportColumn {
  label: string;
  type: ColumnType;
  /** Peso relativo del ancho en el PDF (por defecto según el tipo). */
  weight?: number;
}

export type Cell = string | number | null;

export interface TableSection {
  kind: 'table';
  title: string;
  columns: ReportColumn[];
  rows: Cell[][];
  /** Fila de totales (opcional), con la misma forma que las filas. */
  totals?: Cell[] | null;
  /** Texto cuando no hay filas («Sin partidos registrados»). */
  empty: string;
  /** Aclaración bajo la tabla (reglas aplicadas, criterios). */
  note?: string | null;
}

export interface KeyValueSection {
  kind: 'kv';
  title: string;
  items: [string, string][];
}

export type ReportSection = TableSection | KeyValueSection;

export interface ReportDoc {
  id: ReportId;
  title: string;
  tournament: { name: string; league: string | null; status: string; statusLabel: string; dates: string };
  /** Cuándo se generó (se muestra en la zona horaria de la app). */
  generatedAt: Date;
  /** Filtros aplicados, como texto («Equipo: Halcones», «Jornada 3»). */
  filters: string[];
  /** Logo del torneo (PNG o JPEG) o null: el PDF dibuja las iniciales. */
  logo: Buffer | null;
  logoInitials: string;
  orientation: 'portrait' | 'landscape';
  /** Moneda de los importes (solo finanzas). */
  currency?: string | null;
  sections: ReportSection[];
  /** Base del nombre de archivo, ya segura (ASCII, sin extensión). */
  fileBase: string;
}

/** Filas de datos de todas las tablas (para los límites de volumen). */
export const rowCount = (doc: ReportDoc) => doc.sections.reduce((n, s) => n + (s.kind === 'table' ? s.rows.length : s.items.length), 0);

/** Nombre de archivo ASCII seguro: «tabla-liga-norte-2026-10-23». */
export function slug(s: string, max = 60): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, max)
      .replace(/-$/, '') || 'torneo'
  );
}

/** Iniciales para el escudo de reserva: «Liga Municipal de Fútbol» → «LMF». */
export function initialsOf(name: string): string {
  const stop = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y']);
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !stop.has(w.toLowerCase()));
  if (!words.length) return 'K';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** '2026-10-25' → '25 oct 2026' (sin zona horaria: es la fecha deportiva). */
export function humanDate(iso: string | null | undefined): string {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  if (!m) return '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** Centavos → «1,500.50» (sin símbolo). */
export function humanMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Fecha y hora de generación en la zona de la app: «23 oct 2026, 18:05». */
export function humanStamp(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${humanDate(`${parts.year}-${parts.month}-${parts.day}`)}, ${parts.hour}:${parts.minute}`;
}

/** Fecha local de generación 'YYYY-MM-DD' (para el nombre de archivo). */
export function stampDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export const STATUS_LABEL: Record<string, string> = { DRAFT: 'Borrador', ACTIVE: 'En curso', FINISHED: 'Finalizado' };
