import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { RegistrationService } from './registration.service.js';
import { RegistrationAdminController, RegistrationLinkController } from './registration.controller.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      Models.tournament,
      Models.registrationLink,
      Models.registrationRequest,
      Models.registrationDraft,
      Models.tournamentTeam,
      Models.team,
      Models.teamAdmin,
      Models.teamRoster,
      Models.player,
      Models.membership,
      Models.user,
    ]),
  ],
  controllers: [RegistrationAdminController, RegistrationLinkController],
  providers: [RegistrationService],
  exports: [RegistrationService],
})
export class RegistrationModule {}
