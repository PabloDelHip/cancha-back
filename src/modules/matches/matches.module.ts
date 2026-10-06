import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { MatchesController } from './matches.controller.js';
import { MatchesService } from './matches.service.js';
import { CompetitionModule } from '../competition/competition.module.js';

@Module({
  imports: [
    CompetitionModule,
    MongooseModule.forFeature([
      Models.match,
      Models.playerMatchStats,
      Models.tournament,
      Models.tournamentTeam,
      Models.player,
      Models.membership,
      Models.round,
    ]),
  ],
  controllers: [MatchesController],
  providers: [MatchesService],
})
export class MatchesModule {}
