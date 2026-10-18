import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { FinanceService } from './finance.service.js';
import { CreateFinanceEntryDto, GenerateEnrollmentChargesDto } from './dto/finance.dto.js';

/** Módulo 4A/4B — finanzas del torneo (solo registro: Kisokar no procesa pagos). */
@ApiTags('finance')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Sin FINANCE_VIEW / FINANCE_MANAGE en el torneo' })
@Controller('tournaments/:tournamentId/finance')
export class FinanceController {
  constructor(private readonly service: FinanceService) {}

  @Get('accounts')
  @ApiOperation({ summary: '4A: cuentas del torneo con sus saldos (centavos). Inscritos y equipos con movimientos aunque ya no estén inscritos' })
  accounts(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @CurrentUser() user: AuthUser) {
    return this.service.accounts(tournamentId, user);
  }

  @Get('accounts/:teamId')
  @ApiOperation({ summary: '4A: movimientos de la cuenta de un equipo y sus totales' })
  account(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Param('teamId', IsObjectIdPipe) teamId: string, @CurrentUser() user: AuthUser) {
    return this.service.account(tournamentId, teamId, user);
  }

  @Post('entries')
  @ApiOperation({ summary: '4A/4B: registrar un cargo (también multa), pago/abono, descuento o devolución (idempotente por requestId)' })
  @ApiConflictResponse({ description: 'PAYMENT_EXCEEDS_BALANCE, DISCOUNT_EXCEEDS_BALANCE, REFUND_EXCEEDS_CREDIT, FINE_MATCH_INVALID, FINE_PLAYER_INVALID, IDEMPOTENCY_KEY_REUSED o TEAM_NOT_IN_TOURNAMENT' })
  create(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Body() dto: CreateFinanceEntryDto, @CurrentUser() user: AuthUser) {
    return this.service.create(tournamentId, dto, user);
  }

  @Post('enrollment-charges')
  @HttpCode(200)
  @ApiOperation({ summary: '4B: generar los cargos de inscripción que falten (cuota única del torneo; idempotente por equipo)' })
  @ApiConflictResponse({ description: 'NO_ENROLLMENT_FEE' })
  generateEnrollmentCharges(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Body() dto: GenerateEnrollmentChargesDto, @CurrentUser() user: AuthUser) {
    return this.service.generateEnrollmentCharges(tournamentId, dto, user);
  }
}
