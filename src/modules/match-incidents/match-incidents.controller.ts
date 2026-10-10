import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { MatchIncidentsService } from './match-incidents.service.js';
import { ReportIncidentDto, ResolveIncidentDto, VoidIncidentDto } from './dto/match-incident.dto.js';

/** Incidencias de un partido (Módulo 2C-2). Solo dentro del torneo: no son públicas. */
@ApiTags('match-incidents')
@ApiBearerAuth()
@Controller('matches/:id/incidents')
export class MatchIncidentsController {
  constructor(private readonly service: MatchIncidentsService) {}

  @Get()
  @ApiOperation({ summary: 'Incidencias del partido en orden cronológico (LOGS_VIEW)' })
  list(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.list(id, user);
  }

  @Post()
  @ApiOperation({ summary: 'Registrar una incidencia (INCIDENTS). SUSPENSION deja el partido SUSPENDED, pendiente de decisión' })
  @ApiConflictResponse({ description: 'Duplicada, o el partido no se puede suspender en su estado' })
  report(@Param('id', IsObjectIdPipe) id: string, @Body() dto: ReportIncidentDto, @CurrentUser() user: AuthUser) {
    return this.service.report(id, dto, user);
  }

  @Post(':incidentId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resolver una incidencia informativa con una nota (INCIDENTS)' })
  resolve(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('incidentId', IsObjectIdPipe) incidentId: string,
    @Body() dto: ResolveIncidentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.resolve(id, incidentId, dto, user);
  }

  @Post(':incidentId/void')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular una incidencia registrada por error (VOID, se conserva). Una suspensión pendiente devuelve el partido a su estado anterior' })
  void(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('incidentId', IsObjectIdPipe) incidentId: string,
    @Body() dto: VoidIncidentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.void(id, incidentId, dto, user);
  }
}
