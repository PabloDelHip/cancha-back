import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { IsISODateOnly, Trim } from '../../../common/validators.js';
import { RegistrationRequestStatus } from '../../../common/enums/index.js';

/** Configuración de inscripción (organizador). `null` quita un límite. */
export class UpdateRegistrationSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 1, maximum: 60 })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(60)
  minPlayers?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 1, maximum: 60 })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(60)
  maxPlayers?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 2, maximum: 128 })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(2)
  @Max(128)
  maxTeams?: number | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'YYYY-MM-DD, inclusiva' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISODateOnly()
  deadline?: string | null;
}

/** Selección de jugadores de la plantilla GLOBAL del equipo. */
export class SubmitRegistrationDto {
  @ApiProperty()
  @IsMongoId()
  teamId: string;

  @ApiProperty({ type: [String] })
  @ArrayMinSize(1, { message: 'Selecciona al menos un jugador' })
  @ArrayMaxSize(60)
  @ArrayUnique({ message: 'Hay jugadores repetidos' })
  @IsMongoId({ each: true })
  playerIds: string[];
}

export class RejectRegistrationDto {
  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 300 })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Trim()
  @IsString()
  @MaxLength(300)
  reason?: string | null;
}

export class RegistrationRequestsQueryDto {
  @ApiPropertyOptional({ enum: RegistrationRequestStatus })
  @IsOptional()
  @IsIn(Object.values(RegistrationRequestStatus))
  status?: RegistrationRequestStatus;
}

/** Progreso de una inscripción aún no enviada (se guarda solo mientras se avanza). */
export class SaveRegistrationDraftDto {
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Equipo elegido (debes administrarlo)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsMongoId()
  teamId?: string | null;

  @ApiProperty({ type: [String], description: 'Jugadores marcados (de la plantilla global)' })
  @ArrayMaxSize(60)
  @ArrayUnique({ message: 'Hay jugadores repetidos' })
  @IsMongoId({ each: true })
  playerIds: string[];

  @ApiProperty({ enum: ['team', 'players', 'review'] })
  @IsIn(['team', 'players', 'review'])
  step: 'team' | 'players' | 'review';
}
