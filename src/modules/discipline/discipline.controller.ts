import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { DisciplineService } from './discipline.service.js';
import { CreateSanctionDto, HistoryQueryDto, JustificationDto, UpdateDisciplineRulesDto, UpdateSanctionDto } from './dto/discipline.dto.js';

/** Control disciplinario: solo el organizador del torneo (lectura también en torneos finalizados). */
@ApiTags('discipline')
@ApiBearerAuth()
@Controller()
export class DisciplineController {
  constructor(private readonly service: DisciplineService) {}

  @Get('tournaments/:id/discipline')
  @ApiOperation({
    summary: 'Reglamento, sanciones, tarjetas acumuladas e incidencias del torneo',
    description: 'Las sanciones automáticas se calculan con las tarjetas y el calendario actuales; `ref` identifica cada sanción.',
  })
  overview(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.overview(id, user);
  }

  @Get('tournaments/:id/discipline/history')
  @ApiOperation({ summary: 'Historial disciplinario (reglamento, sanciones e incidencias)' })
  history(@Param('id', IsObjectIdPipe) id: string, @Query() query: HistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.history(id, query, user);
  }

  @Put('tournaments/:id/discipline/rules')
  @ApiOperation({ summary: 'Configurar el reglamento disciplinario' })
  @ApiConflictResponse({ description: 'Torneo finalizado' })
  updateRules(@Param('id', IsObjectIdPipe) id: string, @Body() dto: UpdateDisciplineRulesDto, @CurrentUser() user: AuthUser) {
    return this.service.updateRules(id, dto, user);
  }

  @Post('tournaments/:id/discipline/sanctions')
  @ApiOperation({ summary: 'Registrar una sanción manual' })
  @ApiConflictResponse({ description: 'Torneo sin iniciar o finalizado' })
  create(@Param('id', IsObjectIdPipe) id: string, @Body() dto: CreateSanctionDto, @CurrentUser() user: AuthUser) {
    return this.service.create(id, dto, user);
  }

  @Patch('tournaments/:id/discipline/sanctions/:ref')
  @ApiOperation({ summary: 'Corregir una sanción (manual: duración, motivo o partido; automática: duración)' })
  update(@Param('id', IsObjectIdPipe) id: string, @Param('ref') ref: string, @Body() dto: UpdateSanctionDto, @CurrentUser() user: AuthUser) {
    return this.service.update(id, ref, dto, user);
  }

  @Post('tournaments/:id/discipline/sanctions/:ref/annul')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular una sanción (con justificación)' })
  annul(@Param('id', IsObjectIdPipe) id: string, @Param('ref') ref: string, @Body() dto: JustificationDto, @CurrentUser() user: AuthUser) {
    return this.service.annul(id, ref, dto.justification, user);
  }

  @Post('tournaments/:id/discipline/sanctions/:ref/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivar una sanción anulada (con justificación)' })
  restore(@Param('id', IsObjectIdPipe) id: string, @Param('ref') ref: string, @Body() dto: JustificationDto, @CurrentUser() user: AuthUser) {
    return this.service.restore(id, ref, dto.justification, user);
  }

  @Get('matches/:id/eligibility')
  @ApiOperation({ summary: 'Jugadores suspendidos para un partido y modo de elegibilidad (avisar o bloquear)' })
  eligibility(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.eligibility(id, user);
  }
}
