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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PlayersService } from './players.service.js';
import { MembershipsService } from './memberships.service.js';
import { PlayerBlocksService } from './player-blocks.service.js';
import { RosterHistoryService } from './roster-history.service.js';
import {
  BlockPlayerDto,
  CreatePlayerWithCheckDto,
  LiftBlockDto,
  MembershipQueryDto,
  UnregisterPlayerDto,
  PlayerQueryDto,
  RegisterPlayerDto, RosterHistoryQueryDto, RosterQueryDto, TeamTournamentPlayerDto,
  UpdatePlayerDto,
} from './dto/player.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { CurrentUser, Viewer } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { imageUploadOptions, type UploadedImage } from '../media/image-upload.js';
import { IMAGE_FILE_BODY } from '../media/swagger.js';

@ApiTags('players')
@Controller()
export class PlayersController {
  constructor(
    private readonly service: PlayersService,
    private readonly memberships: MembershipsService,
    private readonly blocks: PlayerBlocksService,
    private readonly rosterHistoryService: RosterHistoryService,
  ) {}

  @Public()
  @Get('players')
  @ApiOperation({
    summary:
      'Listar/buscar jugadores (público, paginado; filtros search, teamId)',
  })
  findAll(@Query() query: PlayerQueryDto) {
    return this.service.findAll(query);
  }

  @Get('admin/players')
  @ApiTags('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Jugadores de mis torneos + fichas que registré (con canEdit)' })
  findMine(@CurrentUser() user: AuthUser, @Query() query: PlayerQueryDto) {
    return this.service.findMine(user, query);
  }

  @Public()
  @Get('players/:id')
  @ApiOperation({
    summary: 'Jugador con membresía actual e historial de equipos',
  })
  @ApiNotFoundResponse({ description: 'Jugador no encontrado' })
  findOne(@Param('id', IsObjectIdPipe) id: string, @Viewer() viewer: AuthUser | null) {
    return this.service.findOne(id, viewer);
  }

  @Post('players')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Registrar jugador (no necesita cuenta de usuario)',
    description:
      'Antes de crear busca posibles duplicados (nombre y apellidos iguales o parecidos). Si los hay: 409 PLAYER_POSSIBLE_DUPLICATES con `candidates` y no se crea nada. `confirmNew: true` crea igualmente (pueden existir homónimos).',
  })
  @ApiConflictResponse({ description: 'PLAYER_POSSIBLE_DUPLICATES: posibles jugadores existentes (`candidates`)' })
  create(@Body() dto: CreatePlayerWithCheckDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch('players/:id')
  @ApiBearerAuth()
  @ApiForbiddenResponse({
    description: 'El jugador lo registró otro organizador',
  })
  update(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: UpdatePlayerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Put('players/:id/photo')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody(IMAGE_FILE_BODY)
  @ApiOperation({
    summary: 'Subir o reemplazar la foto del jugador (Cloudinary)',
    description: 'Campo `file`: JPG, PNG, WebP, GIF o AVIF, máx. 5 MB. Se guarda optimizada (máx. 800 px, formato y calidad automáticos). La anterior se borra. Mismo permiso que editar la ficha.',
  })
  @ApiForbiddenResponse({ description: 'El jugador lo registró otro usuario' })
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  setPhoto(
    @Param('id', IsObjectIdPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.setPhoto(id, file, user);
  }

  @Delete('players/:id/photo')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Quitar la foto del jugador (y borrarla de Cloudinary si se subió aquí)' })
  @ApiForbiddenResponse({ description: 'El jugador lo registró otro usuario' })
  removePhoto(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.removePhoto(id, user);
  }

  @Delete('players/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiForbiddenResponse({
    description: 'El jugador lo registró otro organizador',
  })
  @ApiConflictResponse({ description: 'El jugador tiene partidos registrados' })
  remove(
    @Param('id', IsObjectIdPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.remove(id, user);
  }

  @Public()
  @Get('players/:id/memberships')
  @ApiOperation({ summary: 'Historial de equipos del jugador' })
  history(@Param('id', IsObjectIdPipe) id: string, @Viewer() viewer: AuthUser | null) {
    return this.memberships.playerHistory(id, viewer);
  }

  @Public()
  @Get('tournaments/:tournamentId/players')
  @ApiTags('tournaments')
  @ApiOperation({ summary: 'Jugadores participantes del torneo (opcional: de un equipo)' })
  tournamentRoster(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Query() query: RosterQueryDto,
    @Viewer() viewer: AuthUser | null,
  ) {
    return this.memberships.tournamentRoster(tournamentId, query.teamId, viewer);
  }

  @Put('tournaments/:tournamentId/players/:playerId')
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Registrar un jugador (existente o nuevo) en un equipo de mi torneo, o cambiarlo de equipo/dorsal',
    description:
      'Player es global: puede ser un jugador creado por cualquier organizador. Solo afecta a la participación en ESTE torneo; ' +
      'las de otros torneos no se tocan. Devuelve el historial del jugador.',
  })
  @ApiForbiddenResponse({ description: 'El torneo pertenece a otro organizador' })
  @ApiConflictResponse({ description: 'Dorsal ocupado en el equipo' })
  register(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('playerId', IsObjectIdPipe) playerId: string,
    @Body() dto: RegisterPlayerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.memberships.register(tournamentId, playerId, dto, user);
  }

  @Delete('tournaments/:tournamentId/players/:playerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dar de baja a un jugador de mi torneo, con motivo (conserva estadísticas e historial)' })
  @ApiForbiddenResponse({ description: 'El torneo pertenece a otro organizador' })
  unregister(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('playerId', IsObjectIdPipe) playerId: string,
    @Body() dto: UnregisterPlayerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.memberships.unregister(tournamentId, playerId, dto.reason, user);
  }

  @Post('tournaments/:tournamentId/players/:playerId/annul-transfer')
  @HttpCode(HttpStatus.OK)
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Anular la última transferencia de un jugador (errónea), con motivo',
    description: 'Solo sin participación con el equipo nuevo. Reabre la participación anterior; la anulada queda en la auditoría. Devuelve el historial del jugador.',
  })
  @ApiConflictResponse({ description: 'NOT_A_TRANSFER o TRANSFER_HAS_PARTICIPATION' })
  annulTransfer(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('playerId', IsObjectIdPipe) playerId: string,
    @Body() dto: UnregisterPlayerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.memberships.annulTransfer(tournamentId, playerId, dto.reason, user);
  }

  @Get('tournaments/:tournamentId/player-blocks')
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({ summary: '3D: bloqueos administrativos del torneo (vigentes y levantados). Motivo y autores solo con permiso TEAMS' })
  listBlocks(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @CurrentUser() user: AuthUser) {
    return this.blocks.list(tournamentId, user);
  }

  @Get('tournaments/:tournamentId/roster-history')
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({ summary: '3E: historial de plantillas del torneo (altas, cambios, bajas, excepciones, bloqueos, retiros), lo más reciente primero. Solo permiso TEAMS' })
  @ApiForbiddenResponse({ description: 'Sin permiso TEAMS en el torneo' })
  rosterHistory(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @Query() query: RosterHistoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.rosterHistoryService.list(tournamentId, query, user);
  }

  @Post('tournaments/:tournamentId/players/:playerId/block')
  @HttpCode(HttpStatus.OK)
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({ summary: '3D: bloquear administrativamente a un jugador en mi torneo, con motivo (no es una sanción)' })
  @ApiConflictResponse({ description: 'PLAYER_ALREADY_BLOCKED' })
  block(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('playerId', IsObjectIdPipe) playerId: string,
    @Body() dto: BlockPlayerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.blocks.block(tournamentId, playerId, dto, user);
  }

  @Post('tournaments/:tournamentId/players/:playerId/unblock')
  @HttpCode(HttpStatus.OK)
  @ApiTags('tournaments')
  @ApiBearerAuth()
  @ApiOperation({ summary: '3D: levantar el bloqueo administrativo vigente, con motivo' })
  unblock(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('playerId', IsObjectIdPipe) playerId: string,
    @Body() dto: LiftBlockDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.blocks.lift(tournamentId, playerId, dto, user);
  }

  @Get('teams/:id/tournaments')
  @ApiTags('teams')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Torneos donde juega mi equipo, con su plantilla en cada uno (OWNER/MANAGER)' })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  teamTournaments(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.memberships.teamTournaments(id, user);
  }

  @Put('teams/:id/tournaments/:tournamentId/players/:playerId')
  @ApiTags('teams')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Inscribir a un jugador de mi plantilla en un torneo donde juega mi equipo, o cambiar su dorsal (OWNER/MANAGER)',
    description: 'Sin aprobación del organizador, con sus límites (máximo de jugadores, dorsal libre, torneo no finalizado). Devuelve la lista de torneos del equipo.',
  })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  @ApiConflictResponse({ description: 'No está en la plantilla, juega con otro equipo, cupo lleno o dorsal ocupado' })
  registerByTeam(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('playerId', IsObjectIdPipe) playerId: string,
    @Body() dto: TeamTournamentPlayerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.memberships.registerByTeam(id, tournamentId, playerId, dto.jerseyNumber ?? null, user);
  }

  @Delete('teams/:id/tournaments/:tournamentId/players/:playerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiTags('teams')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dar de baja a un jugador de mi equipo en un torneo, con motivo (conserva el historial)' })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  unregisterByTeam(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('playerId', IsObjectIdPipe) playerId: string,
    @Body() dto: UnregisterPlayerDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.memberships.unregisterByTeam(id, tournamentId, playerId, dto.reason, user);
  }

  @Public()
  @Get('memberships')
  @ApiTags('memberships')
  @ApiOperation({
    summary: 'Listar membresías (paginado; filtros playerId, teamId, active)',
  })
  listMemberships(@Query() query: MembershipQueryDto, @Viewer() viewer: AuthUser | null) {
    return this.memberships.list(query, viewer);
  }
}
