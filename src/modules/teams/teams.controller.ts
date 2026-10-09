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
import { TeamsService } from './teams.service.js';
import { MembershipsService } from '../players/memberships.service.js';
import { TeamRosterQueryDto } from '../players/dto/player.dto.js';
import { CreateTeamDto, TeamQueryDto, UpdateTeamDto } from './dto/team.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { imageUploadOptions, type UploadedImage } from '../media/image-upload.js';
import { IMAGE_FILE_BODY } from '../media/swagger.js';

@ApiTags('teams')
@Controller()
export class TeamsController {
  constructor(
    private readonly service: TeamsService,
    private readonly memberships: MembershipsService,
  ) {}

  @Public()
  @Get('teams')
  @ApiOperation({
    summary: 'Listar equipos (público, paginado; filtros search, tournamentId)',
  })
  findAll(@Query() query: TeamQueryDto) {
    return this.service.findAll(query);
  }

  @Get('admin/teams')
  @ApiTags('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Equipos de mis torneos + fichas que registré (con canEdit)' })
  findMine(@CurrentUser() user: AuthUser, @Query() query: TeamQueryDto) {
    return this.service.findMine(user, query);
  }

  @Public()
  @Get('teams/:id')
  @ApiOperation({
    summary: 'Ficha del equipo: plantilla actual, torneos y partidos recientes',
  })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado' })
  findOne(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.findOne(id);
  }

  @Post('teams')
  @ApiBearerAuth()
  create(@Body() dto: CreateTeamDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch('teams/:id')
  @ApiBearerAuth()
  @ApiForbiddenResponse({
    description: 'El equipo lo registró otro organizador',
  })
  update(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: UpdateTeamDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, dto, user);
  }

  @Put('teams/:id/logo')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody(IMAGE_FILE_BODY)
  @ApiOperation({
    summary: 'Subir o reemplazar el logo del equipo (Cloudinary)',
    description: 'Campo `file`: JPG, PNG, WebP, GIF o AVIF, máx. 5 MB. Se guarda optimizado (máx. 512 px, formato y calidad automáticos). El anterior se borra. OWNER, MANAGER o custodio sin OWNER.',
  })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  setLogo(
    @Param('id', IsObjectIdPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.setLogo(id, file, user);
  }

  @Put('teams/:id/cover')
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody(IMAGE_FILE_BODY)
  @ApiOperation({
    summary: 'Subir o reemplazar la foto de portada del equipo (Cloudinary)',
    description: 'Campo `file`: JPG, PNG, WebP, GIF o AVIF, máx. 5 MB. Se guarda completa (máx. 1920 px); el encuadre se ajusta con PATCH coverPosition. OWNER, MANAGER o custodio sin OWNER.',
  })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  @UseInterceptors(FileInterceptor('file', imageUploadOptions))
  setCover(
    @Param('id', IsObjectIdPipe) id: string,
    @UploadedFile() file: UploadedImage | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.setCover(id, file, user);
  }

  @Delete('teams/:id/cover')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Quitar la foto de portada (vuelve el diseño con los colores del equipo)' })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  removeCover(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.removeCover(id, user);
  }

  @Delete('teams/:id/logo')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Quitar el logo del equipo (y borrarlo de Cloudinary si se subió aquí)' })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  removeLogo(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.removeLogo(id, user);
  }

  @Delete('teams/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiForbiddenResponse({
    description: 'El equipo lo registró otro organizador',
  })
  @ApiConflictResponse({ description: 'El equipo tiene partidos o jugadores' })
  remove(
    @Param('id', IsObjectIdPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.remove(id, user);
  }

  /**
   * LEGACY / contexto de torneo: deriva la "plantilla" de TeamMembership (participaciones en
   * torneos no finalizados, o las de ?tournamentId=). NO es la plantilla global del equipo, que es
   * GET /teams/:id/global-roster (OWNER/MANAGER) o `currentRoster` en GET /teams/:id/profile.
   * Se mantiene por compatibilidad; candidata a deprecación cuando no tenga consumidores.
   */
  @Public()
  @Get('teams/:id/roster')
  @ApiOperation({
    summary: 'LEGACY: jugadores del equipo en sus torneos (TeamMembership). Plantilla global: /global-roster',
    deprecated: true,
  })
  roster(@Param('id', IsObjectIdPipe) id: string, @Query() query: TeamRosterQueryDto) {
    return this.memberships.roster(id, query.tournamentId);
  }

  @Public()
  @Get('teams/:id/memberships')
  @ApiOperation({
    summary: 'Historial de membresías del equipo (actuales y pasadas)',
  })
  history(@Param('id', IsObjectIdPipe) id: string) {
    return this.memberships.teamHistory(id);
  }
}
