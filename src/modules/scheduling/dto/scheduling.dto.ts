import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsISODateOnly, IsTime, Trim } from '../../../common/validators.js';
import { SOFT_RULES, type SoftRule } from '../scheduling-rules.js';

const CLOCK = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/** Restricciones del torneo. Campo omitido = se conserva; null = se quita. */
export class UpdateTournamentSchedulingDto {
  @ApiPropertyOptional({ nullable: true, type: String, example: 'America/Mazatlan', description: 'Zona IANA. null = la de las ligas' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  timeZone?: string | null;

  @ApiPropertyOptional({ type: [Number], description: 'Días permitidos (0 = domingo). Vacío = cualquier día' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days?: number[];

  @ApiPropertyOptional({ nullable: true, type: String, example: '08:00' })
  @IsOptional()
  @IsTime()
  startTime?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: '23:00', description: 'Admite 24:00' })
  @IsOptional()
  @Matches(CLOCK, { message: 'endTime debe ser HH:mm (o 24:00)' })
  endTime?: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 10, maximum: 300, description: 'Duración estimada (la misma de la información del torneo)' })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(300)
  durationMinutes?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 0, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  fieldGapMinutes?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxMatchesPerDay?: number | null;

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 1, maximum: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  maxSimultaneous?: number | null;

  @ApiPropertyOptional({ enum: ['WARN', 'BLOCK'] })
  @IsOptional()
  @IsIn(['WARN', 'BLOCK'])
  fieldAvailability?: 'WARN' | 'BLOCK';

  @ApiPropertyOptional({ type: [String], enum: SOFT_RULES, description: '6B: reglas generales que son preferencia (avisan, no bloquean)' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SOFT_RULES, { each: true })
  softRules?: SoftRule[];
}

export class TimeRangeDto {
  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 0, maximum: 6, description: 'null = todos los días' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  day: number | null = null;

  @ApiProperty({ example: '14:00' })
  @Matches(CLOCK, { message: 'from debe ser HH:mm' })
  from: string;

  @ApiProperty({ example: '18:00', description: 'Admite 24:00' })
  @Matches(CLOCK, { message: 'to debe ser HH:mm (o 24:00)' })
  to: string;
}

/** Restricciones de un equipo en el torneo (reemplazo completo). */
export class TeamSchedulingDto {
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  unavailableDays: number[] = [];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @ArrayUnique()
  @IsISODateOnly({ each: true })
  unavailableDates: string[] = [];

  @ApiPropertyOptional({ type: [TimeRangeDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => TimeRangeDto)
  unavailableTimes: TimeRangeDto[] = [];

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 0, maximum: 336 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(336)
  minRestHours: number | null = null;

  @ApiPropertyOptional({ nullable: true, type: Number, minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxMatchesPerDay: number | null = null;

  @ApiPropertyOptional({ default: true, description: 'true = obligatoria; false = preferencia (solo avisa)' })
  @IsOptional()
  @IsBoolean()
  strict: boolean = true;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 300 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  notes: string | null = null;
}

export class TeamSchedulingPreviewDto {
  @ApiProperty()
  @IsMongoId()
  teamId: string;

  @ApiProperty({ type: TeamSchedulingDto })
  @ValidateNested()
  @Type(() => TeamSchedulingDto)
  rules: TeamSchedulingDto;
}

/** Vista previa: los conflictos que tendrían los partidos programados con esta configuración. */
export class SchedulingPreviewDto {
  @ApiPropertyOptional({ type: UpdateTournamentSchedulingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateTournamentSchedulingDto)
  tournament?: UpdateTournamentSchedulingDto;

  @ApiPropertyOptional({ type: TeamSchedulingPreviewDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TeamSchedulingPreviewDto)
  team?: TeamSchedulingPreviewDto;
}

/** Revisar un partido propuesto (el formulario lo consulta en vivo; el servidor revalida al guardar). */
export class SchedulingCheckDto {
  @ApiPropertyOptional({ description: 'Partido que se reprograma (se excluye de los demás)' })
  @IsOptional()
  @IsMongoId()
  matchId?: string;

  @ApiProperty()
  @IsMongoId()
  homeTeamId: string;

  @ApiProperty()
  @IsMongoId()
  awayTeamId: string;

  @ApiProperty({ example: '2027-01-16' })
  @IsISODateOnly()
  date: string;

  @ApiProperty({ example: '19:30' })
  @IsTime()
  time: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsMongoId()
  fieldId?: string | null;
}
