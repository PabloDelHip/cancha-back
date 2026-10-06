import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { RegistrationService } from './registration.service.js';
import { RegistrationRequestsQueryDto, RejectRegistrationDto, SaveRegistrationDraftDto, SubmitRegistrationDto, UpdateRegistrationSettingsDto } from './dto/registration.dto.js';
import { CreateTeamDto } from '../teams/dto/team.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';

/** Organizador del torneo (Tournament.organizerId): configuración, enlace y revisión de solicitudes. */
@ApiTags('registration')
@ApiBearerAuth()
@Controller('tournaments/:id')
export class RegistrationAdminController {
  constructor(private readonly service: RegistrationService) {}

  @Get('registration')
  @ApiOperation({ summary: 'Configuración de inscripción, enlace activo y conteos (organizador)' })
  settings(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.settings(id, user);
  }

  @Patch('registration')
  @ApiOperation({ summary: 'Abrir/cerrar inscripciones y límites (organizador; no FINISHED)' })
  update(@Param('id', IsObjectIdPipe) id: string, @Body() dto: UpdateRegistrationSettingsDto, @CurrentUser() user: AuthUser) {
    return this.service.updateSettings(id, dto, user);
  }

  @Post('registration-link')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Generar o regenerar el enlace privado (revoca el anterior)' })
  generate(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.generateLink(id, user);
  }

  @Delete('registration-link')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revocar el enlace activo (las solicitudes enviadas se conservan)' })
  revoke(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.revokeLink(id, user);
  }

  @Get('registration-requests')
  @ApiOperation({ summary: 'Solicitudes de inscripción (?status=PENDING|APPROVED|REJECTED|CANCELLED)' })
  list(@Param('id', IsObjectIdPipe) id: string, @Query() query: RegistrationRequestsQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.listRequests(id, query.status, user);
  }

  @Get('registration-requests/:requestId')
  @ApiOperation({ summary: 'Detalle: jugadores enviados y problemas actuales si sigue pendiente' })
  detail(@Param('id', IsObjectIdPipe) id: string, @Param('requestId', IsObjectIdPipe) requestId: string, @CurrentUser() user: AuthUser) {
    return this.service.getRequest(id, requestId, user);
  }

  @Post('registration-requests/:requestId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aprobar (atómico): TournamentTeam + TeamMembership por jugador' })
  @ApiConflictResponse({ description: 'Ya revisada, equipo ya inscrito, sin cupo o la plantilla cambió' })
  approve(@Param('id', IsObjectIdPipe) id: string, @Param('requestId', IsObjectIdPipe) requestId: string, @CurrentUser() user: AuthUser) {
    return this.service.approve(id, requestId, user);
  }

  @Post('registration-requests/:requestId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rechazar con motivo opcional' })
  reject(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('requestId', IsObjectIdPipe) requestId: string,
    @Body() dto: RejectRegistrationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.reject(id, requestId, dto.reason, user);
  }
}

/**
 * Flujo por enlace privado. Resolver el enlace es público (con rate limit); todo lo demás exige
 * sesión, y enviar/cancelar exige ser OWNER/MANAGER del equipo: el enlace no autoriza nada.
 */
@ApiTags('registration')
@Controller('tournament-registration/:token')
@UseGuards(ThrottlerGuard)
@SkipThrottle({ credentials: true })
export class RegistrationLinkController {
  constructor(private readonly service: RegistrationService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Torneo e inscripción (público; sin datos internos)' })
  @ApiNotFoundResponse({ description: 'Enlace inválido o revocado' })
  resolve(@Param('token') token: string) {
    return this.service.resolve(token);
  }

  @Get('my-teams')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mis equipos (OWNER/MANAGER) con su estado en este torneo' })
  mine(@Param('token') token: string, @CurrentUser() user: AuthUser) {
    return this.service.mine(token, user);
  }

  @Post('requests')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enviar solicitud con jugadores de la plantilla global' })
  @ApiForbiddenResponse({ description: 'No administras ese equipo' })
  submit(@Param('token') token: string, @Body() dto: SubmitRegistrationDto, @CurrentUser() user: AuthUser) {
    return this.service.submit(token, dto, user);
  }

  @Post('requests/:requestId/cancel')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancelar una solicitud pendiente' })
  cancel(@Param('token') token: string, @Param('requestId', IsObjectIdPipe) requestId: string, @CurrentUser() user: AuthUser) {
    return this.service.cancel(token, requestId, user);
  }

  @Get('draft')
  @ApiBearerAuth()
  @SkipThrottle({ refresh: true })
  @ApiOperation({ summary: 'Mi inscripción incompleta en este torneo (o null)' })
  getDraft(@Param('token') token: string, @CurrentUser() user: AuthUser) {
    return this.service.getDraft(token, user);
  }

  @Put('draft')
  @ApiBearerAuth()
  @SkipThrottle({ refresh: true }) // el flujo guarda solo mientras se avanza
  @ApiOperation({ summary: 'Guardar el progreso de la inscripción (equipo, jugadores marcados, paso)' })
  @ApiForbiddenResponse({ description: 'No administras ese equipo' })
  saveDraft(@Param('token') token: string, @Body() dto: SaveRegistrationDraftDto, @CurrentUser() user: AuthUser) {
    return this.service.saveDraft(token, dto, user);
  }

  @Delete('draft')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @SkipThrottle({ refresh: true })
  @ApiOperation({ summary: 'Cancelar la inscripción incompleta (no borra equipos ni jugadores)' })
  deleteDraft(@Param('token') token: string, @CurrentUser() user: AuthUser) {
    return this.service.deleteDraftByToken(token, user);
  }

  @Post('teams')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear un equipo NUEVO del que serás propietario (no es un claim)' })
  createTeam(@Param('token') token: string, @Body() dto: CreateTeamDto, @CurrentUser() user: AuthUser) {
    return this.service.createOwnTeam(token, dto, user);
  }
}
