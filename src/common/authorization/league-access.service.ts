import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { League } from '../../modules/leagues/schemas/league.schema.js';
import { User } from '../../modules/users/schemas/user.schema.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';
import { toObjectId } from '../utils/serialize.js';

const isDuplicateKey = (e: unknown) => e instanceof mongo.MongoServerError && e.code === 11000;

/**
 * Autoridad sobre ligas: un único dueño (League.organizerId), que es quien crea y administra sus
 * torneos. Todo torneo vive en una liga: si se crea sin indicarla (API antigua, pruebas), va a la
 * liga por defecto del organizador, que se crea una sola vez ("Liga de <nombre>").
 */
@Injectable()
export class LeagueAccessService {
  constructor(
    @InjectModel(League.name) private readonly leagues: Model<League>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  /** La liga, si existe y es del usuario (404 / 403). */
  async owned(leagueId: string | Types.ObjectId, user: AuthUser) {
    const league = await this.leagues.findById(leagueId).lean();
    if (!league) throw new NotFoundException('Liga no encontrada');
    if (league.organizerId.toHexString() !== user.id) throw new ForbiddenException('Esta liga es de otro organizador');
    return league;
  }

  /** Liga donde se crea un torneo: la indicada (si es suya) o su liga por defecto. */
  async forNewTournament(user: AuthUser, leagueId?: string | null) {
    return leagueId ? (await this.owned(leagueId, user))._id : this.defaultLeagueId(toObjectId(user.id));
  }

  /** Liga por defecto del organizador (se crea la primera vez; segura ante carreras por índice único). */
  async defaultLeagueId(organizerId: Types.ObjectId, session: ClientSession | null = null): Promise<Types.ObjectId> {
    const found = await this.leagues.findOne({ organizerId, isDefault: true }).select('_id').session(session).lean();
    if (found) return found._id;
    const user = await this.users.findById(organizerId).select('firstName lastName').session(session).lean();
    const name = user ? `Liga de ${user.firstName} ${user.lastName}`.trim() : 'Mi liga';
    try {
      const [created] = await this.leagues.create([{ name, organizerId, isDefault: true }], { session });
      return created._id;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      return (await this.leagues.findOne({ organizerId, isDefault: true }).select('_id').session(session).lean())!._id;
    }
  }
}
