import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { TournamentInvitationsService } from './tournament-invitations.service.js';
import { CreateInvitationDto } from './dto/tournament-member.dto.js';

/** Invitaciones a colaborar (RBAC R2). Crear y aceptar se limitan por IP (throttler de credenciales). */
@ApiTags('tournament-invitations')
@ApiBearerAuth()
@Controller()
export class TournamentInvitationsController {
  constructor(private readonly service: TournamentInvitationsService) {}

  @Post('tournaments/:id/invitations')
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ refresh: true })
  @ApiOperation({
    summary: 'Invitar a colaborar (solo el propietario)',
    description: 'LINK devuelve el token una sola vez. ACCOUNT responde igual exista o no una cuenta con ese correo.',
  })
  create(@Param('id', IsObjectIdPipe) id: string, @Body() dto: CreateInvitationDto, @CurrentUser() user: AuthUser) {
    return this.service.create(id, dto, user);
  }

  @Get('tournaments/:id/invitations')
  @ApiOperation({ summary: 'Invitaciones pendientes (solo el propietario)' })
  list(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.list(id, user);
  }

  @Delete('tournaments/:id/invitations/:invitationId')
  @ApiOperation({ summary: 'Revocar una invitación pendiente' })
  revoke(@Param('id', IsObjectIdPipe) id: string, @Param('invitationId', IsObjectIdPipe) invitationId: string, @CurrentUser() user: AuthUser) {
    return this.service.revoke(id, invitationId, user);
  }

  @Public()
  @Get('invitations/:token')
  @ApiOperation({ summary: 'Vista previa de un enlace de invitación (torneo, rol, quién invita, estado)' })
  preview(@Param('token') token: string) {
    return this.service.preview(token);
  }

  @Post('invitations/:token/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ refresh: true })
  @ApiOperation({ summary: 'Aceptar un enlace de invitación (un solo uso)' })
  acceptLink(@Param('token') token: string, @CurrentUser() user: AuthUser) {
    return this.service.acceptLink(token, user);
  }

  @Get('me/invitations')
  @ApiOperation({ summary: 'Invitaciones pendientes a mi cuenta' })
  mine(@CurrentUser() user: AuthUser) {
    return this.service.mine(user);
  }

  @Post('me/invitations/:invitationId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Aceptar una invitación a mi cuenta' })
  acceptMine(@Param('invitationId', IsObjectIdPipe) invitationId: string, @CurrentUser() user: AuthUser) {
    return this.service.acceptMine(invitationId, user);
  }

  @Post('me/invitations/:invitationId/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rechazar una invitación a mi cuenta' })
  decline(@Param('invitationId', IsObjectIdPipe) invitationId: string, @CurrentUser() user: AuthUser) {
    return this.service.decline(invitationId, user);
  }
}
