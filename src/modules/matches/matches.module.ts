import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { MatchesController } from './matches.controller.js';
import { MatchesService } from './matches.service.js';
import { MatchLogModule } from '../match-log/match-log.module.js';
import { RefereesModule } from '../referees/referees.module.js';
import { VenuesModule } from '../venues/venues.module.js';
import { DisciplineModule } from '../discipline/discipline.module.js';
import { CompetitionModule } from '../competition/competition.module.js';
import { MatchIncidentsModule } from '../match-incidents/match-incidents.module.js';

@Module({
  imports: [
    CompetitionModule,
    DisciplineModule,
    VenuesModule,
    RefereesModule,
    MatchLogModule,
    MatchIncidentsModule,
    MongooseModule.forFeature([
      Models.match,
      Models.playerMatchStats,
      Models.tournament,
      Models.tournamentTeam,
      Models.player,
      Models.membership,
      Models.round,
      Models.matchSheet,
    ]),
  ],
  controllers: [MatchesController],
  providers: [MatchesService],
})
export class MatchesModule {}
