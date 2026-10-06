import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MatchStatus } from '../../../common/enums/index.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { IsISODateOnly, IsTime, Trim } from '../../../common/validators.js';

/** Un partido se crea sin resultado; FINISHED solo se alcanza capturando el resultado. */
const CREATABLE_STATUSES = [
  MatchStatus.SCHEDULED,
  MatchStatus.LIVE,
  MatchStatus.CANCELLED,
] as const;

export class CreateMatchDto {
  @ApiProperty()
  @IsMongoId()
  tournamentId: string;

  @ApiProperty({ example: 1, description: 'Jornada' })
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

  @ApiProperty({ example: '2027-01-16', description: 'Fecha local YYYY-MM-DD' })
  @IsISODateOnly()
  date: string;

  @ApiProperty({ example: '19:30', description: 'Hora local HH:mm' })
  @IsTime()
  time: string;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  venue?: string | null;

  @ApiPropertyOptional({
    enum: CREATABLE_STATUSES,
    default: MatchStatus.SCHEDULED,
  })
  @IsOptional()
  @IsIn(CREATABLE_STATUSES, {
    message:
      'status debe ser SCHEDULED, LIVE o CANCELLED; para finalizar usa PUT /matches/:id/result',
  })
  status?: MatchStatus;
}

export class UpdateMatchDto extends PartialType(
  OmitType(CreateMatchDto, ['status'] as const),
) {
  @ApiPropertyOptional({
    enum: MatchStatus,
    description: 'FINISHED solo si el partido ya tiene marcador',
  })
  @IsOptional()
  @IsEnum(MatchStatus)
  status?: MatchStatus;
}

export class MatchQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  tournamentId?: string;

  @ApiPropertyOptional({
    description: 'Partidos donde juega este equipo (local o visitante)',
  })
  @IsOptional()
  @IsMongoId()
  teamId?: string;

  @ApiPropertyOptional({ enum: MatchStatus })
  @IsOptional()
  @IsEnum(MatchStatus)
  status?: MatchStatus;
}

export class PlayerStatInputDto {
  @ApiProperty()
  @IsMongoId()
  playerId: string;

  @ApiProperty({
    description: 'Equipo con el que jugó este partido (local o visitante)',
  })
  @IsMongoId()
  teamId: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  played: boolean = true;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(99)
  goals: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(99)
  assists: number;

  @ApiPropertyOptional({ minimum: 0, default: 0, description: 'Autogoles: suman al marcador del rival, no a los goles del jugador' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9)
  ownGoals: number = 0;

  @ApiProperty({ minimum: 0, maximum: 2 })
  @IsInt()
  @Min(0)
  @Max(2)
  yellowCards: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @IsInt()
  @Min(0)
  @Max(1)
  redCards: number;
}

const RESULT_STATUSES = [MatchStatus.LIVE, MatchStatus.FINISHED] as const;

export class PenaltiesDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(99)
  home: number;

  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(99)
  away: number;
}

export class SaveResultDto {
  @ApiProperty({ example: 3 })
  @IsInt()
  @Min(0)
  @Max(99)
  homeScore: number;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(0)
  @Max(99)
  awayScore: number;

  @ApiPropertyOptional({ enum: RESULT_STATUSES, default: MatchStatus.FINISHED })
  @IsOptional()
  @IsIn(RESULT_STATUSES)
  status: MatchStatus = MatchStatus.FINISHED;

  @ApiPropertyOptional({
    type: PenaltiesDto,
    nullable: true,
    description:
      'Tanda de penales: en el partido que cierra una eliminatoria igualada, o en un empate de liga/grupos si el torneo da punto extra (pointsForShootoutWin)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PenaltiesDto)
  penalties?: PenaltiesDto | null;

  @ApiPropertyOptional({ description: 'Se jugaron tiempos extra (solo en la llave cuya regla es EXTRA_TIME; el marcador los incluye)' })
  @IsOptional()
  @IsBoolean()
  extraTime?: boolean;

  @ApiProperty({
    type: [PlayerStatInputDto],
    description: 'Reemplaza por completo las estadísticas del partido',
  })
  @IsArray()
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => PlayerStatInputDto)
  playerStats: PlayerStatInputDto[];
}
