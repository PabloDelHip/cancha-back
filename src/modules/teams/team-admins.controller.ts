import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { TeamAdminsService } from './team-admins.service.js';
import { AddManagerDto } from './dto/team-admin.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * Administración global del equipo (OWNER / MANAGER). Todo requiere sesión; ninguna ruta es
 * pública. No hay endpoint para establecer OWNER: se asigna por el mecanismo interno
 * (`npm run team:assign-owner`) hasta que exista el Claim Flow.
 */
@ApiTags('teams')
@ApiBearerAuth()
@Controller('teams/:id')
export class TeamAdminsController {
  constructor(private readonly service: TeamAdminsService) {}

  @Get('admins')
  @ApiOperation({ summary: 'OWNER y MANAGERS activos (solo para OWNER/MANAGER del equipo)' })
  @ApiForbiddenResponse({ description: 'No administras este equipo' })
  @ApiNotFoundResponse({ description: 'Equipo no encontrado' })
  list(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.list(id, user);
  }

  /**
   * Por email, un 404 indica que no hay cuenta con ese correo. Es la misma información que ya
   * revela el registro público (409 "ya existe una cuenta"), pero aquí exige sesión y ser OWNER.
   * Se limita igual que login/registro (throttler "credentials", por IP) para impedir sondeos masivos.
   * Neutralizarlo del todo requiere invitaciones por correo (futuro; ver docs/team-ownership-v1.md).
   */
  @Post('managers')
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ refresh: true })
  @ApiOperation({ summary: 'Agregar MANAGER (solo OWNER). 201 si se agregó, 200 si ya lo era (idempotente)' })
  @ApiForbiddenResponse({ description: 'Solo el OWNER' })
  @ApiNotFoundResponse({ description: 'Equipo o usuario no encontrado' })
  @ApiConflictResponse({ description: 'El usuario es el OWNER' })
  async addManager(
    @Param('id', IsObjectIdPipe) id: string,
    @Body() dto: AddManagerDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, admins } = await this.service.addManager(id, dto, user);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return admins;
  }

  @Delete('managers/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Quitar MANAGER (solo OWNER; baja lógica, queda en auditoría)' })
  @ApiForbiddenResponse({ description: 'Solo el OWNER' })
  @ApiNotFoundResponse({ description: 'No es MANAGER activo' })
  removeManager(
    @Param('id', IsObjectIdPipe) id: string,
    @Param('userId', IsObjectIdPipe) userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.removeManager(id, userId, user);
  }
}
