import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CompetitionSystem,
  DataCoverage,
  KnockoutTiebreak,
  TournamentFormat,
  TournamentStatus,
} from '../../../common/enums/index.js';

/**
 * Configuración deportiva: formato y puntuación. La coherencia entre valores (victoria > empate ≥
 * derrota, clasificados que formen un cuadro válido…) se valida en el service con la configuración
 * vigente (competition/formats.ts).
 */
export class TournamentSettingsDto {
  @ApiPropertyOptional({ enum: CompetitionSystem, default: CompetitionSystem.LEAGUE })
  @IsOptional()
  @IsEnum(CompetitionSystem, {
    message: 'system debe ser LEAGUE, KNOCKOUT, GROUPS_KNOCKOUT o LEAGUE_PLAYOFFS',
  })
  system?: CompetitionSystem;

  @ApiPropertyOptional({ enum: [1, 2], description: 'Vueltas de liga o de grupos' })
  @IsOptional()
  @IsIn([1, 2])
  roundRobinLegs?: 1 | 2;

  @ApiPropertyOptional({ enum: [1, 2], description: '1 = partido único, 2 = ida y vuelta' })
  @IsOptional()
  @IsIn([1, 2])
  knockoutLegs?: 1 | 2;

  @ApiPropertyOptional({ minimum: 2, maximum: 8, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(8)
  groupCount?: number | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 16, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(16)
  qualifiersPerGroup?: number | null;

  @ApiPropertyOptional({ enum: [2, 4, 8, 16], nullable: true })
  @IsOptional()
  @IsIn([2, 4, 8, 16])
  playoffTeams?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 10, default: 3 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  pointsForWin?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  pointsForDraw?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  pointsForLoss?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10,
    nullable: true,
    description: 'Empates de liga/grupos en penales: puntos EXTRA para el ganador de la tanda. null = sin penales en empates.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  pointsForShootoutWin?: number | null;

  @ApiPropertyOptional({ enum: KnockoutTiebreak, default: KnockoutTiebreak.PENALTIES, description: 'Llave de eliminatoria igualada. BETTER_POSITION solo en LEAGUE_PLAYOFFS.' })
  @IsOptional()
  @IsEnum(KnockoutTiebreak)
  knockoutTiebreak?: KnockoutTiebreak;

  @ApiPropertyOptional({ default: false, description: 'Reacomodo: la 1ª ronda sale de la siembra y las siguientes las arma el organizador a mano (false = cuadro fijo)' })
  @IsOptional()
  @IsBoolean()
  reseed?: boolean;

  @ApiPropertyOptional({ enum: KnockoutTiebreak, nullable: true, description: 'Regla propia de la final; null = la misma que el resto.' })
  @IsOptional()
  @IsEnum(KnockoutTiebreak)
  finalTiebreak?: KnockoutTiebreak | null;
}

/** Al crear, un torneo empieza en DRAFT (o ACTIVE). Después solo cambia con start/finish. */
const CREATABLE_STATUSES = [TournamentStatus.DRAFT, TournamentStatus.ACTIVE] as const;
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { IsISODateOnly, Trim } from '../../../common/validators.js';

export class CreateTournamentDto {
  @ApiProperty({ example: 'Liga Mazatlán Apertura 2027' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ enum: TournamentFormat })
  @IsEnum(TournamentFormat)
  format: TournamentFormat;

  @ApiProperty({ example: 'Libre varonil' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  category: string;

  @ApiProperty({ example: '2027-01-16', description: 'YYYY-MM-DD' })
  @IsISODateOnly()
  startDate: string;

  @ApiPropertyOptional({ example: '2027-03-20', nullable: true, type: String })
  @IsOptional()
  @IsISODateOnly()
  endDate?: string | null;

  @ApiPropertyOptional({
    enum: CREATABLE_STATUSES,
    default: TournamentStatus.DRAFT,
    description: 'Solo al crear. Después: POST /tournaments/:id/start y /finish.',
  })
  @IsOptional()
  @IsIn(CREATABLE_STATUSES, {
    message: 'status debe ser DRAFT o ACTIVE; un torneo se finaliza con POST /tournaments/:id/finish',
  })
  status?: TournamentStatus;

  @ApiPropertyOptional({
    example: 'Unidad Deportiva Benito Juárez',
    nullable: true,
    type: String,
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  venue?: string | null;

  @ApiPropertyOptional({ type: TournamentSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TournamentSettingsDto)
  settings?: TournamentSettingsDto;

  @ApiPropertyOptional({
    enum: DataCoverage,
    default: DataCoverage.FULL,
    description: 'FULL: competición completa. PARTIAL: solo se sigue a algunos equipos (sin tabla ni goleadores globales).',
  })
  @IsOptional()
  @IsEnum(DataCoverage, { message: 'dataCoverage debe ser FULL o PARTIAL' })
  dataCoverage?: DataCoverage;
}

/** El estado NO se cambia por PATCH: las transiciones tienen acciones propias. */
export class UpdateTournamentDto extends PartialType(OmitType(CreateTournamentDto, ['status'] as const)) {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Solo cobertura PARTIAL: equipos en seguimiento (deben estar inscritos en el torneo; sin repetidos). Reemplaza la lista completa. En FULL se vacía sola.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(128)
  @ArrayUnique({ message: 'trackedTeamIds no puede repetir equipos' })
  @IsMongoId({ each: true, message: 'trackedTeamIds debe contener ids de equipo válidos' })
  trackedTeamIds?: string[];

  @ApiPropertyOptional({
    description:
      'Confirmación para cambiar formato/estructura cuando ya hay un calendario generado SIN jugar: se borran sus partidos y jornadas.',
  })
  @IsOptional()
  @IsBoolean()
  resetSchedule?: boolean;
}

export class FinishTournamentDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Confirmación explícita para finalizar con partidos sin jugar (programados, en juego o pospuestos).',
  })
  @IsOptional()
  @IsBoolean()
  allowPendingMatches?: boolean;
}

export class TournamentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TournamentStatus })
  @IsOptional()
  @IsEnum(TournamentStatus)
  status?: TournamentStatus;
}

export class EnrollmentQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  tournamentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  teamId?: string;
}
