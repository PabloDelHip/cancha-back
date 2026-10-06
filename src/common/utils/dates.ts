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

/** Fecha de hoy en formato `YYYY-MM-DD` (zona local del servidor). */
export function todayISODate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
