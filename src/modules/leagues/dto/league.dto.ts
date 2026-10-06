import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../common/validators.js';

export class CreateLeagueDto {
  @ApiProperty({ example: 'Liga Fut 7 Cancún' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ example: 'Cancún, Q. Roo', nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  city?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

export class UpdateLeagueDto extends PartialType(CreateLeagueDto) {}
