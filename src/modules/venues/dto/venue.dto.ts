import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { IsISODateOnly, IsTime, Trim } from '../../../common/validators.js';

const WINDOW_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

export class WeeklyWindowDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = domingo' })
  @IsInt()
  @Min(0)
  @Max(6)
  day: number;

  @ApiProperty({ example: '08:00' })
  @Matches(WINDOW_TIME, { message: 'from debe ser HH:mm' })
  from: string;

  @ApiProperty({ example: '23:00', description: 'Admite 24:00' })
  @Matches(WINDOW_TIME, { message: 'to debe ser HH:mm (o 24:00)' })
  to: string;
}

export class AvailabilityDto {
  @ApiProperty({ type: [WeeklyWindowDto], description: 'Vacío = sin restricción de horario' })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WeeklyWindowDto)
  weekly: WeeklyWindowDto[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(366)
  @IsISODateOnly({ each: true })
  closedDates: string[];
}

export class CreateFieldDto {
  @ApiProperty({ maxLength: 60 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name: string;

  @ApiPropertyOptional({ type: AvailabilityDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AvailabilityDto)
  availability?: AvailabilityDto;
}

export class UpdateFieldDto extends PartialType(CreateFieldDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateVenueDto {
  @ApiProperty({ maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 200 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(200)
  address?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 120, default: 15 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  bufferMinutes?: number;

  @ApiPropertyOptional({ type: [CreateFieldDto], description: 'Canchas iniciales' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => CreateFieldDto)
  fields?: CreateFieldDto[];
}

export class UpdateVenueDto extends PartialType(CreateVenueDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CheckSlotQueryDto {
  @ApiProperty()
  @IsMongoId()
  fieldId: string;

  @ApiProperty()
  @IsMongoId()
  tournamentId: string;

  @ApiProperty({ example: '2027-01-16' })
  @IsISODateOnly()
  date: string;

  @ApiProperty({ example: '19:30' })
  @IsTime()
  time: string;

  @ApiPropertyOptional({ description: 'Partido que se está editando (no choca consigo mismo)' })
  @IsOptional()
  @IsMongoId()
  matchId?: string;
}
