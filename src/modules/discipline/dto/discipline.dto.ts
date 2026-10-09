import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { EligibilityMode } from '../../../common/enums/index.js';

export class UpdateDisciplineRulesDto {
  @ApiPropertyOptional({ description: 'Genera sanciones automáticas' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ nullable: true, minimum: 2, maximum: 20, description: 'Cada cuántas amarillas se suspende; null = sin acumulación' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(2)
  @Max(20)
  yellowsForSuspension?: number | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  accumulationMatches?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  directRedMatches?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20)
  secondYellowMatches?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  resetAccumulationOnPhaseChange?: boolean;

  @ApiPropertyOptional({ enum: EligibilityMode })
  @IsOptional()
  @IsEnum(EligibilityMode)
  eligibility?: EligibilityMode;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  justification?: string;
}

export class CreateSanctionDto {
  @ApiProperty()
  @IsMongoId()
  playerId: string;

  @ApiProperty()
  @IsMongoId()
  teamId: string;

  @ApiProperty({ description: 'Partido desde el que aplica (incluido)' })
  @IsMongoId()
  matchId: string;

  @ApiProperty({ minimum: 1, maximum: 50 })
  @IsInt()
  @Min(1)
  @Max(50)
  matches: number;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class JustificationDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  justification: string;
}

export class UpdateSanctionDto extends JustificationDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 50, description: 'Automáticas: null vuelve a lo que marca el reglamento' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(50)
  matches?: number | null;

  @ApiPropertyOptional({ description: 'Solo manuales' })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ description: 'Solo manuales' })
  @IsOptional()
  @IsMongoId()
  matchId?: string;
}

export class HistoryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  ref?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  playerId?: string;
}
