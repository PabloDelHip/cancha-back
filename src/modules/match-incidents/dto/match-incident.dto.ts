import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { MatchIncidentType } from '../../../common/enums/index.js';
import { Trim } from '../../../common/validators.js';

export class ReportIncidentDto {
  @ApiProperty({ enum: MatchIncidentType, description: 'SUSPENSION deja el partido SUSPENDED (pendiente de decisión); el resto es informativa' })
  @IsEnum(MatchIncidentType)
  type: MatchIncidentType;

  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  description: string;

  @ApiPropertyOptional({ description: 'Cuándo ocurrió (ISO 8601). Por defecto, ahora.' })
  @IsOptional()
  @IsDateString()
  occurredAt?: string;
}

export class ResolveIncidentDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Cómo se resolvió' })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  note: string;
}

export class VoidIncidentDto {
  @ApiProperty({ minLength: 3, maxLength: 300, description: 'Por qué se anula (se registró por error)' })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
}
