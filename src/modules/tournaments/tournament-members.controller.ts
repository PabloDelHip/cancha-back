import { Body, Controller, Delete, Get, Param, Patch } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { TournamentMembersService } from './tournament-members.service.js';
import { UpdateTournamentMemberDto } from './dto/tournament-member.dto.js';

/** Colaboradores del torneo (RBAC). Solo el propietario los administra. */
@ApiTags('tournament-members')
@ApiBearerAuth()
@Controller('tournaments/:id/members')
export class TournamentMembersController {
  constructor(private readonly service: TournamentMembersService) {}

  @Get()
  @ApiOperation({ summary: 'Propietario y colaboradores activos (el correo solo lo ve el propietario)' })
  list(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.list(id, user);
  }

  @Patch(':userId')
  @ApiOperation({ summary: 'Cambiar el rol de un colaborador' })
  update(@Param('id', IsObjectIdPipe) id: string, @Param('userId') userId: string, @Body() dto: UpdateTournamentMemberDto, @CurrentUser() user: AuthUser) {
    return this.service.update(id, userId, dto, user);
  }

  @Delete(':userId')
  @ApiOperation({ summary: 'Revocar el acceso de un colaborador (inmediato)' })
  revoke(@Param('id', IsObjectIdPipe) id: string, @Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.service.revoke(id, userId, user);
  }
}
