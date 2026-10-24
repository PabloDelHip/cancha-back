import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { CompetitionModule } from '../competition/competition.module.js';
import { DisciplineModule } from '../discipline/discipline.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/** Módulo 8 — reportes y exportaciones (solo lectura; reutiliza los servicios de cada módulo). */
@Module({
  imports: [
    MongooseModule.forFeature([
      Models.tournament,
      Models.tournamentTeam,
      Models.team,
      Models.match,
      Models.playerMatchStats,
      Models.player,
      Models.membership,
      Models.playerBlock,
      Models.round,
      Models.league,
      Models.financeEntry,
    ]),
    CompetitionModule,
    DisciplineModule,
    FinanceModule,
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
