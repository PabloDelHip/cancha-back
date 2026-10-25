import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiForbiddenResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Viewer } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { IdentityCorrectionDto, NextSeasonDto } from './dto/closure.dto.js';
import { TournamentIdentityService } from '../../common/history/tournament-identity.service.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { TournamentClosureService } from './tournament-closure.service.js';

/** Módulo 10A — cierre y temporadas (el cierre en sí sigue siendo POST /tournaments/:id/finish). */
@ApiTags('tournaments')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Sin acceso o sin el permiso requerido' })
@Controller('tournaments/:id')
export class TournamentClosureController {
  constructor(
    private readonly service: TournamentClosureService,
    private readonly identity: TournamentIdentityService,
  ) {}

  @Get('closure')
  @ApiOperation({ summary: 'Vista previa del cierre (solo lectura): si se puede finalizar, bloqueantes, advertencias y resumen deportivo. Exige LIFECYCLE.' })
  preview(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.preview(id, user);
  }

  @Post('next-season')
  @ApiOperation({ summary: 'Crear la siguiente temporada (DRAFT) a partir de este torneo. Solo el propietario.' })
  nextSeason(@Param('id', IsObjectIdPipe) id: string, @Body() dto: NextSeasonDto, @CurrentUser() user: AuthUser) {
    return this.service.nextSeason(id, dto, user);
  }

  @Public()
  @Get('identity')
  @ApiOperation({ summary: '10C: nombres con que se jugó un torneo finalizado (liga, equipos, jugadores). historical=false: nombres actuales.' })
  identityView(@Param('id', IsObjectIdPipe) id: string, @Viewer() viewer: AuthUser | null) {
    return this.identity.publicView(id, viewer);
  }

  @Post('identity/corrections')
  @ApiOperation({ summary: '10C: corregir un nombre histórico con motivo (auditado). Exige LIFECYCLE.' })
  correctIdentity(@Param('id', IsObjectIdPipe) id: string, @Body() dto: IdentityCorrectionDto, @CurrentUser() user: AuthUser) {
    return this.identity.correct(id, dto, user);
  }
}
