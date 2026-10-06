import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RoundsService } from './rounds.service.js';
import { ScheduleService } from './schedule.service.js';
import { GenerateScheduleDto, RoundQueryDto, SaveRoundDto } from './dto/round.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';

@ApiTags('rounds')
@Controller()
export class RoundsController {
  constructor(
    private readonly service: RoundsService,
    private readonly schedule: ScheduleService,
  ) {}

  @Public()
  @Get('rounds')
  @ApiOperation({ summary: 'Listar jornadas (paginado; filtro tournamentId)' })
  list(@Query() query: RoundQueryDto) {
    return this.service.list(query);
  }

  @Public()
  @Get('tournaments/:id/rounds')
  @ApiTags('tournaments')
  @ApiOperation({ summary: 'Jornadas del torneo, en orden' })
  ofTournament(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.ofTournament(id);
  }

  @Put('tournaments/:id/rounds/:number')
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear la jornada N o cambiar su nombre/fecha (idempotente)' })
  @ApiForbiddenResponse({ description: 'El torneo pertenece a otro organizador' })
  @ApiConflictResponse({ description: 'El torneo está finalizado' })
  save(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('number', ParseIntPipe) number: number,
    @Body() dto: SaveRoundDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.save(id, number, dto, user);
  }

  @Delete('tournaments/:id/rounds/:number')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Eliminar una jornada vacía' })
  @ApiConflictResponse({ description: 'La jornada tiene partidos o el torneo está finalizado' })
  remove(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('number', ParseIntPipe) number: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.remove(id, number, user);
  }

  @Post('tournaments/:id/schedule')
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Generar el calendario de liga (una vuelta o ida y vuelta)',
    description:
      'Crea jornadas y partidos con los equipos inscritos, en una transacción. 409 si hay partidos jugados/en juego, ' +
      'o si hay partidos programados sin replaceExisting: true.',
  })
  @ApiForbiddenResponse({ description: 'El torneo pertenece a otro organizador' })
  @ApiConflictResponse({ description: 'Calendario con historia, sin confirmación de reemplazo o torneo finalizado' })
  generate(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: GenerateScheduleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.schedule.generate(id, dto, user);
  }
}
