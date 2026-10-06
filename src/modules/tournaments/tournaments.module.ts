import { CompetitionModule } from '../competition/competition.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { TournamentsController } from './tournaments.controller.js';
import { TournamentsService } from './tournaments.service.js';

@Module({
  imports: [
    CompetitionModule,
    MongooseModule.forFeature([
      Models.tournament,
      Models.tournamentTeam,
      Models.team,
      Models.match,
      Models.membership,
      Models.round,
    ]),
  ],
  controllers: [TournamentsController],
  providers: [TournamentsService],
})
export class TournamentsModule {}
