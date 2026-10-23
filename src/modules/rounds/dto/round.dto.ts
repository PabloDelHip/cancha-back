import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { IsISODateOnly, IsTime, Trim } from '../../../common/validators.js';

/** Crear o renombrar una jornada (PUT idempotente por número). */
export class SaveRoundDto {
  @ApiPropertyOptional({ nullable: true, type: String, example: 'Jornada 11 · Reprogramados' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  name?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Fecha de referencia YYYY-MM-DD' })
  @IsOptional()
  @IsISODateOnly()
  date?: string | null;
}

export class RoundQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  tournamentId?: string;
}

/** 6B: horario elegido para un partido de la propuesta (la confirmación lo revalida todo). */
export class ScheduleAssignmentDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(99)
  round: number;

  @ApiProperty()
  @IsMongoId()
  homeTeamId: string;

  @ApiProperty()
  @IsMongoId()
  awayTeamId: string;

  @ApiProperty({ example: '2027-04-10' })
  @IsISODateOnly()
  date: string;

  @ApiProperty({ example: '18:00' })
  @IsTime()
  time: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @IsMongoId()
  fieldId?: string | null;
}

/**
 * 6B: búsqueda de horarios (vista previa) y confirmación. Compartido por el calendario inicial y la
 * eliminatoria automática.
 */
export class SmartScheduleFields {
  @ApiPropertyOptional({ description: 'Último día del periodo de búsqueda (por defecto, según las jornadas; máximo 366 días)' })
  @IsOptional()
  @IsISODateOnly()
  endDate?: string;

  @ApiPropertyOptional({ type: [Number], description: 'Días de la semana en que buscar (0 = domingo). Vacío = los del torneo' })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  days?: number[];

  @ApiPropertyOptional({ description: 'Último inicio posible (por defecto, el fin del horario del torneo menos la duración, o 22:00)' })
  @IsOptional()
  @IsTime()
  lastKickoff?: string;

  @ApiPropertyOptional({ type: [String], description: 'Canchas a usar (del propietario). Vacío = sin cancha' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsMongoId({ each: true })
  fieldIds?: string[];

  @ApiPropertyOptional({ minimum: 1, maximum: 30, description: 'Sin canchas: partidos del torneo a la vez (por defecto 1)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  parallel?: number;

  @ApiPropertyOptional({ minimum: 0, description: '6C: confirmar que quedan exactamente N partidos sin horario («por programar»)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  allowPending?: number;

  @ApiPropertyOptional({ type: [ScheduleAssignmentDto], description: 'Confirmar una propuesta: el horario de cada partido' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ScheduleAssignmentDto)
  assignments?: ScheduleAssignmentDto[];
}

/** Generación del calendario de liga con los equipos inscritos. */
export class GenerateScheduleDto extends SmartScheduleFields {
  @ApiPropertyOptional({ enum: [1, 2], description: 'Vueltas de liga o grupos (por defecto, settings.roundRobinLegs)' })
  @IsOptional()
  @IsIn([1, 2])
  legs?: 1 | 2;

  @ApiPropertyOptional({
    type: [String],
    description: 'Orden de siembra (ids de los equipos inscritos, 1 = mejor). Por defecto, orden alfabético.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsMongoId({ each: true })
  seeding?: string[];

  @ApiPropertyOptional({
    description: 'Grupos explícitos (GROUPS_KNOCKOUT): una lista de ids por grupo. Por defecto se reparten según la siembra.',
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsArray({ each: true })
  groups?: string[][];

  @ApiPropertyOptional({
    description:
      'Armar a mano: crea la estructura (grupos o cuadro vacío) SIN partidos; el organizador programa sus jornadas y, en eliminación directa, arma cada cruce.',
  })
  @IsOptional()
  @IsBoolean()
  manual?: boolean;

  @ApiPropertyOptional({ enum: [2, 4, 8, 16, 32, 64], description: 'Eliminación directa a mano: equipos de la primera ronda (8 = cuartos)' })
  @IsOptional()
  @IsIn([2, 4, 8, 16, 32, 64])
  bracketSize?: number;

  @ApiProperty({ example: '2027-04-10', description: 'Fecha de la jornada 1 (no se usa al armar a mano)' })
  @ValidateIf((o: GenerateScheduleDto) => !o.manual)
  @IsISODateOnly()
  startDate: string;

  @ApiPropertyOptional({ default: 7, minimum: 1, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  daysBetweenRounds: number = 7;

  @ApiPropertyOptional({ default: '18:00', description: 'Hora del primer partido de cada jornada' })
  @IsOptional()
  @IsTime()
  firstKickoff: string = '18:00';

  @ApiPropertyOptional({ default: 90, minimum: 0, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  minutesBetweenMatches: number = 90;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  venue?: string | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Confirmación explícita para reemplazar partidos ya programados (sin resultado).',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  replaceExisting: boolean = false;

  @ApiPropertyOptional({
    description: 'Confirmación explícita para borrar partidos con cancha o árbitros asignados (se liberan esas asignaciones).',
  })
  @IsOptional()
  @IsBoolean()
  releaseAssignments?: boolean;
}
