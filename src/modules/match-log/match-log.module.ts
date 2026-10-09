import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { MatchLogController } from './match-log.controller.js';
import { MatchLogService } from './match-log.service.js';

/** Historial de partidos (Módulo 2, etapa 2C). */
@Module({
  imports: [MongooseModule.forFeature([Models.matchLog, Models.match, Models.team, Models.user, Models.referee])],
  controllers: [MatchLogController],
  providers: [MatchLogService],
  exports: [MatchLogService],
})
export class MatchLogModule {}
