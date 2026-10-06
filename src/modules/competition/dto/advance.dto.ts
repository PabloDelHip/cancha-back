import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { IsISODateOnly, IsTime, Trim } from '../../../common/validators.js';

/** Orden que decide el organizador para un empate sin criterio deportivo (queda registrado). */
export class TiebreakDto {
  @ApiProperty({ example: 'LEAGUE', description: "'LEAGUE' o la clave del grupo ('A', 'B'…)" })
  @IsString()
  @MaxLength(10)
  scope: string;

  @ApiProperty({ type: [String], description: 'Los equipos empatados, en el orden decidido' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(64)
  @IsMongoId({ each: true })
  order: string[];
}

/** Generar la fase siguiente (eliminatoria) a partir de la tabla o los grupos terminados. */
export class AdvancePhaseDto {
  @ApiPropertyOptional({
    description:
      'Armar la eliminatoria a mano: el organizador elige los cruces de cada ronda. No exige la fase anterior terminada ni desempates, y no la congela.',
  })
  @IsOptional()
  @IsBoolean()
  manual?: boolean;

  @ApiPropertyOptional({ enum: [2, 4, 8, 16, 32, 64], description: 'A mano: equipos de la primera ronda (8 = cuartos de final)' })
  @ValidateIf((o: AdvancePhaseDto) => !!o.manual)
  @IsIn([2, 4, 8, 16, 32, 64])
  bracketSize?: number;

  @ApiProperty({ example: '2027-05-01', description: 'Fecha de la primera ronda eliminatoria (no se usa al armar a mano)' })
  @ValidateIf((o: AdvancePhaseDto) => !o.manual)
  @IsISODateOnly()
  startDate: string;

  @ApiPropertyOptional({ default: 7 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  daysBetweenRounds: number = 7;

  @ApiPropertyOptional({ default: '18:00' })
  @IsOptional()
  @IsTime()
  firstKickoff: string = '18:00';

  @ApiPropertyOptional({ default: 90 })
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

  @ApiPropertyOptional({ type: [TiebreakDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => TiebreakDto)
  tiebreaks?: TiebreakDto[];
}

/** Fecha, hora y sede de un partido de un cruce armado a mano. */
export class TieLegDto {
  @ApiProperty({ example: '2027-05-08' })
  @IsISODateOnly()
  date: string;

  @ApiProperty({ example: '18:00' })
  @IsTime()
  time: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  venue?: string | null;
}

/** Cruce de un cuadro armado a mano: ronda, equipos y sus partidos (uno, o ida y vuelta). */
export class CreateTieDto {
  @ApiProperty({ example: 0, description: 'Ronda del cuadro (0 = la primera; la última es la final)' })
  @IsInt()
  @Min(0)
  @Max(5)
  round: number;

  @ApiProperty({ description: 'Local del primer partido (el único, o la ida)' })
  @IsMongoId()
  homeTeamId: string;

  @ApiProperty({ description: 'Visitante del primer partido' })
  @IsMongoId()
  awayTeamId: string;

  @ApiProperty({ type: [TieLegDto], description: 'Un partido por cada partido de la llave (1, o 2 si es ida y vuelta)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => TieLegDto)
  legs: TieLegDto[];
}
