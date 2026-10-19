import { Body, Controller, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { FinanceService } from './finance.service.js';
import { CorrectFinanceEntryDto, CreateFinanceEntryDto, FinanceEntriesQueryDto, GenerateEnrollmentChargesDto, StatementQueryDto, VoidFinanceEntryDto } from './dto/finance.dto.js';
import { FinanceReportsService } from './finance-reports.service.js';

/** Envía un CSV como descarga (UTF-8 con BOM). */
function sendCsv(res: Response, file: { filename: string; content: string }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return file.content;
}

/** Módulo 4A–4D — finanzas del torneo (solo registro: Kisokar no procesa pagos). */
@ApiTags('finance')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Sin FINANCE_VIEW / FINANCE_MANAGE en el torneo' })
@Controller('tournaments/:tournamentId/finance')
export class FinanceController {
  constructor(
    private readonly service: FinanceService,
    private readonly reports: FinanceReportsService,
  ) {}

  @Get('accounts')
  @ApiOperation({ summary: '4A: cuentas del torneo con sus saldos (centavos). Inscritos y equipos con movimientos aunque ya no estén inscritos' })
  accounts(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @CurrentUser() user: AuthUser) {
    return this.service.accounts(tournamentId, user);
  }

  @Get('accounts/:teamId')
  @ApiOperation({ summary: '4A/4D: estado de cuenta paginado (por defecto la última página), totales y saldo inicial de la página' })
  account(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Param('teamId', IsObjectIdPipe) teamId: string, @Query() query: StatementQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.account(tournamentId, teamId, query, user);
  }

  @Get('accounts/:teamId/fine-players')
  @ApiOperation({ summary: '4D: jugadores que se pueden vincular a una multa (actuales e históricos, también de equipos quitados)' })
  finePlayers(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Param('teamId', IsObjectIdPipe) teamId: string, @CurrentUser() user: AuthUser) {
    return this.service.finePlayers(tournamentId, teamId, user);
  }

  @Get('entries')
  @ApiOperation({ summary: '4D: movimientos del torneo con filtros (equipo, tipo, método, periodo, estado), paginados' })
  entries(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Query() query: FinanceEntriesQueryDto, @CurrentUser() user: AuthUser) {
    return this.reports.list(tournamentId, query, user);
  }

  @Get('export/entries.csv')
  @ApiOperation({ summary: '4D: CSV de movimientos con los mismos filtros (UTF-8 con BOM, protegido contra fórmulas)' })
  async entriesCsv(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Query() query: FinanceEntriesQueryDto, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return sendCsv(res, await this.reports.entriesCsv(tournamentId, query, user));
  }

  @Get('export/balances.csv')
  @ApiOperation({ summary: '4D: CSV de saldos por equipo (los mismos de la pantalla) con fila TOTAL' })
  async balancesCsv(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return sendCsv(res, await this.reports.balancesCsv(tournamentId, user));
  }

  @Post('entries/:entryId/void')
  @HttpCode(200)
  @ApiOperation({ summary: '4D: anular un movimiento con motivo (idempotente por requestId)' })
  @ApiConflictResponse({ description: 'ENTRY_ALREADY_VOIDED, VOID_BREAKS_LEDGER o CREDIT_CONFIRMATION_REQUIRED' })
  voidEntry(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Param('entryId', IsObjectIdPipe) entryId: string, @Body() dto: VoidFinanceEntryDto, @CurrentUser() user: AuthUser) {
    return this.service.voidEntry(tournamentId, entryId, dto, user);
  }

  @Post('entries/:entryId/correct')
  @ApiOperation({ summary: '4D: corregir = anular y registrar el reemplazo enlazado, en una transacción (idempotente por requestId)' })
  @ApiConflictResponse({ description: 'ENTRY_ALREADY_VOIDED, VOID_BREAKS_LEDGER, CREDIT_CONFIRMATION_REQUIRED, DISCOUNT_EXCEEDS_BALANCE, REFUND_EXCEEDS_CREDIT o IDEMPOTENCY_KEY_REUSED' })
  correct(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Param('entryId', IsObjectIdPipe) entryId: string, @Body() dto: CorrectFinanceEntryDto, @CurrentUser() user: AuthUser) {
    return this.service.correct(tournamentId, entryId, dto, user);
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

/** 4C (F3b) — estado de cuenta del equipo en solo lectura (propietario y delegados del equipo). */
@ApiTags('finance')
@ApiBearerAuth()
@Controller('teams/:teamId/finance')
export class TeamFinanceController {
  constructor(private readonly service: FinanceService) {}

  @Get()
  @ApiOperation({ summary: '4C: estados de cuenta del equipo por torneo, solo lectura y sin notas internas ni autores' })
  @ApiForbiddenResponse({ description: 'Solo el OWNER o un MANAGER del equipo' })
  statements(@Param('teamId', IsObjectIdPipe) teamId: string, @CurrentUser() user: AuthUser) {
    return this.service.teamStatements(teamId, user);
  }

  @Get(':tournamentId')
  @ApiOperation({ summary: '4D: página del estado de cuenta del equipo en un torneo (solo lectura, sin datos internos)' })
  @ApiForbiddenResponse({ description: 'Solo el OWNER o un MANAGER del equipo' })
  statement(@Param('teamId', IsObjectIdPipe) teamId: string, @Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Query() query: StatementQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.teamStatement(teamId, tournamentId, query, user);
  }
}
