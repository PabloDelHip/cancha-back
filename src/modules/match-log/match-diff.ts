/**
 * Qué cambió en un partido, sin base de datos. Se normaliza antes de comparar (ids a texto,
 * `''` y `undefined` a null) para no registrar cambios que no lo son cuando el formulario
 * reenvía todos los campos.
 */
import { Types } from 'mongoose';
import { MatchLogAction } from '../../common/enums/index.js';

/** Campos de programación que se auditan al editar un partido. */
export const TRACKED = ['tournamentId', 'round', 'homeTeamId', 'awayTeamId', 'date', 'time', 'status', 'fieldId', 'venue'] as const;
/** Campos del resultado (el detalle de estadísticas queda para el acta, 2D). */
export const RESULT = ['status', 'homeScore', 'awayScore', 'penalties', 'extraTime'] as const;

type Changes = Record<string, { from: unknown; to: unknown }>;

export function normalize(v: unknown): unknown {
  if (v === undefined || v === '') return null;
  if (v instanceof Types.ObjectId) return v.toHexString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)]));
  return v;
}

export function diff(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]): Changes | null {
  const changes: Changes = {};
  for (const f of fields) {
    const from = normalize(before[f]);
    const to = normalize(after[f]);
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[f] = { from, to };
  }
  return Object.keys(changes).length ? changes : null;
}

/** Tipo principal de una edición (la entrada guarda además todos los cambios). */
export function editAction(c: Changes): MatchLogAction {
  if (c.date || c.time) return MatchLogAction.RESCHEDULED;
  if (c.status) return MatchLogAction.STATUS_CHANGED;
  if (c.fieldId || c.venue) return MatchLogAction.FIELD_CHANGED;
  if (c.homeTeamId || c.awayTeamId) return MatchLogAction.TEAMS_CHANGED;
  return MatchLogAction.UPDATED;
}

/** Captura (primera vez o al finalizar) o corrección de un resultado ya registrado. */
export function resultAction(before: { homeScore: unknown; status: string }, after: { status: string }): MatchLogAction {
  if (before.homeScore === null || before.homeScore === undefined) return MatchLogAction.RESULT_CAPTURED;
  if (before.status !== 'FINISHED' && after.status === 'FINISHED') return MatchLogAction.RESULT_CAPTURED;
  return MatchLogAction.RESULT_CORRECTED;
}

/** Copia de lo esencial de un partido (para entradas de creación y eliminación). */
export function snapshotOf(m: Record<string, unknown>) {
  const pick = ['round', 'homeTeamId', 'awayTeamId', 'date', 'time', 'status', 'homeScore', 'awayScore', 'stage', 'venue', 'fieldId', 'centralReferee'];
  const snap = Object.fromEntries(pick.map((k) => [k, normalize(m[k])]));
  const referees = (m.referees as { refereeId: unknown; role: string; status: string }[] | undefined) ?? [];
  return { id: normalize(m._id), ...snap, referees: referees.map((r) => ({ refereeId: normalize(r.refereeId), role: r.role, status: r.status })) };
}

/** Cancha y árbitros en funciones que se liberan al eliminar el partido (null si no tenía). */
export function releasedOf(m: Record<string, unknown>) {
  const referees = ((m.referees as { refereeId: unknown; role: string; status: string }[] | undefined) ?? [])
    .filter((r) => r.status === 'ASSIGNED')
    .map((r) => ({ refereeId: normalize(r.refereeId) as string, role: r.role }));
  if (!m.fieldId && !referees.length) return null;
  return { matchId: normalize(m._id) as string, fieldId: (normalize(m.fieldId) as string | null) ?? null, venue: m.fieldId ? ((m.venue as string | null) ?? null) : null, referees };
}
