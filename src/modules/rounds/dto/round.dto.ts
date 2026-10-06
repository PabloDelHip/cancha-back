import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
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

/** Generación del calendario de liga con los equipos inscritos. */
export class GenerateScheduleDto {
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
}
