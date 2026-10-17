import { ConflictException } from '@nestjs/common';
import type { ClientSession, Model, Types } from 'mongoose';
import { MatchLogAction, MatchStatus } from '../../common/enums/index.js';
import { Permission } from '../../common/authorization/permissions.js';
import type { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import type { MatchLogService } from '../match-log/match-log.service.js';
import type { Match } from '../matches/schemas/match.schema.js';
import type { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import type { MatchSheet } from '../match-sheet/schemas/match-sheet.schema.js';
import { participationOf } from '../match-sheet/lineup.js';
import { sameId, toObjectId } from '../../common/utils/serialize.js';

type MatchDoc = Match & { _id: Types.ObjectId };
export type Participant = { playerId: string; teamId: string };
export type SameDateConflict = { playerId: string; teamId: string; matchId: string };
type SameDateModels = { matches: Model<Match>; stats: Model<PlayerMatchStats>; sheets: Model<MatchSheet> };

/**
 * 3A — un jugador no participa con dos equipos del mismo torneo en una misma FECHA DEPORTIVA:
 * el mismo día o la misma jornada (`round`, p. ej. un partido pospuesto de esa jornada). Cuenta
 * la participación real en los OTROS partidos: estadísticas `played` o alineación de la ficha
 * (titular o suplente que ingresó). Se llama dentro de la transacción con el cerrojo del torneo,
 * así dos capturas simultáneas no se cuelan.
 */
export async function sameDateConflicts(
  models: SameDateModels,
  session: ClientSession,
  match: MatchDoc,
  candidates: Participant[],
): Promise<SameDateConflict[]> {
  // 3B: quien ya figuraba en ESTE partido con ese equipo se validó (o se corrigió) al registrarse.
  const registered = await registeredIn(models, session, match._id);
  const participants = candidates.filter((p) => !registered.has(participantKey(p.playerId, p.teamId)));
  const pairs = await sameDatePairs(models, session, match, match, participants);
  // Un conflicto por jugador basta para el 409.
  return pairs.filter((c, i) => pairs.findIndex((x) => x.playerId === c.playerId) === i);
}

/**
 * Todos los pares (jugador, otro partido) en que estos participantes ya jugaron con OTRO equipo del
 * torneo en la fecha deportiva `at` (día o jornada). `at` es la del partido, o la propuesta al
 * reprogramarlo (3B: comparar antes y después del cambio).
 */
export async function sameDatePairs(
  models: SameDateModels,
  session: ClientSession,
  match: Pick<MatchDoc, '_id' | 'tournamentId'>,
  at: { date: string; round: number },
  participants: Participant[],
): Promise<SameDateConflict[]> {
  if (!participants.length) return [];
  const others = await models.matches
    .find({ tournamentId: match.tournamentId, _id: { $ne: match._id }, status: { $ne: MatchStatus.CANCELLED }, $or: [{ date: at.date }, { round: at.round }] })
    .select('_id')
    .session(session)
    .lean();
  if (!others.length) return [];
  const ids = others.map((m) => m._id);
  const playerIds = participants.map((p) => toObjectId(p.playerId));
  const conflicts: SameDateConflict[] = [];
  const add = (playerId: string, teamId: Types.ObjectId, matchId: Types.ObjectId) => {
    const matchKey = matchId.toHexString();
    const mine = participants.find((p) => p.playerId === playerId && !sameId(teamId, p.teamId));
    if (mine && !conflicts.some((c) => c.playerId === playerId && c.matchId === matchKey)) {
      conflicts.push({ playerId, teamId: teamId.toHexString(), matchId: matchKey });
    }
  };
  const [stats, sheets] = await Promise.all([
    models.stats.find({ matchId: { $in: ids }, playerId: { $in: playerIds }, played: { $ne: false } }).select('playerId teamId matchId').session(session).lean(),
    models.sheets.find({ matchId: { $in: ids }, 'teams.players.playerId': { $in: playerIds } }).select('matchId teams').session(session).lean(),
  ]);
  for (const s of stats) add(s.playerId.toHexString(), s.teamId, s.matchId);
  for (const sheet of sheets) {
    for (const team of sheet.teams) {
      for (const id of participationOf(team).participants) add(id, team.teamId, sheet.matchId);
    }
  }
  return conflicts;
}

export const participantKey = (playerId: string, teamId: string | Types.ObjectId) => `${playerId}:${teamId.toString()}`;

/**
 * 3B — participación YA REGISTRADA en un partido (`participantKey`): estadísticas `played` y
 * alineación de la ficha (titulares y suplentes que ingresaron). Al corregir el partido no se
 * revalida: solo quien empieza a participar pasa por las reglas de elegibilidad. Así un cambio
 * posterior (una sanción derivada después, una corrección ya autorizada) no traba la historia.
 */
export async function registeredIn(
  models: Pick<SameDateModels, 'stats' | 'sheets'>,
  session: ClientSession,
  matchId: Types.ObjectId,
): Promise<Set<string>> {
  const [stats, sheet] = await Promise.all([
    models.stats.find({ matchId, played: { $ne: false } }).select('playerId teamId').session(session).lean(),
    models.sheets.findOne({ matchId }).select('teams').session(session).lean(),
  ]);
  const keys = new Set(stats.map((s) => participantKey(s.playerId.toHexString(), s.teamId)));
  for (const team of sheet?.teams ?? []) {
    for (const id of participationOf(team).participants) keys.add(participantKey(id, team.teamId));
  }
  return keys;
}

/**
 * Sin conflictos no hace nada. Con conflictos: 409 SAME_DATE_OTHER_TEAM, salvo corrección
 * administrativa explícita (`overrideReason`, permiso REGISTRATION_EXCEPTIONS) que queda en el
 * historial del partido (ELIGIBILITY_OVERRIDE).
 */
export async function enforceSameDate(
  deps: { access: TournamentAccessService; log: MatchLogService },
  session: ClientSession,
  match: MatchDoc,
  conflicts: SameDateConflict[],
  user: { id: string },
  overrideReason: string | null | undefined,
  names: (ids: string[]) => Promise<string[]>,
) {
  if (!conflicts.length) return;
  const reason = overrideReason?.trim() || null;
  if (!reason) {
    const who = await names(conflicts.map((c) => c.playerId));
    throw new ConflictException({
      statusCode: 409,
      error: 'SAME_DATE_OTHER_TEAM',
      message: `Ya participaron con otro equipo en la misma fecha deportiva (mismo día o misma jornada): ${who.join(', ')}. Un jugador no puede jugar con dos equipos del torneo en la misma fecha.`,
      conflicts,
    });
  }
  await deps.access.require(match.tournamentId, user.id, Permission.REGISTRATION_EXCEPTIONS, session);
  await deps.log.entry(session, { userId: user.id }, match, MatchLogAction.ELIGIBILITY_OVERRIDE, { sameDate: { from: null, to: conflicts } }, reason);
}
