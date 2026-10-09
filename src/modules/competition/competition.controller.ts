import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { CompetitionService } from './competition.service.js';
import { AdvancePhaseDto, CreateTieDto } from './dto/advance.dto.js';

@ApiTags('tournaments')
@Controller('tournaments/:id')
export class CompetitionController {
  constructor(private readonly service: CompetitionService) {}

  @Public()
  @Get('structure')
  @ApiOperation({
    summary: 'Estructura de la competición (público)',
    description:
      'Fases del formato: tabla de liga, tablas por grupo con clasificados, cuadro eliminatorio (llaves, origen de cada lado, global, penales, ganador) y campeón derivado de los resultados.',
  })
  structure(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.structure(id);
  }

  @Post('phases/advance')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Generar la eliminatoria desde la tabla o los grupos terminados',
    description: 'Requiere la fase anterior completa y sin empates sin resolver (se pueden decidir con `tiebreaks`).',
  })
  @ApiConflictResponse({ description: 'Fase anterior incompleta, empate sin resolver o fase ya generada' })
  advance(@Param('id', IsObjectIdPipe) id: string, @Body() dto: AdvancePhaseDto, @CurrentUser() user: AuthUser) {
    return this.service.advance(id, dto, user);
  }

  @Post('phases/advance/preview')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Vista previa de la eliminatoria (no guarda nada)',
    description: 'Los cruces, quién pasa directo y las fechas que generaría `phases/advance` con el mismo cuerpo. El organizador decide si la usa.',
  })
  @ApiConflictResponse({ description: 'Fase anterior incompleta o empate sin resolver' })
  previewAdvance(@Param('id', IsObjectIdPipe) id: string, @Body() dto: AdvancePhaseDto, @CurrentUser() user: AuthUser) {
    return this.service.previewAdvance(id, dto, user);
  }

  @Post('phases/:phase/ties')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Agregar un cruce a un cuadro armado a mano',
    description: 'El organizador elige la ronda y los dos equipos; se crean sus partidos (único o ida y vuelta) con las fechas indicadas.',
  })
  @ApiConflictResponse({ description: 'Cuadro automático, ronda llena o equipo con cruce en esa ronda' })
  createTie(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('phase', ParseIntPipe) phase: number,
    @Body() dto: CreateTieDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.createTie(id, phase, dto, user);
  }

  @Delete('phases/:phase/ties/:round/:slot')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Quitar un cruce armado a mano (sin resultado) y sus partidos' })
  deleteTie(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('phase', ParseIntPipe) phase: number,
    @Param('round', ParseIntPipe) round: number,
    @Param('slot', ParseIntPipe) slot: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.deleteTie(id, phase, round, slot, user);
  }
}
