import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MeService } from './me.service.js';
import { CreateTeamDto } from '../teams/dto/team.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';

/** La cuenta autenticada: su panel se adapta a sus capacidades reales. */
@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly service: MeService) {}

  @Get('home')
  @ApiOperation({
    summary: 'Resumen para el panel: puede organizar, equipos que administra, inscripciones incompletas y enviadas',
  })
  home(@CurrentUser() user: AuthUser) {
    return this.service.home(user);
  }

  @Post('organizer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '"Quiero organizar un torneo": activa la capacidad de organizar (idempotente)' })
  enableOrganizer(@CurrentUser() user: AuthUser) {
    return this.service.enableOrganizer(user);
  }

  @Post('teams')
  @ApiOperation({ summary: 'Crear MI equipo: quedas como su propietario (OWNER). No reclama equipos existentes.' })
  createTeam(@Body() dto: CreateTeamDto, @CurrentUser() user: AuthUser) {
    return this.service.createTeam(dto, user);
  }

  @Delete('registration-drafts/:tournamentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancelar mi inscripción incompleta en ese torneo (no borra equipos ni jugadores)' })
  cancelDraft(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @CurrentUser() user: AuthUser) {
    return this.service.cancelDraft(tournamentId, user);
  }
}
