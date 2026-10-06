import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Equals,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PlayerPosition } from '../../../common/enums/index.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { IsISODateOnly, Trim } from '../../../common/validators.js';

export class CreatePlayerDto {
  @ApiProperty({ example: 'Pablo' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  firstName: string;

  @ApiProperty({ example: 'Hipólito' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName: string;

  @ApiPropertyOptional({ example: 'Bigotes', nullable: true, type: String, description: 'Apodo (opcional, no único)' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(40)
  nickname?: string | null;

  @ApiPropertyOptional({ example: '2001-04-18', nullable: true, type: String })
  @IsOptional()
  @IsISODateOnly()
  birthDate?: string | null;

  @ApiProperty({ enum: PlayerPosition })
  @IsEnum(PlayerPosition)
  position: PlayerPosition;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    enum: [null],
    description: 'Solo `null` (quitar la imagen). La imagen se sube con PUT /players/:id/photo: la URL la genera Cloudinary, nunca el cliente.',
  })
  @IsOptional()
  @Equals(null, { message: 'photoUrl: la imagen se sube con PUT /players/:id/photo; aquí solo se acepta null para quitarla' })
  photoUrl?: null;
}

/**
 * Alta de jugador. Si hay posibles duplicados el servidor responde 409 PLAYER_POSSIBLE_DUPLICATES
 * con los candidatos y NO crea nada; `confirmNew: true` = "ninguno es la persona: créalo igual".
 */
export class CreatePlayerWithCheckDto extends CreatePlayerDto {
  @ApiPropertyOptional({ default: false, description: 'Confirmar el alta aunque existan posibles duplicados' })
  @IsOptional()
  @IsBoolean()
  confirmNew?: boolean;
}

export class UpdatePlayerDto extends PartialType(CreatePlayerDto) {}

export class PlayerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Busca por nombre y apellidos (sin distinguir acentos)',
    example: 'pablo',
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({
    description: 'Solo jugadores de la plantilla actual de este equipo',
  })
  @IsOptional()
  @IsMongoId()
  teamId?: string;
}

/**
 * Registra (o mueve) a un jugador global en un equipo de MI torneo.
 * Solo afecta a la participación dentro de ese torneo; no toca otros torneos.
 */
export class RegisterPlayerDto {
  @ApiProperty({ description: 'Equipo inscrito en el torneo' })
  @IsMongoId()
  teamId: string;

  @ApiPropertyOptional({
    nullable: true,
    type: Number,
    minimum: 1,
    maximum: 99,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  jerseyNumber?: number | null;

  @ApiPropertyOptional({
    description: 'Fecha efectiva del alta o del cambio (YYYY-MM-DD). Por defecto, hoy.',
  })
  @IsOptional()
  @IsISODateOnly()
  startDate?: string;
}

/** Alta desde el equipo: solo el dorsal (el equipo sale de la ruta y la fecha es hoy). */
export class TeamTournamentPlayerDto {
  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 1, maximum: 99 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  jerseyNumber?: number | null;
}

export class RosterQueryDto {
  @ApiPropertyOptional({ description: 'Solo la plantilla de este equipo' })
  @IsOptional()
  @IsMongoId()
  teamId?: string;
}

export class TeamRosterQueryDto {
  @ApiPropertyOptional({
    description: 'Plantilla en este torneo. Sin él: participaciones activas en cualquier torneo (la más reciente por jugador).',
  })
  @IsOptional()
  @IsMongoId()
  tournamentId?: string;
}

export class MembershipQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  playerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  tournamentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  teamId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  active?: boolean;
}
