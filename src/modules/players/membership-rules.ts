/**
 * El jugador pertenece al equipo en la fecha del partido: participación activa o vigente ese día
 * (cambios de equipo con periodos). Regla de la captura de estadísticas, reutilizada por la ficha.
 */
export function belongsOn(m: { active: boolean; startDate: string; endDate: string | null }, date: string) {
  return m.active || (m.startDate <= date && (m.endDate === null || m.endDate >= date));
}
