import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { SchedulingService } from './scheduling.service.js';
import { SchedulingCheckDto, SchedulingPreviewDto, TeamSchedulingDto, UpdateTournamentSchedulingDto } from './dto/scheduling.dto.js';

/** 6A — restricciones de calendario del torneo (panel del organizador; nada es público). */
@ApiTags('tournaments')
@ApiBearerAuth()
@Controller('tournaments/:id/scheduling')
export class SchedulingController {
  constructor(private readonly service: SchedulingService) {}

  @Get()
  @ApiOperation({ summary: 'Restricciones de calendario, por equipo, y conflictos de los partidos programados' })
  view(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.view(id, user);
  }

  @Put()
  @ApiOperation({
    summary: 'Configurar las restricciones del torneo (permiso SCHEDULE)',
    description: 'No modifica partidos: la respuesta incluye los programados que quedarían en conflicto.',
  })
  @ApiForbiddenResponse({ description: 'Sin permiso de programar en el torneo' })
  @ApiConflictResponse({ description: 'Torneo finalizado, o una duración nueva haría chocar partidos con cancha' })
  update(@Param('id', IsObjectIdPipe) id: string, @Body() dto: UpdateTournamentSchedulingDto, @CurrentUser() user: AuthUser) {
    return this.service.updateTournament(id, dto, user);
  }

  @Put('teams/:teamId')
  @ApiOperation({ summary: 'Configurar las restricciones de un equipo en este torneo (reemplazo completo)' })
  updateTeam(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('teamId', IsObjectIdPipe) teamId: string,
    @Body() dto: TeamSchedulingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.updateTeam(id, teamId, dto, user);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Conflictos que tendrían los partidos programados con otra configuración (no guarda nada)' })
  preview(@Param('id', IsObjectIdPipe) id: string, @Body() dto: SchedulingPreviewDto, @CurrentUser() user: AuthUser) {
    return this.service.preview(id, dto, user);
  }

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revisar un partido propuesto: errores (bloquean) y avisos (preferencias)' })
  check(@Param('id', IsObjectIdPipe) id: string, @Body() dto: SchedulingCheckDto, @CurrentUser() user: AuthUser) {
    return this.service.check(id, dto, user);
  }
}
