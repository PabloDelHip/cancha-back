import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { VenuesService } from './venues.service.js';
import { CheckSlotQueryDto, CreateFieldDto, CreateVenueDto, UpdateFieldDto, UpdateVenueDto } from './dto/venue.dto.js';

/** Sedes del propietario de un torneo, para sus colaboradores con permiso de asignar (RBAC R3). */
@ApiTags('venues')
@ApiBearerAuth()
@Controller('tournaments/:id/venues')
export class TournamentVenuesController {
  constructor(private readonly service: VenuesService) {}

  @Get()
  @ApiOperation({ summary: 'Sedes y canchas del propietario del torneo (solo lectura; quien asigna canchas en él)' })
  list(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.forTournament(id, user);
  }
}

/** Sedes y canchas del organizador (reutilizables en todas sus ligas y torneos). */
@ApiTags('venues')
@ApiBearerAuth()
@Controller('venues')
export class VenuesController {
  constructor(private readonly service: VenuesService) {}

  @Get()
  @ApiOperation({ summary: 'Mis sedes con sus canchas y cuántos partidos usan cada una' })
  list(@CurrentUser() user: AuthUser) {
    return this.service.list(user);
  }

  @Get('check')
  @ApiOperation({
    summary: 'Revisar un horario en una cancha',
    description: 'Conflictos con partidos de cualquier torneo del organizador (bloquearían al guardar) y advertencias de disponibilidad (no bloquean).',
  })
  check(@Query() query: CheckSlotQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.check(query, user);
  }

  @Post()
  @ApiOperation({ summary: 'Registrar una sede (con canchas opcionales)' })
  create(@Body() dto: CreateVenueDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Editar o activar/desactivar una sede' })
  @ApiConflictResponse({ description: 'Desactivar con partidos pendientes o un margen que provoca solapes' })
  update(@Param('id', IsObjectIdPipe) id: string, @Body() dto: UpdateVenueDto, @CurrentUser() user: AuthUser) {
    return this.service.update(id, dto, user);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar una sede (se archiva si tiene partidos)' })
  remove(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, user);
  }

  @Post(':id/fields')
  @ApiOperation({ summary: 'Agregar una cancha' })
  addField(@Param('id', IsObjectIdPipe) id: string, @Body() dto: CreateFieldDto, @CurrentUser() user: AuthUser) {
    return this.service.addField(id, dto, user);
  }

  @Patch(':id/fields/:fieldId')
  @ApiOperation({ summary: 'Editar, activar/desactivar o configurar la disponibilidad de una cancha' })
  updateField(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('fieldId', IsObjectIdPipe) fieldId: string,
    @Body() dto: UpdateFieldDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.updateField(id, fieldId, dto, user);
  }

  @Delete(':id/fields/:fieldId')
  @ApiOperation({ summary: 'Eliminar una cancha (se archiva si tiene partidos)' })
  removeField(@Param('id', IsObjectIdPipe) id: string, @Param('fieldId', IsObjectIdPipe) fieldId: string, @CurrentUser() user: AuthUser) {
    return this.service.removeField(id, fieldId, user);
  }
}
