/**
 * Convención de fechas (ver README):
 * - Fechas "puras" (birthDate, startDate, endDate, fecha de partido) se guardan como
 *   string `YYYY-MM-DD`, sin zona horaria. Nunca se convierten a Date: así un partido
 *   del sábado 16 no aparece el viernes 15 en otra zona horaria.
 * - La hora del partido es `HH:mm`, hora local de la sede.
 * - createdAt/updatedAt son timestamps reales (Date, UTC).
 */
export const ISO_DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Zona horaria de las ligas: decide qué día es "hoy" (altas, bajas, plazos, movimientos). No se usa
 * la del servidor: Cloud Run corre en UTC y de noche (hora de México) ya sería el día siguiente,
 * así que un jugador dado de alta a las 23:00 quedaba inscrito "mañana" (bug 2026-10-18).
 */
export const DEFAULT_TIME_ZONE = 'America/Cancun';
export const appTimeZone = () => process.env.APP_TIME_ZONE?.trim() || DEFAULT_TIME_ZONE;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Fecha de hoy en formato `YYYY-MM-DD` en la zona de las ligas (`APP_TIME_ZONE`). */
export function todayISODate(now = new Date(), timeZone = appTimeZone()): string {
  let f = formatters.get(timeZone);
  if (!f) formatters.set(timeZone, (f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })));
  return f.format(now);
}

/** Comprueba además que la fecha exista (rechaza 2027-02-30). */
export function isValidISODate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Edad en años cumplidos a la fecha `today` (`YYYY-MM-DD`). Se deriva siempre: nunca se
 * persiste, y es lo único que las respuestas públicas publican de la fecha de nacimiento.
 */
export function ageOn(birthDate: string | null | undefined, today = todayISODate()): number | null {
  if (!birthDate) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
