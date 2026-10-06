import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { CompetitionModule } from '../competition/competition.module.js';
import { LeaguesController } from './leagues.controller.js';
import { LeaguesService } from './leagues.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([Models.league, Models.tournament, Models.tournamentTeam, Models.match, Models.playerMatchStats, Models.player, Models.team]),
    CompetitionModule,
  ],
  controllers: [LeaguesController],
  providers: [LeaguesService],
})
export class LeaguesModule {}
