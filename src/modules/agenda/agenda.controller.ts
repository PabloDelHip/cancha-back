import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { AgendaService } from './agenda.service.js';
import { AgendaOptionsQueryDto, AgendaQueryDto } from './dto/agenda.dto.js';

/** Agenda global de partidos (Módulo 2C-3). Solo lectura. */
@ApiTags('agenda')
@ApiBearerAuth()
@Controller('agenda')
export class AgendaController {
  constructor(private readonly service: AgendaService) {}

  @Get()
  @ApiOperation({
    summary: 'Partidos de mis torneos y colaboraciones activas, en orden cronológico (paginado)',
    description: 'Torneos finalizados excluidos salvo includeFinished=true. Filtros combinables. `tournaments` trae mi rol y permisos por torneo.',
  })
  @ApiNotFoundResponse({ description: 'Torneo, sede, cancha o árbitro fuera de mi alcance' })
  list(@Query() query: AgendaQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.list(user, query);
  }

  @Get('options')
  @ApiOperation({ summary: 'Opciones de los filtros: torneos, sedes/canchas y árbitros a mi alcance (sin contacto)' })
  options(@Query() query: AgendaOptionsQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.options(user, !!query.includeFinished);
  }
}
