import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsMongoId,
  IsNumber,
  Max,
  Min,
  IsNotEmpty,
  IsOptional,
  IsString,
  Equals,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { Trim } from '../../../common/validators.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

export class TeamColorsDto {
  @ApiProperty({ example: '#0f766e' })
  @Matches(HEX, { message: 'primary debe ser un color hexadecimal #RRGGBB' })
  primary: string;

  @ApiProperty({ example: '#facc15' })
  @Matches(HEX, { message: 'secondary debe ser un color hexadecimal #RRGGBB' })
  secondary: string;
}

export class CreateTeamDto {
  @ApiProperty({ example: 'Halcones FC' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({
    example: 'HAL',
    description: '2–4 caracteres. Si se omite se deriva del nombre.',
  })
  @IsOptional()
  @Trim()
  @Matches(/^[A-Za-zÁÉÍÓÚÑáéíóúñ0-9]{2,4}$/, {
    message: 'shortName debe tener entre 2 y 4 letras o números',
  })
  shortName?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    enum: [null],
    description: 'Solo `null` (quitar la imagen). La imagen se sube con PUT /teams/:id/logo: la URL la genera Cloudinary, nunca el cliente.',
  })
  @IsOptional()
  @Equals(null, { message: 'logoUrl: la imagen se sube con PUT /teams/:id/logo; aquí solo se acepta null para quitarla' })
  logoUrl?: null;

  @ApiPropertyOptional({ type: TeamColorsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TeamColorsDto)
  colors?: TeamColorsDto;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'Cancún, Q. Roo',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(80)
  city?: string | null;
}

export class CoverPositionDto {
  @ApiProperty({ minimum: 0, maximum: 100, example: 50 })
  @IsNumber()
  @Min(0)
  @Max(100)
  x: number;

  @ApiProperty({ minimum: 0, maximum: 100, example: 70 })
  @IsNumber()
  @Min(0)
  @Max(100)
  y: number;
}

export class UpdateTeamDto extends PartialType(CreateTeamDto) {
  @ApiPropertyOptional({ type: CoverPositionDto, description: 'Encuadre de la portada (punto central en %). La foto se sube con PUT /teams/:id/cover.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoverPositionDto)
  coverPosition?: CoverPositionDto;
}

export class TeamQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Busca por nombre' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ description: 'Solo equipos inscritos en este torneo' })
  @IsOptional()
  @IsMongoId()
  tournamentId?: string;
}
