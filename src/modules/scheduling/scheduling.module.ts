import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { MatchLogModule } from '../match-log/match-log.module.js';
import { RefereesModule } from '../referees/referees.module.js';
import { VenuesModule } from '../venues/venues.module.js';
import { SchedulingController } from './scheduling.controller.js';
import { SchedulingService } from './scheduling.service.js';

/** Restricciones de calendario (Módulo 6, etapa 6A). */
@Module({
  imports: [VenuesModule, RefereesModule, MatchLogModule, MongooseModule.forFeature([Models.match, Models.tournament, Models.tournamentTeam, Models.team, Models.venue, Models.user])],
  controllers: [SchedulingController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
