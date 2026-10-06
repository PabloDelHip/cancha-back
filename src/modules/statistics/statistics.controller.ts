import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiNotFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { StatisticsService } from './statistics.service.js';
import { PlayerProfileService } from './player-profile.service.js';
import { TeamProfileService } from './team-profile.service.js';
import { StatsQueryDto, TopScorersQueryDto } from './dto/statistics.dto.js';
import { PaginationQueryDto } from '../../common/dto/pagination.dto.js';

@ApiTags('statistics')
@Public() // estadísticas: lectura pública
@Controller()
export class StatisticsController {
  constructor(
    private readonly service: StatisticsService,
    private readonly profiles: PlayerProfileService,
    private readonly teamProfiles: TeamProfileService,
  ) {}

  @Get('teams/:id/profile')
  @ApiOperation({
    summary: 'Perfil histórico público del equipo (agregado)',
    description:
      'Fuente de verdad del Team Profile: balance histórico (solo partidos FINISHED), participaciones actuales (inscripciones en torneos no finalizados), competiciones, plantillas POR torneo, goleadores con este equipo, partidos recientes y próximos, historial por año y honors verificables (campeón de liga solo con tabla final completa y sin empate). Datos personales minimizados.',
  })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado' })
  teamProfile(@Param('id', IsObjectIdPipe) id: string) {
    return this.teamProfiles.profile(id);
  }

  @Get('teams/:id/matches')
  @ApiOperation({ summary: 'Partidos oficiales del equipo, más recientes primero (paginado)' })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado' })
  teamMatches(@Param('id', IsObjectIdPipe) id: string, @Query() query: PaginationQueryDto) {
    return this.teamProfiles.matchesPage(id, query);
  }

  @Get('players/:id/profile')
  @ApiOperation({
    summary: 'Perfil deportivo público del jugador (agregado)',
    description:
      'Fuente de verdad del Player Profile: carrera, participaciones actuales (activas en torneos no finalizados), competiciones (torneo → equipos), historial por año, últimos resultados y 5 partidos recientes. Solo partidos FINISHED. Datos personales minimizados: edad derivada, nunca la fecha de nacimiento.',
  })
  @ApiNotFoundResponse({ description: 'Jugador no encontrado' })
  profile(@Param('id', IsObjectIdPipe) id: string) {
    return this.profiles.profile(id);
  }

  @Get('tournaments/:id/tracked-summary')
  @ApiOperation({
    summary: 'Equipos en seguimiento de un torneo PARTIAL (6G)',
    description:
      'Una tarjeta por equipo seguido con SUS partidos registrados en este torneo: balance, forma, último y próximo partido, máximo goleador y asistidor, tamaño de plantilla. No es una clasificación. FULL o sin equipos seguidos: trackedTeams = []. Consultas fijas.',
  })
  @ApiNotFoundResponse({ description: 'Torneo no encontrado' })
  trackedSummary(@Param('id', IsObjectIdPipe) id: string) {
    return this.teamProfiles.trackedSummary(id);
  }

  @Get('tournaments/:id/standings')
  @ApiOperation({
    summary: 'Tabla de posiciones',
    description:
      'Solo partidos FINISHED (programados, en juego, pospuestos y cancelados no cuentan). Puntos según Tournament.settings (por defecto 3/1/0). Orden: puntos, diferencia de goles, goles a favor.',
  })
  standings(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.standings(id);
  }

  @Get('tournaments/:id/top-scorers')
  @ApiOperation({ summary: 'Goleadores del torneo (solo partidos FINISHED)' })
  topScorers(
    @Param('id', IsObjectIdPipe) id: string,
    @Query() query: TopScorersQueryDto,
  ) {
    return this.service.topScorers(id, query.limit);
  }

  @Get('players/:id/stats')
  @ApiOperation({
    summary:
      'Totales del jugador (globales y por torneo), derivados de sus partidos',
  })
  playerStats(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.playerStats(id);
  }

  @Get('players/:id/matches')
  @ApiOperation({
    summary:
      'Partidos disputados por el jugador con sus estadísticas (paginado)',
  })
  playerMatches(
    @Param('id', IsObjectIdPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.service.playerMatches(id, query);
  }

  @Get('player-match-stats')
  @ApiOperation({
    summary:
      'Listar participaciones (paginado; filtros matchId, playerId, tournamentId)',
  })
  list(@Query() query: StatsQueryDto) {
    return this.service.list(query);
  }
}
