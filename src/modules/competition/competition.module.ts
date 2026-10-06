import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { CompetitionController } from './competition.controller.js';
import { CompetitionService } from './competition.service.js';

/** Formatos, fases, grupos y bracket (Etapa 5.5). */
@Module({
  imports: [MongooseModule.forFeature([Models.tournament, Models.tournamentTeam, Models.match, Models.round, Models.team, Models.playerMatchStats])],
  controllers: [CompetitionController],
  providers: [CompetitionService],
  exports: [CompetitionService],
})
export class CompetitionModule {}
