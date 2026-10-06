import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { RoundsController } from './rounds.controller.js';
import { RoundsService } from './rounds.service.js';
import { ScheduleService } from './schedule.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      Models.round,
      Models.match,
      Models.playerMatchStats,
      Models.tournament,
      Models.tournamentTeam,
      Models.team,
    ]),
  ],
  controllers: [RoundsController],
  providers: [RoundsService, ScheduleService],
})
export class RoundsModule {}
