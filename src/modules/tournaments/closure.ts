/**
 * 10A — reglas de cierre de un torneo, compartidas por la vista previa (GET /closure) y el cierre
 * (POST /finish): lo que la vista previa dice que impide cerrar es exactamente lo que el cierre
 * rechaza. Funciones puras, sin base de datos.
 */
import { PhaseType, TournamentStatus } from '../../common/enums/index.js';
import type { StructureView } from '../competition/structure.js';

export interface ClosureIssue {
  code: string;
  message: string;
  /** Cuántos elementos afecta, cuando aplica. */
  count?: number;
}

/**
 * Bloqueantes: lo que impide finalizar.
 * - El torneo debe estar en curso.
 * - Formatos con eliminatoria: sin campeón definido por la estructura no hay cierre (regla previa).
 * - 10A: partidos EN JUEGO. Un torneo finalizado es historial inmutable: un partido en juego quedaría
 *   «En vivo» para siempre y su resultado ya no podría capturarse.
 */
export function closureBlockers(status: TournamentStatus, competitionBlockers: string[], live: number): ClosureIssue[] {
  const out: ClosureIssue[] = [];
  if (status === TournamentStatus.DRAFT) out.push({ code: 'NOT_STARTED', message: 'Solo se puede finalizar un torneo en curso: inícialo primero' });
  if (status === TournamentStatus.FINISHED) out.push({ code: 'ALREADY_FINISHED', message: 'El torneo ya está finalizado' });
  for (const b of competitionBlockers) out.push({ code: 'COMPETITION_INCOMPLETE', message: b });
  if (live > 0) out.push({ code: 'LIVE_MATCHES', count: live, message: `Hay ${live} ${live === 1 ? 'partido en juego' : 'partidos en juego'}: captura su resultado antes de finalizar` });
  return out;
}

/** Partidos sin jugar que el cierre acepta solo con confirmación explícita (allowPendingMatches). */
export interface PendingCounts {
  scheduled: number;
  postponed: number;
  pendingSchedule: number;
  suspended: number;
}

export function pendingWarnings(p: PendingCounts): ClosureIssue[] {
  const out: ClosureIssue[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (p.scheduled) out.push({ code: 'SCHEDULED_MATCHES', count: p.scheduled, message: `${plural(p.scheduled, 'partido programado', 'partidos programados')} sin jugar` });
  if (p.postponed) out.push({ code: 'POSTPONED_MATCHES', count: p.postponed, message: `${plural(p.postponed, 'partido pospuesto', 'partidos pospuestos')} sin nueva fecha jugada` });
  if (p.pendingSchedule) out.push({ code: 'UNSCHEDULED_MATCHES', count: p.pendingSchedule, message: `${plural(p.pendingSchedule, 'partido', 'partidos')} por programar (nunca tuvieron horario)` });
  if (p.suspended) out.push({ code: 'SUSPENDED_MATCHES', count: p.suspended, message: `${plural(p.suspended, 'partido suspendido', 'partidos suspendidos')} pendientes de decisión` });
  return out;
}

/** Subcampeón: solo el finalista que perdió una final decidida (como el perfil del equipo y el reporte). */
export function runnerUpOf(view: StructureView): string | null {
  const ko = [...view.phases].reverse().find((p) => p.type === PhaseType.KNOCKOUT);
  if (ko?.type !== PhaseType.KNOCKOUT) return null;
  const final = ko.rounds.at(-1)?.ties[0];
  if (!final?.winnerTeamId || !final.homeTeamId || !final.awayTeamId) return null;
  return final.winnerTeamId === final.homeTeamId ? final.awayTeamId : final.homeTeamId;
}
