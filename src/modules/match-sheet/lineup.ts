/**
 * Alineaciones y sustituciones de la ficha técnica (2D), sin base de datos.
 *
 * - Titulares y suplentes de un equipo; cada jugador una vez, dorsal único, a lo sumo un capitán.
 * - Sustituciones en orden de minuto (y de captura a igual minuto): sale alguien que está en la
 *   cancha y entra alguien de la alineación que no lo está. No hay un límite universal de cambios
 *   (ningún torneo lo configura hoy). Reingresar después de haber salido está permitido (cambios
 *   libres del fútbol amateur); lo que nunca pasa es entrar estando ya en la cancha.
 * - Participó = titular o suplente que ingresó. Un suplente que nunca ingresó NO participó.
 */
export interface LineupPlayer {
  playerId: string;
  jerseyNumber: number | null;
  starter: boolean;
  captain: boolean;
}
export interface Substitution {
  outPlayerId: string;
  inPlayerId: string;
  minute: number;
}

export interface Participation {
  participants: Set<string>;
  /** Minuto del primer ingreso de cada suplente que entró. */
  entered: Map<string, number>;
  /** Minuto de la última salida. */
  left: Map<string, number>;
}

/** Errores de la alineación de un equipo (vacío = válida) y su participación. */
export function checkLineup(players: LineupPlayer[], substitutions: Substitution[]): { errors: string[]; participation: Participation } {
  const errors: string[] = [];
  const ids = new Set<string>();
  const numbers = new Map<number, string>();
  for (const p of players) {
    if (ids.has(p.playerId)) errors.push(`El jugador ${p.playerId} aparece dos veces en la alineación`);
    ids.add(p.playerId);
    if (p.jerseyNumber !== null) {
      if (numbers.has(p.jerseyNumber)) errors.push(`El dorsal ${p.jerseyNumber} está repetido`);
      numbers.set(p.jerseyNumber, p.playerId);
    }
  }
  if (players.filter((p) => p.captain).length > 1) errors.push('Solo puede haber un capitán por equipo');

  const onField = new Set(players.filter((p) => p.starter).map((p) => p.playerId));
  const participants = new Set(onField);
  const entered = new Map<string, number>();
  const left = new Map<string, number>();
  const ordered = substitutions.map((s, i) => ({ ...s, i })).sort((a, b) => a.minute - b.minute || a.i - b.i);
  for (const s of ordered) {
    const at = `Sustitución del minuto ${s.minute}`;
    if (s.outPlayerId === s.inPlayerId) {
      errors.push(`${at}: sale y entra el mismo jugador`);
      continue;
    }
    if (!ids.has(s.outPlayerId) || !ids.has(s.inPlayerId)) {
      errors.push(`${at}: los dos jugadores deben estar en la alineación del equipo`);
      continue;
    }
    if (!onField.has(s.outPlayerId)) {
      errors.push(`${at}: el jugador que sale (${s.outPlayerId}) no está en la cancha`);
      continue;
    }
    if (onField.has(s.inPlayerId)) {
      errors.push(`${at}: el jugador que entra (${s.inPlayerId}) ya está en la cancha`);
      continue;
    }
    onField.delete(s.outPlayerId);
    onField.add(s.inPlayerId);
    left.set(s.outPlayerId, s.minute);
    if (!participants.has(s.inPlayerId)) entered.set(s.inPlayerId, s.minute);
    participants.add(s.inPlayerId);
  }
  return { errors, participation: { participants, entered, left } };
}

/**
 * Coherencia con las estadísticas capturadas (la fuente de "jugó"): quien participó según la
 * alineación debe estar como jugado y nadie fuera de ella puede figurar como jugado.
 */
export function participationMismatch(participants: Set<string>, played: Set<string>) {
  return {
    missing: [...participants].filter((id) => !played.has(id)),
    extra: [...played].filter((id) => !participants.has(id)),
  };
}

/** Participación de un equipo tal como se guarda (ids de Mongo a texto). */
export function participationOf(team: { players: { playerId: unknown; jerseyNumber: number | null; starter: boolean; captain: boolean }[]; substitutions: { outPlayerId: unknown; inPlayerId: unknown; minute: number }[] }) {
  return checkLineup(
    team.players.map((p) => ({ ...p, playerId: String(p.playerId) })),
    team.substitutions.map((s) => ({ outPlayerId: String(s.outPlayerId), inPlayerId: String(s.inPlayerId), minute: s.minute })),
  ).participation;
}
