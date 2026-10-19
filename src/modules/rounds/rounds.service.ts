import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Round } from './schemas/round.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { RoundQueryDto, SaveRoundDto } from './dto/round.dto.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * Jornadas de un torneo. Se identifican por `(tournamentId, number)`, el mismo número que
 * guarda cada partido en `Match.round`. Escribir exige ser dueño y torneo no finalizado.
 */
@Injectable()
export class RoundsService {
  constructor(
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
  ) {}

  /** Jornadas de un torneo, en orden. Lectura pública. */
  async ofTournament(tournamentId: string, viewer: AuthUser | null = null) {
    // 5B (D4): un borrador solo lo ven su propietario y colaboradores (404 como si no existiera).
    await this.access.assertVisible(tournamentId, viewer);
    const rows = await this.rounds.find({ tournamentId: toObjectId(tournamentId) }).sort({ number: 1 }).lean();
    return serialize(rows);
  }

  async list(query: RoundQueryDto, viewer: AuthUser | null = null) {
    // 5B (D4): sin jornadas de borradores que el visitante no puede ver.
    const hidden = { $nin: await this.access.hiddenDrafts(viewer) };
    const filter = { tournamentId: query.tournamentId ? { ...hidden, $eq: toObjectId(query.tournamentId) } : hidden };
    const [items, total] = await Promise.all([
      this.rounds.find(filter).sort({ tournamentId: 1, number: 1 }).skip(skipFor(query)).limit(query.limit).lean(),
      this.rounds.countDocuments(filter),
    ]);
    return paginated(serialize(items), total, query);
  }

  /** Crea la jornada N o actualiza su nombre/fecha (idempotente). */
  async save(tournamentId: string, number: number, dto: SaveRoundDto, user: AuthUser) {
    assertNumber(number);
    await this.ownership.tournament(tournamentId, user, Permission.SCHEDULE);
    const set: Record<string, unknown> = {};
    if (dto.name !== undefined) set.name = dto.name?.trim() || null;
    if (dto.date !== undefined) set.date = dto.date || null;
    return this.ownership.inTournament(tournamentId, { user, permission: Permission.SCHEDULE }, async (session) => {
      const saved = await this.rounds
        .findOneAndUpdate(
          { tournamentId: toObjectId(tournamentId), number },
          { $set: set, $setOnInsert: { tournamentId: toObjectId(tournamentId), number } },
          { upsert: true, returnDocument: 'after', runValidators: true, session },
        )
        .lean();
      return serialize(saved!);
    });
  }

  /**
   * Solo se elimina una jornada vacía. Con partidos (jugados o no) se rechaza: nunca se
   * borran partidos ni resultados como efecto secundario.
   */
  async remove(tournamentId: string, number: number, user: AuthUser) {
    assertNumber(number);
    await this.ownership.tournament(tournamentId, user, Permission.SCHEDULE);
    const filter = { tournamentId: toObjectId(tournamentId), number };
    // Con el cerrojo: no se borra la jornada mientras se le programa un partido.
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.SCHEDULE }, async (session) => {
      if (!(await this.rounds.exists(filter).session(session)))
        throw new NotFoundException(`La jornada ${number} no existe`);
      const used = await this.matches
        .countDocuments({ tournamentId: filter.tournamentId, round: number })
        .session(session);
      if (used) {
        throw new ConflictException(
          `La jornada ${number} tiene ${used} partido(s): muévelos a otra jornada o elimínalos antes`,
        );
      }
      await this.rounds.deleteOne(filter, { session });
    });
  }
}

function assertNumber(number: number) {
  if (!Number.isInteger(number) || number < 1 || number > 99)
    throw new BadRequestException('El número de jornada debe estar entre 1 y 99');
}
