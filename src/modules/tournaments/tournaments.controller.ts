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
  UploadedFile,
  UseInterceptors,
  Query,
} from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { imageUploadOptions, type UploadedImage } from '../media/image-upload.js';
import { TournamentsService } from './tournaments.service.js';
import {
  CreateTournamentDto,
  EnrollmentQueryDto,
  FinishTournamentDto,
  TeamWithdrawalDto,
  TournamentQueryDto,
  UpdateTournamentDto,
} from './dto/tournament.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { CurrentUser, Viewer } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';

@ApiTags('tournaments')
@Controller()
export class TournamentsController {
  constructor(
    private readonly service: TournamentsService,
    private readonly access: TournamentAccessService,
  ) {}

  @Get('admin/tournaments/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Detalle del torneo para su organizador, incluido contacto privado' })
  findOwned(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.findOwned(id, user);
  }

  @Put('tournaments/:id/logo')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  setLogo(@Param('id', IsObjectIdPipe) id: string, @UploadedFile() file: UploadedImage | undefined, @CurrentUser() user: AuthUser) {
    return this.service.setLogo(id, file, user);
  }

  @Delete('tournaments/:id/logo')
  @ApiBearerAuth()
  removeLogo(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.removeLogo(id, user);
  }

  @Public()
  @Get('tournaments')
  @ApiOperation({
    summary: 'Listar torneos (público, paginado, filtro por estado)',
  })
  findAll(@Query() query: TournamentQueryDto, @Viewer() viewer: AuthUser | null) {
    return this.service.findAll(query, viewer);
  }

  @Get('admin/tournaments')
  @ApiTags('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mis torneos (organizador autenticado)' })
  @ApiUnauthorizedResponse({ description: 'Sin access token válido' })
  findMine(@CurrentUser() user: AuthUser, @Query() query: TournamentQueryDto) {
    return this.service.findMine(user, query);
  }

  @Public()
  @Get('tournaments/:id')
  @ApiNotFoundResponse({ description: 'Torneo no encontrado' })
  async findOne(@Param('id', IsObjectIdPipe) id: string, @Viewer() viewer: AuthUser | null) {
    await this.access.assertVisible(id, viewer);
    return this.service.findOne(id);
  }

  @Post('tournaments')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Crear torneo (el organizador es el usuario autenticado)',
  })
  create(@Body() dto: CreateTournamentDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch('tournaments/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Editar datos y configuración deportiva (no el estado)' })
  @ApiForbiddenResponse({
    description: 'El torneo pertenece a otro organizador',
  })
  @ApiConflictResponse({ description: 'El torneo está finalizado' })
  update(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: UpdateTournamentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Post('tournaments/:id/start')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Iniciar torneo (DRAFT → ACTIVE)' })
  @ApiForbiddenResponse({ description: 'El torneo pertenece a otro organizador' })
  @ApiConflictResponse({ description: 'El torneo no está en borrador' })
  start(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.start(id, user);
  }

  @Post('tournaments/:id/finish')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Finalizar torneo (ACTIVE → FINISHED, terminal)',
    description:
      'Desde entonces el torneo es historial inmutable: inscripciones, plantillas, jornadas, partidos, resultados y estadísticas responden 409. ' +
      'Con partidos sin jugar exige allowPendingMatches: true. Devuelve { tournament, summary }.',
  })
  @ApiForbiddenResponse({ description: 'El torneo pertenece a otro organizador' })
  @ApiConflictResponse({ description: 'No está en curso, o hay partidos pendientes sin confirmación' })
  finish(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: FinishTournamentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.finish(id, dto, user);
  }

  @Public()
  @Get('tournaments/:id/summary')
  @ApiOperation({ summary: 'Recuento de partidos por estado (total, finalizados, pendientes…)' })
  async summary(@Param('id', IsObjectIdPipe) id: string, @Viewer() viewer: AuthUser | null) {
    await this.access.assertVisible(id, viewer);
    return this.service.summary(id);
  }

  @Delete('tournaments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiForbiddenResponse({
    description: 'El torneo pertenece a otro organizador',
  })
  @ApiConflictResponse({ description: 'El torneo tiene partidos' })
  remove(
    @Param('id', IsObjectIdPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.remove(id, user);
  }

  @Public()
  @Get('tournaments/:id/teams')
  @ApiOperation({ summary: 'Equipos inscritos en el torneo' })
  async listTeams(@Param('id', IsObjectIdPipe) id: string, @Viewer() viewer: AuthUser | null) {
    await this.access.assertVisible(id, viewer);
    return this.service.listTeams(id);
  }

  @Post('tournaments/:tournamentId/teams/:teamId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Inscribir un equipo en mi torneo' })
  @ApiForbiddenResponse({
    description: 'El torneo pertenece a otro organizador',
  })
  @ApiConflictResponse({ description: 'El equipo ya está inscrito' })
  addTeam(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('teamId', IsObjectIdPipe) teamId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.addTeam(tournamentId, teamId, user);
  }

  @Delete('tournaments/:tournamentId/teams/:teamId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dar de baja un equipo sin partidos en mi torneo' })
  @ApiForbiddenResponse({
    description: 'El torneo pertenece a otro organizador',
  })
  removeTeam(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('teamId', IsObjectIdPipe) teamId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.removeTeam(tournamentId, teamId, user);
  }

  @Post('tournaments/:tournamentId/teams/:teamId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '3D: retirar un equipo con partidos (conserva resultados; cancela sus pendientes; cierra sus participaciones). Con motivo' })
  @ApiConflictResponse({ description: 'TEAM_HAS_NO_MATCHES, TEAM_ALREADY_WITHDRAWN, WITHDRAW_LIVE_MATCH o WITHDRAW_PENDING_KNOCKOUT' })
  withdrawTeam(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('teamId', IsObjectIdPipe) teamId: string,
    @Body() dto: TeamWithdrawalDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.withdrawTeam(tournamentId, teamId, dto.reason, user);
  }

  @Post('tournaments/:tournamentId/teams/:teamId/reinstate')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '3D: reincorporar un equipo retirado, con motivo (no restaura partidos ni participaciones)' })
  @ApiConflictResponse({ description: 'TEAM_NOT_WITHDRAWN o REINSTATE_PHASE_ADVANCED' })
  reinstateTeam(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('teamId', IsObjectIdPipe) teamId: string,
    @Body() dto: TeamWithdrawalDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.reinstateTeam(tournamentId, teamId, dto.reason, user);
  }

  @Public()
  @Get('tournament-teams')
  @ApiOperation({
    summary: 'Listar inscripciones (paginado; filtros tournamentId, teamId)',
  })
  listEnrollments(@Query() query: EnrollmentQueryDto, @Viewer() viewer: AuthUser | null) {
    return this.service.listEnrollments(query, viewer);
  }
}
