import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';

/** Módulo 4 — pagos y adeudos (solo registro de movimientos). */
@Module({
  imports: [MongooseModule.forFeature([Models.financeEntry, Models.tournament, Models.tournamentTeam, Models.removedEnrollment, Models.team, Models.match, Models.membership, Models.user])],
  controllers: [FinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}
