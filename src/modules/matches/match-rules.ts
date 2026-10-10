/** Reglas puras de 2C-2 (sin base de datos): decisiones sobre suspendidos y confirmación de liberaciones. */
import { ConflictException } from '@nestjs/common';
import { MatchStatus, SuspensionDecision } from '../../common/enums/index.js';

/** Decisión sobre un suspendido según el estado al que pasa. */
export const DECISION = {
  [MatchStatus.LIVE]: SuspensionDecision.RESUMED,
  [MatchStatus.SCHEDULED]: SuspensionDecision.RESCHEDULED,
  [MatchStatus.POSTPONED]: SuspensionDecision.POSTPONED,
  [MatchStatus.CANCELLED]: SuspensionDecision.CANCELLED,
  [MatchStatus.FINISHED]: SuspensionDecision.FINISHED,
} as const;

export type Released = { matchId: string; fieldId: string | null; venue: string | null; referees: { refereeId: string; role: string }[] };

/** Lo confirmado coincide exactamente con lo que hay que liberar ahora. */
export function sameRelease(now: { field: boolean; assignmentIds: string[] }, confirmed: { field: boolean; assignmentIds: string[] }) {
  const ids = [...new Set(confirmed.assignmentIds)].sort();
  return now.field === confirmed.field && ids.length === now.assignmentIds.length && ids.every((x, i) => x === now.assignmentIds[i]);
}

/**
 * Vista pública: las correcciones arbitrales (quién y por qué) son internas del torneo. Las
 * asignaciones conservan ids, rol y estado, como en 2B. De la ficha cerrada solo sale cuándo.
 */
export function publicMatch<T extends { referees?: { voided?: unknown; absenceVoided?: unknown }[]; sheetClosed?: { at: Date } | null }>(m: T): T {
  const out = { ...m };
  if (m.referees?.length) out.referees = m.referees.map(({ voided: _v, absenceVoided: _a, ...rest }) => rest);
  if (m.sheetClosed) out.sheetClosed = { at: m.sheetClosed.at } as T['sheetClosed'];
  return out;
}

export const SHEET_CLOSED_MESSAGE = 'La ficha técnica del partido está cerrada: reábrela (con motivo) para modificar su información deportiva';

/** Ficha cerrada (2D) = información deportiva congelada: 409 para cualquier escritura protegida. */
export function assertSheetOpen(match: { sheetClosed?: unknown }) {
  if (match.sheetClosed) throw new ConflictException({ statusCode: 409, error: 'SHEET_CLOSED', message: SHEET_CLOSED_MESSAGE });
}
