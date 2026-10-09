import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { MatchLogModule } from '../match-log/match-log.module.js';
import { RefereesController } from './referees.controller.js';
import { RefereesService } from './referees.service.js';

/** Árbitros y asignaciones (Módulo 2, etapa 2B). */
@Module({
  imports: [MatchLogModule, MongooseModule.forFeature([Models.referee, Models.match, Models.tournament, Models.team, Models.venue])],
  controllers: [RefereesController],
  providers: [RefereesService],
  exports: [RefereesService],
})
export class RefereesModule {}
