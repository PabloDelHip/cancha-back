import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../models.js';
import { OwnershipService } from './ownership.service.js';
import { TeamAccessService } from './team-access.service.js';
import { OrganizerAccessService } from './organizer-access.service.js';
import { LeagueAccessService } from './league-access.service.js';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      Models.tournament,
      Models.match,
      Models.team,
      Models.player,
      Models.teamAdmin,
      Models.user,
      Models.league,
      Models.teamRoster,
      Models.membership,
    ]),
  ],
  providers: [OwnershipService, TeamAccessService, OrganizerAccessService, LeagueAccessService],
  exports: [OwnershipService, TeamAccessService, OrganizerAccessService, LeagueAccessService],
})
export class AuthorizationModule {}
