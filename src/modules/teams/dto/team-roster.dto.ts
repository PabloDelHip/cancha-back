import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsOptional, IsUUID } from 'class-validator';
import { CreatePlayerWithCheckDto } from '../../players/dto/player.dto.js';

export class AddRosterPlayerDto {
  @ApiProperty({ description: 'Player EXISTENTE (no se crean jugadores aquí)' })
  @IsMongoId()
  playerId: string;
}

/**
 * Crear un Player NUEVO (los mismos campos que POST /players) y agregarlo a la plantilla.
 * `requestId`: lo genera el cliente una vez por formulario; reintentos y dobles clics con la misma
 * clave devuelven el mismo jugador en lugar de crear otro.
 */
export class CreateRosterPlayerDto extends CreatePlayerWithCheckDto {
  @ApiProperty({ format: 'uuid', description: 'Clave de idempotencia generada por el cliente' })
  @IsUUID()
  requestId: string;
}

export const ROSTER_VIEWS = ['active', 'inactive', 'all'] as const;
export type RosterView = (typeof ROSTER_VIEWS)[number];

export class RosterQueryDto {
  @ApiPropertyOptional({ enum: ROSTER_VIEWS, default: 'active', description: 'active = plantilla actual; inactive/all = periodos cerrados / todos' })
  @IsOptional()
  @IsIn(ROSTER_VIEWS)
  status?: RosterView;
}
