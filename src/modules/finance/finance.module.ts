import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { FinanceController, TeamFinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';
import { FinanceReportsService } from './finance-reports.service.js';

/** Módulo 4 — pagos y adeudos (solo registro de movimientos). */
@Module({
  imports: [MongooseModule.forFeature([Models.financeEntry, Models.tournament, Models.tournamentTeam, Models.removedEnrollment, Models.team, Models.match, Models.membership, Models.user, Models.player])],
  controllers: [FinanceController, TeamFinanceController],
  providers: [FinanceService, FinanceReportsService],
  // 8A: los reportes reutilizan las cuentas (misma agregación y permiso que la pantalla).
  exports: [FinanceService],
})
export class FinanceModule {}
