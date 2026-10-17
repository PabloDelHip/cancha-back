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
  MinLength,
} from 'class-validator';
import { PlayerPosition } from '../../../common/enums/index.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { IsISODateOnly, Trim } from '../../../common/validators.js';
import { RosterEventAction } from '../roster-history.js';

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

  @ApiPropertyOptional({
    description:
      'Cambio de equipo explícito: equipo actual del jugador en este torneo. Sin él, inscribir a quien ya juega con otro equipo → 409 PLAYER_IN_OTHER_TEAM (nunca se le mueve sin querer).',
  })
  @IsOptional()
  @IsMongoId()
  fromTeamId?: string;

  @ApiPropertyOptional({ maxLength: 300, description: 'Justificación de una fecha efectiva anterior a hoy (excepción RETROACTIVE; permiso REGISTRATION_EXCEPTIONS)' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  retroactiveReason?: string;

  @ApiPropertyOptional({ maxLength: 300, description: 'Justificación para superar el máximo de jugadores por equipo (excepción OVER_LIMIT; permiso REGISTRATION_EXCEPTIONS)' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  overLimitReason?: string;

  @ApiPropertyOptional({ minLength: 3, maxLength: 300, description: '3C: motivo del cambio de equipo (obligatorio con `fromTeamId`)' })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  transferReason?: string;

  @ApiPropertyOptional({ maxLength: 300, description: '3C: justificación de un cambio con la eliminatoria iniciada (excepción KNOCKOUT_EXCEPTION; permiso REGISTRATION_EXCEPTIONS)' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  knockoutReason?: string;
}

/** Baja de un jugador del torneo (3A): el motivo es obligatorio. */
export class UnregisterPlayerDto {
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
}

/** 3D — aplicar un bloqueo administrativo (motivo obligatorio; fecha anterior a hoy = excepción). */
export class BlockPlayerDto {
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;

  @ApiPropertyOptional({ description: 'Primer día bloqueado (YYYY-MM-DD). Por defecto hoy; anterior a hoy requiere REGISTRATION_EXCEPTIONS.' })
  @IsOptional()
  @IsISODateOnly()
  since?: string;
}

/** 3D — levantar el bloqueo vigente (motivo obligatorio; fecha anterior a hoy = excepción). */
export class LiftBlockDto {
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;

  @ApiPropertyOptional({ description: 'Primer día ya habilitado (YYYY-MM-DD). Por defecto hoy; anterior a hoy requiere REGISTRATION_EXCEPTIONS.' })
  @IsOptional()
  @IsISODateOnly()
  until?: string;
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

/** 3E — filtros del historial de plantillas del torneo (todos opcionales y combinables). */
export class RosterHistoryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  playerId?: string;

  @ApiPropertyOptional({ description: 'Equipo involucrado (también como origen de un cambio)' })
  @IsOptional()
  @IsMongoId()
  teamId?: string;

  @ApiPropertyOptional({ description: 'Acciones separadas por coma', example: 'TRANSFER,UNREGISTERED' })
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : String(value).split(',')).map((v: string) => v.trim()).filter(Boolean))
  @IsEnum(RosterEventAction, { each: true })
  action?: RosterEventAction[];

  @ApiPropertyOptional({ description: 'Desde (YYYY-MM-DD, inclusive), por el día en que se registró' })
  @IsOptional()
  @IsISODateOnly()
  from?: string;

  @ApiPropertyOptional({ description: 'Hasta (YYYY-MM-DD, inclusive)' })
  @IsOptional()
  @IsISODateOnly()
  to?: string;
}
