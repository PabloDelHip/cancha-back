import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { MatchLogModule } from '../match-log/match-log.module.js';
import { CompetitionModule } from '../competition/competition.module.js';
import { MatchIncidentsController } from './match-incidents.controller.js';
import { MatchIncidentsService } from './match-incidents.service.js';

/** Incidencias de partidos y suspensiones (Módulo 2, etapa 2C-2). */
@Module({
  imports: [MatchLogModule, CompetitionModule, MongooseModule.forFeature([Models.matchIncident, Models.match, Models.user, Models.tournament])],
  controllers: [MatchIncidentsController],
  providers: [MatchIncidentsService],
  exports: [MatchIncidentsService],
})
export class MatchIncidentsModule {}
