import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { MatchLogModule } from '../match-log/match-log.module.js';
import { MatchIncidentsModule } from '../match-incidents/match-incidents.module.js';
import { RefereesModule } from '../referees/referees.module.js';
import { DisciplineModule } from '../discipline/discipline.module.js';
import { MatchSheetController } from './match-sheet.controller.js';
import { MatchSheetService } from './match-sheet.service.js';
import { EvidenceService } from './evidence.service.js';

/** Ficha técnica digital del partido (Módulo 2, etapa 2D). */
@Module({
  imports: [
    MatchLogModule,
    MatchIncidentsModule,
    RefereesModule,
    DisciplineModule,
    MongooseModule.forFeature([
      Models.matchSheet,
      Models.matchEvidence,
      Models.match,
      Models.playerMatchStats,
      Models.team,
      Models.round,
      Models.player,
      Models.membership,
      Models.user,
      Models.matchIncident,
    ]),
  ],
  controllers: [MatchSheetController],
  providers: [MatchSheetService, EvidenceService],
})
export class MatchSheetModule {}
