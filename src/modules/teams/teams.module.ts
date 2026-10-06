import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { PlayersModule } from '../players/players.module.js';
import { TeamsController } from './teams.controller.js';
import { TeamsService } from './teams.service.js';
import { TeamAdminsController } from './team-admins.controller.js';
import { TeamAdminsService } from './team-admins.service.js';
import { TeamRosterController } from './team-roster.controller.js';
import { TeamRosterService } from './team-roster.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      Models.team,
      Models.tournamentTeam,
      Models.tournament,
      Models.membership,
      Models.match,
      Models.teamAdmin,
      Models.user,
      Models.teamRoster,
      Models.player,
    ]),
    PlayersModule,
  ],
  controllers: [TeamsController, TeamAdminsController, TeamRosterController],
  providers: [TeamsService, TeamAdminsService, TeamRosterService],
  exports: [TeamAdminsService, TeamRosterService],
})
export class TeamsModule {}
