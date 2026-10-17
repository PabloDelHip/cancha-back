import { MembershipAuditAction } from './schemas/team-membership.schema.js';

/**
 * El jugador pertenece al equipo en la fecha del partido (regla de la captura de estadísticas,
 * reutilizada por la ficha técnica):
 * - Desde 3A (`registeredAt` presente): solo dentro de su periodo efectivo, `startDate`–`endDate`
 *   (ambos inclusive). Inscribirse tarde no habilita partidos anteriores sin excepción RETROACTIVE.
 * - Participaciones anteriores a 3A (`registeredAt` null): la regla previa, activa = elegible en
 *   cualquier fecha; cerrada = su periodo. Así ningún dato histórico cambia de validez.
 */
export function belongsOn(m: { active: boolean; startDate: string; endDate: string | null; registeredAt?: string | null }, date: string) {
  if (m.active && !m.registeredAt) return true;
  return m.startDate <= date && (m.endDate === null || m.endDate >= date);
}

/**
 * 3C — equipo de origen si la participación nació de un cambio de equipo: su auditoría REGISTERED
 * trae `fromTeamId`. null = alta normal, o participación anterior a 3A (sin auditoría).
 */
export function transferredFrom(m: { audit?: { action: string; details?: Record<string, unknown> | null }[] | null }): string | null {
  const from = m.audit?.find((a) => a.action === MembershipAuditAction.REGISTERED)?.details?.fromTeamId;
  return typeof from === 'string' ? from : null;
}
