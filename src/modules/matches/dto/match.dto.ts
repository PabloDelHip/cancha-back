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
import { MatchStatus, SendOff } from '../../../common/enums/index.js';
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
    nullable: true,
    type: String,
    description: 'Cancha de una sede del organizador. Con cancha, `venue` se deriva de ella. null = quitarla.',
  })
  @IsOptional()
  @IsMongoId()
  fieldId?: string | null;

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

/** Lo que el organizador confirmó liberar en la vista previa de una reprogramación (2C-2). */
export class ReleaseDto {
  @ApiProperty({ description: 'Liberar la cancha (choca en el nuevo horario)' })
  @IsBoolean()
  field: boolean;

  @ApiProperty({ type: [String], description: 'Asignaciones arbitrales a liberar (las que chocan)' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsMongoId({ each: true })
  assignmentIds: string[];
}

export class UpdateMatchDto extends PartialType(
  OmitType(CreateMatchDto, ['status'] as const),
) {
  @ApiPropertyOptional({
    type: ReleaseDto,
    description:
      'Confirmación de una vista previa de reprogramación: se libera exactamente esto. Si ya no coincide con lo que choca → 409 RESCHEDULE_STALE con la vista previa nueva. Sin este campo, un choque responde 409 como siempre.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReleaseDto)
  release?: ReleaseDto;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 300,
    description: 'Motivo (queda en el historial). Obligatorio con el torneo en curso al cambiar fecha u hora, posponer o cancelar.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  reason?: string | null;

  @ApiPropertyOptional({
    enum: MatchStatus,
    description: 'FINISHED solo si el partido ya tiene marcador',
  })
  @IsOptional()
  @IsEnum(MatchStatus)
  status?: MatchStatus;
}

export class ReschedulePreviewDto {
  @ApiProperty({ example: '2027-01-16' })
  @IsISODateOnly()
  date: string;

  @ApiProperty({ example: '19:30' })
  @IsTime()
  time: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Cancha en el nuevo horario. Omitido = la actual; null = sin cancha.' })
  @IsOptional()
  @IsMongoId()
  fieldId?: string | null;

  @ApiPropertyOptional({ enum: MatchStatus, description: 'Estado con el que quedará (por defecto, el actual)' })
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

  @ApiPropertyOptional({
    enum: SendOff,
    nullable: true,
    description:
      'Tipo de expulsión: DIRECT (roja directa, con 0 o 1 amarilla previa), SECOND_YELLOW (2 amarillas + roja) o null (sin expulsión). Si se omite, la fila queda sin clasificar y no genera sanción automática.',
  })
  @IsOptional()
  @IsEnum(SendOff)
  sendOff?: SendOff | null;
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
