import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Res } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiForbiddenResponse, ApiNotFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { TeamRosterService } from './team-roster.service.js';
import { AddRosterPlayerDto, CreateRosterPlayerDto, RosterQueryDto } from './dto/team-roster.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * Plantilla GLOBAL del equipo (TeamRoster). Ruta explícita `global-roster` para no confundirla con
 * `GET /teams/:id/roster`, que es la plantilla en torneos (TeamMembership). Todo requiere ser
 * OWNER o MANAGER; la plantilla actual pública sale en GET /teams/:id/profile (`currentRoster`).
 */
@ApiTags('teams')
@ApiBearerAuth()
@Controller('teams/:id/global-roster')
export class TeamRosterController {
  constructor(private readonly service: TeamRosterService) {}

  @Get()
  @ApiOperation({ summary: 'Plantilla global (OWNER/MANAGER). ?status=active (defecto) | inactive | all' })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado' })
  list(@Param('id', IsObjectIdPipe) id: string, @Query() query: RosterQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.list(id, query.status ?? 'active', user);
  }

  @Post()
  @ApiOperation({ summary: 'Agregar un Player existente (OWNER/MANAGER). 201 alta · 200 ya estaba (idempotente)' })
  async add(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: AddRosterPlayerDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, period } = await this.service.add(id, dto.playerId, user);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return period;
  }

  @Post('players')
  @ApiOperation({
    summary: 'Crear un Player nuevo (sin cuenta) y agregarlo a la plantilla (OWNER/MANAGER). 201 creado · 200 reintento con el mismo requestId',
    description: 'El Player es global (aparece en GET /players). No crea participación en torneos ni estadísticas. Sin fusión por nombre: buscar antes con GET /players?search=.',
  })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado' })
  async createPlayer(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: CreateRosterPlayerDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, period } = await this.service.createAndAdd(id, dto, user);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return period;
  }

  @Delete(':playerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirar de la plantilla global (cierra el periodo; no toca torneos)' })
  remove(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('playerId', IsObjectIdPipe) playerId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.remove(id, playerId, user);
  }
}
