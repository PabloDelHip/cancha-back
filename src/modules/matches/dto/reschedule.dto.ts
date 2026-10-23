import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsISO8601, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsISODateOnly, IsTime, Trim } from '../../../common/validators.js';

/** 6C — qué partidos reprogramar. Los filtros se combinan (Y); al menos uno. */
export class RescheduleSelectionDto {
  @ApiPropertyOptional({ type: [String], description: 'Partidos concretos (uno o varios)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsMongoId({ each: true })
  matchIds?: string[];

  @ApiPropertyOptional({ description: 'Una jornada' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  round?: number;

  @ApiPropertyOptional({ description: 'Desde (fecha del partido)' })
  @IsOptional()
  @IsISODateOnly()
  from?: string;

  @ApiPropertyOptional({ description: 'Hasta (fecha del partido)' })
  @IsOptional()
  @IsISODateOnly()
  to?: string;

  @ApiPropertyOptional({ description: 'Los partidos de una cancha (sin fechas: desde hoy)' })
  @IsOptional()
  @IsMongoId()
  fieldId?: string;

  @ApiPropertyOptional({ description: 'Los partidos de una sede (sin fechas: desde hoy)' })
  @IsOptional()
  @IsMongoId()
  venueId?: string;

  @ApiPropertyOptional({ description: 'Incluir los partidos por programar del torneo' })
  @IsOptional()
  @IsBoolean()
  pending?: boolean;
}

/** Dónde buscar. `fieldIds` omitido = las canchas que ya usan los partidos elegidos. */
export class RescheduleSearchDto {
  @ApiPropertyOptional({ description: 'Desde (por defecto hoy, en la zona del torneo)' })
  @IsOptional()
  @IsISODateOnly()
  from?: string;

  @ApiPropertyOptional({ description: 'Hasta (por defecto 6 semanas)' })
  @IsOptional()
  @IsISODateOnly()
  to?: string;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days?: number[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsTime()
  firstKickoff?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTime()
  lastKickoff?: string;

  @ApiPropertyOptional({ minimum: 5, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(240)
  step?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsMongoId({ each: true })
  fieldIds?: string[];

  @ApiPropertyOptional({ default: true, description: 'Conservar el horario de los que siguen siendo válidos' })
  @IsOptional()
  @IsBoolean()
  keepValid?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Fechas que no se pueden usar (p. ej. la sede cerrada)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ArrayUnique()
  @IsISODateOnly({ each: true })
  avoidDates?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Canchas que no se pueden usar' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsMongoId({ each: true })
  avoidFieldIds?: string[];
}

export class RescheduleProposalDto {
  @ApiProperty({ type: RescheduleSelectionDto })
  @ValidateNested()
  @Type(() => RescheduleSelectionDto)
  selection: RescheduleSelectionDto;

  @ApiPropertyOptional({ type: RescheduleSearchDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RescheduleSearchDto)
  search?: RescheduleSearchDto;
}

export class RescheduleItemDto {
  @ApiProperty()
  @IsMongoId()
  matchId: string;

  @ApiProperty({ description: 'La versión que se vio en la propuesta (updatedAt)' })
  @IsISO8601()
  version: string;

  @ApiProperty({ enum: ['KEEP', 'MOVE', 'PENDING'] })
  @IsIn(['KEEP', 'MOVE', 'PENDING'])
  action: 'KEEP' | 'MOVE' | 'PENDING';

  @ApiPropertyOptional()
  @IsOptional()
  @IsISODateOnly()
  date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTime()
  time?: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsMongoId()
  fieldId?: string | null;
}

export class RescheduleConfirmDto {
  @ApiPropertyOptional({ description: 'Motivo (obligatorio con el torneo en curso); queda en el historial de cada partido' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  reason?: string;

  @ApiProperty({ type: [RescheduleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RescheduleItemDto)
  items: RescheduleItemDto[];

  @ApiPropertyOptional({ minimum: 0, description: 'Confirmar que quedan exactamente N partidos por programar' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  allowPending?: number;
}
