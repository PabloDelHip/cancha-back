/**
 * Detección de POSIBLES duplicados al registrar un jugador. Nunca decide que dos fichas son la misma
 * persona: solo propone candidatos para que quien registra lo revise (puede haber homónimos).
 *
 * Reglas (sobre nombre y apellidos normalizados: minúsculas, sin acentos, sin partículas):
 * - Nombre: algún token del nombre coincide (José ~ José Luis; Luis ~ José Luis).
 * - Apellidos: algún token de los apellidos coincide (Pérez ~ Pérez López; López ~ Pérez López).
 * - "Coincide" = igual, o muy parecido: ambos tokens con ≥ 4 letras, mismas 3 primeras letras y
 *   ≥ 80 % de similitud (Levenshtein): Hernández ~ Hernandes, Guadalupe ~ Guadalupee. Empezar igual
 *   evita confundir apellidos distintos (Hernández ≠ Fernández) y coincide con el prefiltro de la base.
 * - Hacen falta AMBOS (nombre y apellido). El apodo NO cuenta para detectar (no identifica a nadie).
 * - La fecha de nacimiento solo ordena: igual sube, distinta baja (nunca descarta: puede estar mal
 *   capturada). Nunca se expone si coincidió.
 */
import { normalizeSearch } from './schemas/player.schema.js';

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'da', 'do', 'dos', 'van', 'von', 'di']);
export const MAX_CANDIDATES = 8;

export interface NameInput {
  firstName: string;
  lastName: string;
  birthDate?: string | null;
}

export function nameTokens(value: string): string[] {
  return normalizeSearch(value)
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !PARTICLES.has(t));
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

const similarity = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length);

/** Mejor similitud entre dos listas de tokens (0 si ninguna pareja "coincide"). */
function bestTokenMatch(a: string[], b: string[]): number {
  let best = 0;
  for (const x of a) {
    for (const y of b) {
      const fuzzy = Math.min(x.length, y.length) >= 4 && x.slice(0, 3) === y.slice(0, 3);
      const sim = x === y ? 1 : fuzzy ? similarity(x, y) : 0;
      if (sim >= 0.8 && sim > best) best = sim;
    }
  }
  return best;
}

/** Puntuación 0–1 si es un posible duplicado; null si no lo es. */
export function duplicateScore(input: NameInput, existing: NameInput): number | null {
  const first = bestTokenMatch(nameTokens(input.firstName), nameTokens(existing.firstName));
  const last = bestTokenMatch(nameTokens(input.lastName), nameTokens(existing.lastName));
  if (!first || !last) return null;
  const sameFull =
    nameTokens(`${input.firstName} ${input.lastName}`).join(' ') === nameTokens(`${existing.firstName} ${existing.lastName}`).join(' ');
  let score = sameFull ? 1 : (first + last) / 2 - 0.05;
  if (input.birthDate && existing.birthDate) score += input.birthDate === existing.birthDate ? 0.1 : -0.2;
  return Math.max(0, Math.min(1.1, score));
}

/**
 * Prefiltro para la base: jugadores cuyo texto de búsqueda tenga alguna palabra que EMPIECE como
 * algún token del nombre Y alguna como algún token de los apellidos (3 primeras letras). Acota la
 * consulta (índice de searchName) sin perder variantes con errores después de la 3.ª letra.
 */
export function prefilterRegexes(input: NameInput): { first: string; last: string } | null {
  const prefix = (tokens: string[]) => [...new Set(tokens.map((t) => t.slice(0, 3)))].map((t) => t.replace(/[^a-z0-9ñ]/g, ''));
  const first = prefix(nameTokens(input.firstName));
  const last = prefix(nameTokens(input.lastName));
  if (!first.length || !last.length) return null;
  return { first: `(^| )(${first.join('|')})`, last: `(^| )(${last.join('|')})` };
}
