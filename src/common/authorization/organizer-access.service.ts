import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '../../modules/users/schemas/user.schema.js';
import { Tournament } from '../../modules/tournaments/schemas/tournament.schema.js';
import { League } from '../../modules/leagues/schemas/league.schema.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';
import { toObjectId } from '../utils/serialize.js';

export const ORGANIZER_NOT_ENABLED = 'ORGANIZER_NOT_ENABLED';

/**
 * ¿Puede esta cuenta ORGANIZAR torneos? Sí si la activó ("Quiero organizar un torneo",
 * User.organizerEnabledAt) o si ya organiza alguno (Tournament.organizerId): nadie que ya organiza
 * pierde el acceso. Nunca se usa User.role (legacy). Administrar equipos es independiente
 * (TeamAdmin / TeamAccessService): una cuenta puede tener las dos capacidades.
 */
@Injectable()
export class OrganizerAccessService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(League.name) private readonly leagues: Model<League>,
  ) {}

  async status(userId: string) {
    const id = toObjectId(userId);
    const [user, organizes, leagues] = await Promise.all([
      this.users.findById(id).select('organizerEnabledAt').lean(),
      this.tournaments.countDocuments({ organizerId: id }),
      this.leagues.countDocuments({ organizerId: id }),
    ]);
    const enabled = !!user?.organizerEnabledAt;
    // Tener una liga también es organizar (aunque aún no tenga torneos).
    return { enabled, organizes, leagues, canOrganize: enabled || organizes > 0 || leagues > 0 };
  }

  async requireOrganizer(user: AuthUser) {
    if (!(await this.status(user.id)).canOrganize) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: ORGANIZER_NOT_ENABLED,
        message: 'Para crear torneos activa «Quiero organizar un torneo» en tu panel.',
      });
    }
  }

  /** "Quiero organizar un torneo": idempotente (conserva la fecha de la primera activación). */
  async enable(user: AuthUser) {
    await this.users.updateOne({ _id: toObjectId(user.id), organizerEnabledAt: null }, { $set: { organizerEnabledAt: new Date() } });
    return this.status(user.id);
  }
}
