import type { Db } from 'mongodb';

/**
 * 5C — referencias a jugadores, equipos, partidos y torneos que ya no existen. SOLO LECTURA:
 * cada revisión es una agregación ($unwind/$group/$lookup), sin $out ni $merge.
 *
 * - `problem`: no debería existir con las reglas actuales (dato heredado de antes de 5B o error).
 * - `expected`: referencia histórica que el sistema conserva a propósito y sabe mostrar
 *   (historiales, sanción manual que aplica desde su posición guardada).
 */
export interface OrphanCheck {
  collection: string;
  /** Ruta del campo con la referencia (puede atravesar arreglos, ver `unwind`). */
  field: string;
  target: 'players' | 'teams' | 'matches' | 'tournaments';
  unwind?: string[];
  filter?: Record<string, unknown>;
  expected?: boolean;
  note: string;
}

export interface OrphanFinding {
  collection: string;
  field: string;
  target: string;
  severity: 'problem' | 'expected';
  note: string;
  /** Ids referidos que no existen en `target`. */
  missingIds: number;
  /** Documentos que los refieren. */
  documents: number;
  /** Algunos documentos afectados (para revisarlos a mano). */
  sample: string[];
}

const P = 'players', T = 'teams', M = 'matches', TO = 'tournaments';

export const ORPHAN_CHECKS: OrphanCheck[] = [
  // Jugadores
  { collection: 'team_memberships', field: 'playerId', target: P, note: 'Participación en torneo de una ficha borrada' },
  { collection: 'player_match_stats', field: 'playerId', target: P, note: 'Estadística de una ficha borrada' },
  { collection: 'sanctions', field: 'playerId', target: P, note: 'Sanción de una ficha borrada (se muestra como «Jugador»)' },
  { collection: 'match_sheets', field: 'teams.players.playerId', unwind: ['teams', 'teams.players'], target: P, note: 'Alineación con una ficha borrada' },
  { collection: 'match_sheets', field: 'teams.substitutions.inPlayerId', unwind: ['teams', 'teams.substitutions'], target: P, note: 'Cambio (entra) con una ficha borrada' },
  { collection: 'match_sheets', field: 'teams.substitutions.outPlayerId', unwind: ['teams', 'teams.substitutions'], target: P, note: 'Cambio (sale) con una ficha borrada' },
  { collection: 'finance_entries', field: 'playerId', target: P, filter: { playerId: { $ne: null } }, note: 'Multa vinculada a una ficha borrada (se puede corregir desde 5B)' },
  { collection: 'registration_requests', field: 'playerIds', unwind: ['playerIds'], target: P, filter: { status: 'PENDING' }, note: 'Solicitud pendiente con una ficha borrada' },
  { collection: 'team_rosters', field: 'playerId', target: P, note: 'Plantilla global con una ficha borrada' },
  { collection: 'player_blocks', field: 'playerId', target: P, note: 'Restricción de una ficha borrada' },
  { collection: 'registration_requests', field: 'playerIds', unwind: ['playerIds'], target: P, filter: { status: { $ne: 'PENDING' } }, expected: true, note: 'Solicitud ya resuelta (historial)' },
  { collection: 'registration_drafts', field: 'playerIds', unwind: ['playerIds'], target: P, expected: true, note: 'Borrador de inscripción (la propuesta deja de mostrarla)' },
  { collection: 'discipline_log', field: 'playerId', target: P, filter: { playerId: { $ne: null } }, expected: true, note: 'Historial disciplinario' },
  { collection: 'removed_enrollments', field: 'memberships.playerId', unwind: ['memberships'], target: P, expected: true, note: 'Copia de un equipo quitado (historial de plantillas)' },
  // Equipos
  { collection: 'tournament_teams', field: 'teamId', target: T, note: 'Inscripción de un equipo borrado' },
  { collection: 'matches', field: 'homeTeamId', target: T, note: 'Partido con local borrado' },
  { collection: 'matches', field: 'awayTeamId', target: T, note: 'Partido con visitante borrado' },
  { collection: 'team_memberships', field: 'teamId', target: T, note: 'Participación con un equipo borrado' },
  { collection: 'player_match_stats', field: 'teamId', target: T, note: 'Estadística con un equipo borrado' },
  { collection: 'sanctions', field: 'teamId', target: T, note: 'Sanción con un equipo borrado' },
  { collection: 'match_sheets', field: 'teams.teamId', unwind: ['teams'], target: T, note: 'Ficha técnica de un equipo borrado' },
  { collection: 'finance_entries', field: 'teamId', target: T, note: 'Movimiento financiero de un equipo borrado' },
  { collection: 'registration_requests', field: 'teamId', target: T, filter: { status: 'PENDING' }, note: 'Solicitud pendiente de un equipo borrado' },
  { collection: 'team_rosters', field: 'teamId', target: T, note: 'Plantilla global de un equipo borrado' },
  { collection: 'team_admins', field: 'teamId', target: T, note: 'Responsable de un equipo borrado' },
  { collection: 'tournaments', field: 'trackedTeamIds', unwind: ['trackedTeamIds'], target: T, note: 'Cobertura de datos con un equipo borrado' },
  { collection: 'removed_enrollments', field: 'teamId', target: T, note: 'Copia de un equipo quitado que luego se borró (bloqueado desde 5B)' },
  { collection: 'registration_drafts', field: 'teamId', target: T, expected: true, note: 'Borrador de inscripción' },
  // Partidos
  { collection: 'player_match_stats', field: 'matchId', target: M, note: 'Estadística de un partido borrado' },
  { collection: 'match_sheets', field: 'matchId', target: M, note: 'Ficha técnica de un partido borrado' },
  { collection: 'match_incidents', field: 'matchId', target: M, note: 'Incidencia de un partido borrado' },
  { collection: 'match_evidence', field: 'matchId', target: M, note: 'Evidencia de un partido borrado' },
  { collection: 'finance_entries', field: 'matchId', target: M, filter: { matchId: { $ne: null } }, note: 'Multa vinculada a un partido borrado (se puede corregir desde 5B)' },
  { collection: 'sanctions', field: 'matchId', target: M, filter: { kind: 'MANUAL', start: null }, note: 'Sanción manual sin posición guardada cuyo partido se borró: deja de mostrarse' },
  { collection: 'sanctions', field: 'matchId', target: M, filter: { kind: 'AUTO' }, note: 'Ajuste de una sanción automática cuyo partido se borró' },
  { collection: 'sanctions', field: 'matchId', target: M, filter: { kind: 'MANUAL', start: { $ne: null } }, expected: true, note: 'Sanción manual que aplica desde su posición guardada («Partido eliminado»)' },
  { collection: 'discipline_log', field: 'matchId', target: M, filter: { matchId: { $ne: null } }, expected: true, note: 'Historial disciplinario' },
  { collection: 'match_logs', field: 'matchId', target: M, filter: { matchId: { $ne: null } }, expected: true, note: 'Historial del partido (conserva su copia)' },
  // Torneos (se borran en cascada en una transacción: cualquier resto es un problema)
  ...[
    'tournament_teams', 'team_memberships', 'matches', 'rounds', 'sanctions', 'discipline_log', 'match_logs', 'match_incidents', 'match_sheets', 'match_evidence',
    'finance_entries', 'registration_links', 'registration_requests', 'registration_drafts', 'tournament_members', 'tournament_invitations', 'removed_enrollments', 'player_blocks',
  ].map((collection): OrphanCheck => ({ collection, field: 'tournamentId', target: TO, filter: { tournamentId: { $ne: null } }, note: 'Resto de un torneo borrado' })),
];

export async function orphanReport(db: Db, checks = ORPHAN_CHECKS, sampleSize = 5): Promise<OrphanFinding[]> {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const out: OrphanFinding[] = [];
  for (const c of checks) {
    if (!existing.has(c.collection)) continue;
    const [row] = await db
      .collection(c.collection)
      .aggregate<{ missingIds: number; documents: string[] }>([
        ...(c.filter ? [{ $match: c.filter }] : []),
        ...(c.unwind ?? []).map((path) => ({ $unwind: `$${path}` })),
        { $match: { [c.field]: { $type: 'objectId' } } },
        { $group: { _id: `$${c.field}`, docs: { $addToSet: '$_id' } } },
        { $lookup: { from: c.target, localField: '_id', foreignField: '_id', as: 'hit', pipeline: [{ $project: { _id: 1 } }] } },
        { $match: { hit: { $size: 0 } } },
        { $unwind: '$docs' },
        { $group: { _id: null, ids: { $addToSet: '$_id' }, documents: { $addToSet: '$docs' } } },
        { $project: { _id: 0, missingIds: { $size: '$ids' }, documents: 1 } },
      ])
      .toArray();
    if (!row) continue;
    out.push({
      collection: c.collection,
      field: c.field,
      target: c.target,
      severity: c.expected ? 'expected' : 'problem',
      note: c.note,
      missingIds: row.missingIds,
      documents: row.documents.length,
      sample: row.documents.slice(0, sampleSize).map(String),
    });
  }
  return out;
}
