import { ConflictException } from '@nestjs/common';
import type { ClientSession, Model, Types } from 'mongoose';
import type { TournamentTeam } from './schemas/tournament-team.schema.js';
import { toObjectId } from '../../common/utils/serialize.js';

/** 3D — equipos retirados del torneo (inscripción con `withdrawnAt`). */
export async function withdrawnTeamIds(enrollments: Model<TournamentTeam>, tournamentId: Types.ObjectId | string, session: ClientSession | null = null) {
  const rows = await enrollments.find({ tournamentId: toObjectId(tournamentId), withdrawnAt: { $ne: null } }).select('teamId').session(session).lean();
  return rows.map((r) => r.teamId.toHexString());
}

/** 409 TEAM_WITHDRAWN si alguno de los equipos se retiró: no se le programan ni reactivan partidos. */
export async function assertNotWithdrawn(enrollments: Model<TournamentTeam>, session: ClientSession, tournamentId: Types.ObjectId | string, teamIds: string[]) {
  const withdrawn = (await withdrawnTeamIds(enrollments, tournamentId, session)).filter((id) => teamIds.some((t) => t.toString() === id));
  if (!withdrawn.length) return;
  throw new ConflictException({
    statusCode: 409,
    error: 'TEAM_WITHDRAWN',
    message: 'Un equipo de este partido se retiró del torneo: no se le programan partidos nuevos ni se reactivan los cancelados. Reincorpóralo primero si corresponde.',
    teamIds: withdrawn,
  });
}
