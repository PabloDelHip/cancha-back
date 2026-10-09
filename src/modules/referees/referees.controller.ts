import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RefereesService } from './referees.service.js';
import { AssignRefereeDto, CreateRefereeDto, RefereeAbsenceDto, UpdateRefereeDto } from './dto/referee.dto.js';

/** Árbitros del organizador y sus asignaciones a partidos (Módulo 2B). */
@ApiTags('referees')
@ApiBearerAuth()
@Controller()
export class RefereesController {
  constructor(private readonly service: RefereesService) {}

  @Get('referees')
  @ApiOperation({ summary: 'Mis árbitros (con teléfono y correo: solo el organizador los ve)' })
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user);
  }

  @Post('referees')
  @ApiOperation({ summary: 'Registrar un árbitro' })
  create(@Body() dto: CreateRefereeDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch('referees/:id')
  @ApiOperation({ summary: 'Editar, activar/desactivar o configurar la disponibilidad de un árbitro' })
  @ApiConflictResponse({ description: 'Desactivar con partidos asignados pendientes' })
  update(@Param('id', IsObjectIdPipe) id: string, @Body() dto: UpdateRefereeDto, @CurrentUser() user: AuthUser) {
    return this.service.update(id, dto, user);
  }

  @Delete('referees/:id')
  @ApiOperation({ summary: 'Eliminar un árbitro (se archiva si tiene partidos)' })
  remove(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, user);
  }

  @Get('referees/:id/matches')
  @ApiOperation({ summary: 'Historial de partidos asignados (con ausencias y sustituciones)' })
  history(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.history(id, user);
  }

  @Get('matches/:id/referees')
  @ApiOperation({ summary: 'Árbitros asignados al partido (vista del organizador)' })
  assigned(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.assigned(id, user);
  }

  @Get('matches/:id/referee-options')
  @ApiOperation({ summary: 'Mis árbitros activos con sus conflictos (bloquean) y avisos (no bloquean) para este partido' })
  options(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.options(id, user);
  }

  @Post('matches/:id/referees')
  @ApiOperation({ summary: 'Asignar un árbitro a un rol del partido' })
  @ApiConflictResponse({ description: 'Rol ocupado, árbitro con otro rol o con otro partido a la misma hora (REFEREE_CONFLICT)' })
  assign(@Param('id', IsObjectIdPipe) id: string, @Body() dto: AssignRefereeDto, @CurrentUser() user: AuthUser) {
    return this.service.assign(id, dto, user);
  }

  @Delete('matches/:id/referees/:assignmentId')
  @ApiOperation({ summary: 'Quitar una asignación sin historia (las ausencias y sustituciones se conservan)' })
  unassign(@Param('id', IsObjectIdPipe) id: string, @Param('assignmentId', IsObjectIdPipe) assignmentId: string, @CurrentUser() user: AuthUser) {
    return this.service.unassign(id, assignmentId, user);
  }

  @Post('matches/:id/referees/:assignmentId/absence')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar que el árbitro no se presentó (y, opcionalmente, su sustituto)' })
  absence(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('assignmentId', IsObjectIdPipe) assignmentId: string,
    @Body() dto: RefereeAbsenceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.absence(id, assignmentId, dto, user);
  }
}
