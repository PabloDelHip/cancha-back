import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiForbiddenResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LeaguesService } from './leagues.service.js';
import { CreateLeagueDto, UpdateLeagueDto } from './dto/league.dto.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';

@ApiTags('leagues')
@Controller()
export class LeaguesController {
  constructor(private readonly service: LeaguesService) {}

  @Public()
  @Get('leagues')
  @ApiOperation({ summary: 'Ligas con torneos (más recientes primero)' })
  list() {
    return this.service.list();
  }

  @Get('admin/leagues')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mis ligas (también vacías), con su número de torneos' })
  mine(@CurrentUser() user: AuthUser) {
    return this.service.mine(user);
  }

  @Public()
  @Get('leagues/:id')
  @ApiOperation({ summary: 'Liga y sus torneos' })
  findOne(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.findOne(id);
  }

  @Public()
  @Get('leagues/:id/history')
  @ApiOperation({ summary: 'Histórico de la liga: campeones, tabla histórica, jugadores, porteros y récords' })
  history(@Param('id', IsObjectIdPipe) id: string) {
    return this.service.history(id);
  }

  @Post('leagues')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear una liga (requiere poder organizar)' })
  create(@Body() dto: CreateLeagueDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Patch('leagues/:id')
  @ApiBearerAuth()
  @ApiForbiddenResponse({ description: 'La liga es de otro organizador' })
  update(@Param('id', IsObjectIdPipe) id: string, @Body() dto: UpdateLeagueDto, @CurrentUser() user: AuthUser) {
    return this.service.update(id, dto, user);
  }

  @Delete('leagues/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiConflictResponse({ description: 'La liga tiene torneos' })
  remove(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.remove(id, user);
  }
}
