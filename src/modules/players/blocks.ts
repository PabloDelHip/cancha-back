import { ConflictException } from '@nestjs/common';
import type { ClientSession, Model, Types } from 'mongoose';
import type { PlayerBlock } from './schemas/player-block.schema.js';
import { toObjectId } from '../../common/utils/serialize.js';

/** 3D — el bloqueo cubre la fecha: desde `since` (inclusive) hasta `until` (exclusive; null = vigente). */
export const blockedOn = (b: Pick<PlayerBlock, 'since' | 'until'>, date: string) => b.since <= date && (b.until === null || date < b.until);

/**
 * Jugadores (de `playerIds`) con un bloqueo administrativo del torneo que cubre `date`. Se llama
 * dentro de la transacción con el cerrojo del torneo: no se cruza con aplicar o levantar bloqueos.
 */
export async function blockedAmong(blocks: Model<PlayerBlock>, session: ClientSession | null, tournamentId: Types.ObjectId | string, playerIds: string[], date: string) {
  if (!playerIds.length) return [];
  const rows = await blocks
    .find({ tournamentId: toObjectId(tournamentId), playerId: { $in: playerIds.map(toObjectId) }, since: { $lte: date } })
    .select('playerId since until')
    .session(session)
    .lean();
  const hit = new Set(rows.filter((b) => blockedOn(b, date)).map((b) => b.playerId.toHexString()));
  return playerIds.filter((id) => hit.has(id));
}

/** 409 PLAYER_BLOCKED si alguno está bloqueado en esa fecha. Siempre bloquea (no hay modo aviso). */
export async function assertNotBlocked(
  blocks: Model<PlayerBlock>,
  session: ClientSession,
  tournamentId: Types.ObjectId | string,
  playerIds: string[],
  date: string,
  names: (ids: string[]) => Promise<string[]>,
  what = 'participar',
) {
  const blocked = await blockedAmong(blocks, session, tournamentId, playerIds, date);
  if (!blocked.length) return;
  throw new ConflictException({
    statusCode: 409,
    error: 'PLAYER_BLOCKED',
    message: `Bloqueo administrativo del torneo vigente el ${date}: ${(await names(blocked)).join(', ')} no puede${blocked.length > 1 ? 'n' : ''} ${what}. Lo levanta el organizador.`,
    playerIds: blocked,
  });
}
