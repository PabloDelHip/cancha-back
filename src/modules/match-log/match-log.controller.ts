import { Controller, Get, Param, Query } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { MatchLogService } from './match-log.service.js';

/** Historial de partidos (solo el organizador del torneo). */
@ApiTags('match-log')
@ApiBearerAuth()
@Controller()
export class MatchLogController {
  constructor(private readonly service: MatchLogService) {}

  @Get('matches/:id/log')
  @ApiOperation({ summary: 'Historial de un partido en orden cronológico (también si ya se eliminó)' })
  ofMatch(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.ofMatch(id, user);
  }

  @Get('tournaments/:id/match-log')
  @ApiOperation({ summary: 'Historial de los partidos del torneo, lo más reciente primero' })
  @ApiQuery({ name: 'deleted', required: false, type: Boolean, description: 'Solo partidos eliminados' })
  ofTournament(@Param('id', IsObjectIdPipe) id: string, @Query('deleted') deleted: string | undefined, @CurrentUser() user: AuthUser) {
    return this.service.ofTournament(id, user, { deleted: deleted === 'true' });
  }
}
