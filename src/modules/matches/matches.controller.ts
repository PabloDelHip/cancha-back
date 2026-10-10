import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { MatchesService } from './matches.service.js';
import {
  CreateMatchDto,
  MatchQueryDto,
  ReschedulePreviewDto,
  SaveResultDto,
  UpdateMatchDto,
} from './dto/match.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';

@ApiTags('matches')
@Controller()
export class MatchesController {
  constructor(private readonly service: MatchesService) {}

  @Public()
  @Get('matches')
  @ApiOperation({
    summary:
      'Listar partidos (público, paginado; filtros tournamentId, teamId, status)',
  })
  findAll(@Query() query: MatchQueryDto) {
    return this.service.findAll(query);
  }

  @Public()
  @Get('matches/:id')
  @ApiOperation({ summary: 'Partido con sus estadísticas individuales' })
  @ApiNotFoundResponse({ description: 'Partido no encontrado' })
  findOne(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post('matches')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Programar partido en mi torneo' })
  @ApiForbiddenResponse({
    description: 'El torneo pertenece a otro organizador',
  })
  @ApiBadRequestResponse({
    description: 'Equipos iguales o no inscritos en el torneo',
  })
  create(@Body() dto: CreateMatchDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch('matches/:id')
  @ApiBearerAuth()
  @ApiForbiddenResponse({
    description: 'El partido es de un torneo de otro organizador',
  })
  update(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: UpdateMatchDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post('matches/:id/reschedule-preview')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Vista previa de una reprogramación: qué cancha y árbitros se conservan y cuáles habría que liberar',
    description: 'No escribe nada. Para aplicar, PATCH /matches/:id con `release` igual a `release` de esta respuesta.',
  })
  reschedulePreview(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: ReschedulePreviewDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.reschedulePreview(id, dto, user);
  }

  @Delete('matches/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiForbiddenResponse({
    description: 'El partido es de un torneo de otro organizador',
  })
  @ApiConflictResponse({
    description: 'El partido tiene resultado o estadísticas',
  })
  remove(
    @Param('id', IsObjectIdPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.remove(id, user);
  }

  @Put('matches/:id/result')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Capturar/corregir resultado y estadísticas',
    description:
      'Transaccional. Reemplaza todas las estadísticas del partido. Los goles individuales de un equipo no pueden superar su marcador.',
  })
  @ApiForbiddenResponse({
    description: 'El partido es de un torneo de otro organizador',
  })
  @ApiBadRequestResponse({
    description:
      'Goles individuales > marcador, jugador duplicado o de otro equipo…',
  })
  saveResult(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: SaveResultDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.saveResult(id, dto, user);
  }

  @Public()
  @Get('matches/:id/stats')
  @ApiOperation({ summary: 'Estadísticas individuales del partido' })
  stats(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.listStats(id);
  }

  @Public()
  @Get('tournaments/:id/matches')
  @ApiTags('tournaments')
  @ApiOperation({ summary: 'Todos los partidos del torneo' })
  byTournament(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.findByTournament(id);
  }
}
