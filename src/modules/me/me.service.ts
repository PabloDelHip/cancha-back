import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TeamAdmin } from '../teams/schemas/team-admin.schema.js';
import { TeamAdminRole, TeamAdminStatus } from '../../common/enums/index.js';
import { OrganizerAccessService } from '../../common/authorization/organizer-access.service.js';
import { RegistrationService } from '../registration/registration.service.js';
import { toObjectId } from '../../common/utils/serialize.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { CreateTeamDto } from '../teams/dto/team.dto.js';

/**
 * Lo que el panel necesita saber de la cuenta para mostrar SOLO lo que le sirve, a partir de sus
 * relaciones reales (nunca de User.role): si puede organizar torneos, qué equipos administra y qué
 * inscripciones tiene a medias o esperando respuesta.
 */
@Injectable()
export class MeService {
  constructor(
    @InjectModel(TeamAdmin.name) private readonly admins: Model<TeamAdmin>,
    private readonly organizers: OrganizerAccessService,
    private readonly registration: RegistrationService,
  ) {}

  async home(user: AuthUser) {
    const [organizer, roles, registrations] = await Promise.all([
      this.organizers.status(user.id),
      this.admins.aggregate<{ _id: TeamAdminRole; n: number }>([
        { $match: { userId: toObjectId(user.id), status: TeamAdminStatus.ACTIVE } },
        { $group: { _id: '$role', n: { $sum: 1 } } },
      ]),
      this.registration.homeSummary(user),
    ]);
    const owner = roles.find((r) => r._id === TeamAdminRole.OWNER)?.n ?? 0;
    const manager = roles.find((r) => r._id === TeamAdminRole.MANAGER)?.n ?? 0;
    return {
      organizer: { canOrganize: organizer.canOrganize, enabled: organizer.enabled, tournaments: organizer.organizes },
      teams: { total: owner + manager, owner, manager },
      registrations,
    };
  }

  enableOrganizer(user: AuthUser) {
    return this.organizers.enable(user);
  }

  createTeam(dto: CreateTeamDto, user: AuthUser) {
    return this.registration.createOwnedTeam(dto, user);
  }

  cancelDraft(tournamentId: string, user: AuthUser) {
    return this.registration.deleteDraft(tournamentId, user);
  }
}
