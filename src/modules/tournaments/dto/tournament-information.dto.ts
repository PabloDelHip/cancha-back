import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUrl, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { IsISODateOnly, Trim } from '../../../common/validators.js';
import { TOURNAMENT_CONTACT_FIELDS, type TournamentContactField } from '../schemas/tournament-information.schema.js';

export class TournamentScheduleDto {
  @ApiPropertyOptional({ type: [Number], example: [6, 7], maxItems: 7, uniqueItems: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  days?: number[];

  @ApiPropertyOptional({ type: String, nullable: true, example: '08:00' })
  @IsOptional()
  @Trim()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  startTime?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '08:00' })
  @IsOptional()
  @Trim()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  endTime?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 1440 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({ type: Boolean })
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  variable?: boolean;

}

export class TournamentEnrollmentDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Fecha de apertura informativa, YYYY-MM-DD' })
  @IsOptional()
  @Trim()
  @IsISODateOnly()
  opensOn?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 1000000000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1000000000)
  teamFee?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 1000000000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1000000000)
  playerFee?: number | null;

  @ApiPropertyOptional({ enum: ['free', 'paid'], nullable: true })
  @IsOptional()
  @Trim()
  @IsIn(['free', 'paid'])
  paymentMode?: 'free' | 'paid' | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(4000)
  instructions?: string | null;

}

export class TournamentCostsDto {
  @ApiPropertyOptional({ type: String, default: 'MXN', pattern: '^[A-Z]{3}$' })
  @ValidateIf((_, value) => value !== undefined)
  @Trim()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 1000000000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1000000000)
  refereeFee?: number | null;

  @ApiPropertyOptional({ enum: ['team', 'match'], default: 'match' })
  @ValidateIf((_, value) => value !== undefined)
  @Trim()
  @IsIn(['team', 'match'])
  refereeBilling?: 'team' | 'match';

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 1000000000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1000000000)
  venueFee?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 1000000000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1000000000)
  adminFee?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  adminDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(4000)
  paymentNotes?: string | null;

}

export class TournamentRulesDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 20000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(20000)
  text?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 4000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(4000)
  notes?: string | null;

}

export class TournamentAwardsDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  champion?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  runnerUp?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  topScorer?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  other?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

}

export class TournamentContactDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  name?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 30 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(30)
  @Matches(/^[+()\d .-]{7,30}$/)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 254 })
  @IsOptional()
  @Trim()
  @MaxLength(254)
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @Trim()
  @MaxLength(500)
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true, require_tld: true })
  facebook?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @Trim()
  @MaxLength(500)
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true, require_tld: true })
  instagram?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({ enum: TOURNAMENT_CONTACT_FIELDS, isArray: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(6)
  @ArrayUnique()
  @IsIn(TOURNAMENT_CONTACT_FIELDS, { each: true })
  publicFields?: TournamentContactField[];

}

export class TournamentInformationDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  season?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 6000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(6000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  city?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  state?: string | null;

  @ApiPropertyOptional({ type: TournamentScheduleDto })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => TournamentScheduleDto)
  schedule?: TournamentScheduleDto;

  @ApiPropertyOptional({ type: TournamentEnrollmentDto })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => TournamentEnrollmentDto)
  enrollment?: TournamentEnrollmentDto;

  @ApiPropertyOptional({ type: TournamentCostsDto })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => TournamentCostsDto)
  costs?: TournamentCostsDto;

  @ApiPropertyOptional({ type: TournamentRulesDto })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => TournamentRulesDto)
  rules?: TournamentRulesDto;

  @ApiPropertyOptional({ type: TournamentAwardsDto })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => TournamentAwardsDto)
  awards?: TournamentAwardsDto;

  @ApiPropertyOptional({ type: TournamentContactDto })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => TournamentContactDto)
  contact?: TournamentContactDto;

}
