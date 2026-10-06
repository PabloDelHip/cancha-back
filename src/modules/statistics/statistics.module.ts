import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { StatisticsController } from './statistics.controller.js';
import { StatisticsService } from './statistics.service.js';
import { PlayerProfileService } from './player-profile.service.js';
import { TeamProfileService } from './team-profile.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      Models.match,
      Models.playerMatchStats,
      Models.tournament,
      Models.tournamentTeam,
      Models.team,
      Models.player,
      Models.membership,
      Models.teamRoster,
    ]),
  ],
  controllers: [StatisticsController],
  providers: [StatisticsService, PlayerProfileService, TeamProfileService],
})
export class StatisticsModule {}
