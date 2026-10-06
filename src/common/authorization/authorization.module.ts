import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../models.js';
import { OwnershipService } from './ownership.service.js';
import { TeamAccessService } from './team-access.service.js';
import { OrganizerAccessService } from './organizer-access.service.js';

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
      Models.teamRoster,
      Models.membership,
    ]),
  ],
  providers: [OwnershipService, TeamAccessService, OrganizerAccessService],
  exports: [OwnershipService, TeamAccessService, OrganizerAccessService],
})
export class AuthorizationModule {}
