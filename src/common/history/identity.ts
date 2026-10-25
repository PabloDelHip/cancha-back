/**
 * 10C — nombres históricos de un torneo finalizado (funciones puras). La foto se toma al cerrar
 * (TournamentIdentityService.capture) y estas funciones la SOBREPONEN a lo que hoy se lee en vivo:
 * solo cambian textos, escudo y colores; ids, resultados y estadísticas no se tocan.
 */
import type { TournamentIdentity } from '../../modules/tournaments/schemas/tournament-identity.schema.js';

export interface HistoricalTeam {
  name: string;
  shortName: string;
  logoUrl: string | null;
  colors: { primary: string; secondary: string };
}
export interface HistoricalPlayer {
  firstName: string;
  lastName: string;
  nickname: string | null;
}
export interface HistoricalNames {
  takenAt: Date;
  leagueName: string | null;
  teams: Map<string, HistoricalTeam>;
  players: Map<string, HistoricalPlayer>;
}

export function namesOf(identity: TournamentIdentity | null | undefined): HistoricalNames | null {
  if (!identity) return null;
  return {
    takenAt: identity.takenAt,
    leagueName: identity.leagueName ?? null,
    teams: new Map(
      (identity.teams ?? []).map((t) => [
        String(t.teamId),
        { name: t.name, shortName: t.shortName, logoUrl: t.logoUrl ?? null, colors: { primary: t.colors.primary, secondary: t.colors.secondary } },
      ]),
    ),
    players: new Map((identity.players ?? []).map((p) => [String(p.playerId), { firstName: p.firstName, lastName: p.lastName, nickname: p.nickname ?? null }])),
  };
}

/** El equipo con su nombre, abreviatura, escudo y colores del torneo (si la foto lo tiene). */
export function withTeamName<T extends { name: string }>(team: T, teamId: string, names: HistoricalNames | null | undefined): T {
  const h = names?.teams.get(teamId);
  if (!h) return team;
  const out = { ...team, name: h.name } as T & { shortName?: string; logoUrl?: string | null; colors?: unknown };
  if ('shortName' in team) out.shortName = h.shortName;
  if ('logoUrl' in team) out.logoUrl = h.logoUrl;
  if ('colors' in team) out.colors = { ...h.colors };
  return out;
}

/** El jugador con el nombre deportivo que tenía en el torneo (si la foto lo tiene). */
export function withPlayerName<T extends { firstName: string; lastName: string }>(player: T, playerId: string, names: HistoricalNames | null | undefined): T {
  const h = names?.players.get(playerId);
  if (!h) return player;
  const out = { ...player, firstName: h.firstName, lastName: h.lastName } as T & { nickname?: string | null };
  if ('nickname' in player) out.nickname = h.nickname;
  return out;
}

/** Tamaño aproximado (bytes BSON ≈ JSON) de una foto, para medir y documentar. */
export function identitySize(identity: unknown): number {
  return Buffer.byteLength(JSON.stringify(identity));
}

/** Un mapa id → equipo con los nombres del torneo aplicados (sin foto, el mismo mapa). */
export function teamMapWithNames<T extends { name: string }>(map: Map<string, T>, names: HistoricalNames | null | undefined): Map<string, T> {
  return names ? new Map([...map].map(([id, t]) => [id, withTeamName(t, id, names)])) : map;
}
/** Un mapa id → jugador con los nombres del torneo aplicados (sin foto, el mismo mapa). */
export function playerMapWithNames<T extends { firstName: string; lastName: string }>(map: Map<string, T>, names: HistoricalNames | null | undefined): Map<string, T> {
  return names ? new Map([...map].map(([id, p]) => [id, withPlayerName(p, id, names)])) : map;
}

/** Equipo de un partido o una participación en SU torneo: nombre histórico si lo hay, si no el actual. */
export type TeamIn<T> = (tournamentId: string, teamId: string) => T | null;
export function teamInWith<T extends { name: string }>(teams: Map<string, T>, names: Map<string, HistoricalNames>): TeamIn<T> {
  return (tournamentId, teamId) => ((t) => (t ? withTeamName(t, teamId, names.get(tournamentId)) : null))(teams.get(teamId));
}
