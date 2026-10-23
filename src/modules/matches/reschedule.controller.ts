import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { MatchRescheduleService } from './match-reschedule.service.js';
import { RescheduleConfirmDto, RescheduleProposalDto } from './dto/reschedule.dto.js';

/** 6C — reprogramación parcial: propuesta (sin escrituras) y confirmación atómica. */
@ApiTags('tournaments')
@ApiBearerAuth()
@Controller('tournaments/:id/reschedule')
export class RescheduleController {
  constructor(private readonly service: MatchRescheduleService) {}

  @Post('proposal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Propuesta de reprogramación: qué partidos cambian, cuáles se quedan y cuáles no tienen horario (no guarda nada)' })
  proposal(@Param('id', IsObjectIdPipe) id: string, @Body() dto: RescheduleProposalDto, @CurrentUser() user: AuthUser) {
    return this.service.proposal(id, dto, user);
  }

  @Post()
  @ApiOperation({ summary: 'Confirmar una reprogramación (revalida versiones, permisos y restricciones; todo o nada)' })
  @ApiConflictResponse({ description: 'PROPOSAL_STALE, PENDING_NOT_CONFIRMED, MATCH_NOT_RESCHEDULABLE, BRACKET_ORDER, SCHEDULE_CONSTRAINTS, FIELD_CONFLICT…' })
  confirm(@Param('id', IsObjectIdPipe) id: string, @Body() dto: RescheduleConfirmDto, @CurrentUser() user: AuthUser) {
    return this.service.confirm(id, dto, user);
  }
}
