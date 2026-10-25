import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsMongoId, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsISODateOnly, Trim } from '../../../common/validators.js';

/** 10A — nueva temporada a partir de un torneo anterior (POST /tournaments/:id/next-season). */
export class NextSeasonDto {
  @ApiProperty({ example: 'Liga Municipal Clausura 2027' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ example: '2027-08-01', description: 'YYYY-MM-DD' })
  @IsISODateOnly()
  startDate: string;

  @ApiPropertyOptional({ example: '2027-12-15', nullable: true, type: String })
  @IsOptional()
  @IsISODateOnly()
  endDate?: string | null;

  @ApiPropertyOptional({ example: 'Clausura 2027', description: 'Temporada (información del torneo). Vacía si no se indica.' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(60)
  season?: string;

  @ApiPropertyOptional({ type: [String], description: 'Equipos a inscribir (de los que participaron). Por defecto, los que no se retiraron.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(128)
  @IsMongoId({ each: true })
  teamIds?: string[];
}

/** 10C — corrección explícita de un nombre histórico (POST /tournaments/:id/identity/corrections). */
export class IdentityCorrectionDto {
  @ApiProperty({ enum: ['TEAM', 'PLAYER', 'LEAGUE'] })
  @IsIn(['TEAM', 'PLAYER', 'LEAGUE'])
  kind: 'TEAM' | 'PLAYER' | 'LEAGUE';

  @ApiPropertyOptional({ description: 'Equipo o jugador (no aplica a LEAGUE)' })
  @ValidateIf((o: IdentityCorrectionDto) => o.kind !== 'LEAGUE')
  @IsMongoId()
  refId?: string;

  @ApiPropertyOptional({ description: 'TEAM y LEAGUE' })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'TEAM' })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(12)
  shortName?: string;

  @ApiPropertyOptional({ description: 'PLAYER' })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  firstName?: string;

  @ApiPropertyOptional({ description: 'PLAYER' })
  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName?: string;

  @ApiPropertyOptional({ description: 'PLAYER', nullable: true, type: String })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(40)
  nickname?: string | null;

  @ApiProperty({ example: 'El acta oficial registra «Halcones FC»' })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(300)
  reason: string;
}
