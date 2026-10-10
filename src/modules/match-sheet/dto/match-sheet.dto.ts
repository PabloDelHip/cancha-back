import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { EvidenceKind } from '../../../common/enums/index.js';
import { Trim } from '../../../common/validators.js';

export class SheetPlayerDto {
  @ApiProperty()
  @IsMongoId()
  playerId: string;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 99, description: 'Dorsal en este partido; si se omite, el de su participación en el torneo' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(99)
  jerseyNumber?: number | null;

  @ApiProperty({ description: 'Titular (true) o suplente (false)' })
  @IsBoolean()
  starter: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  captain?: boolean;
}

export class SheetSubstitutionDto {
  @ApiProperty()
  @IsMongoId()
  outPlayerId: string;

  @ApiProperty()
  @IsMongoId()
  inPlayerId: string;

  @ApiProperty({ minimum: 0, maximum: 200 })
  @IsInt()
  @Min(0)
  @Max(200)
  minute: number;
}

/** Alineación y sustituciones de UN equipo (reemplaza las anteriores de ese equipo). */
export class SaveSheetTeamDto {
  @ApiProperty({ type: [SheetPlayerDto] })
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => SheetPlayerDto)
  players: SheetPlayerDto[];

  @ApiProperty({ type: [SheetSubstitutionDto] })
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => SheetSubstitutionDto)
  substitutions: SheetSubstitutionDto[];

  @ApiPropertyOptional({ nullable: true, maxLength: 300, description: 'Obligatorio al corregir la alineación de un partido ya finalizado' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  reason?: string | null;
}

export class SaveObservationsDto {
  @ApiProperty({ nullable: true, maxLength: 4000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(4000)
  observations: string | null;
}

export class ReopenSheetDto {
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
}

/** Campos de texto del multipart de una evidencia (el archivo va en `file`). */
export class UploadEvidenceDto {
  @ApiProperty({ enum: EvidenceKind })
  @IsEnum(EvidenceKind)
  kind: EvidenceKind;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ description: 'Incidencia del partido que documenta' })
  @IsOptional()
  @IsMongoId()
  incidentId?: string;

  @ApiProperty({ description: 'Clave única de la subida generada por el cliente (8–64 caracteres): reintentarla no duplica' })
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'uploadKey debe tener de 8 a 64 caracteres (letras, números, - o _)' })
  uploadKey: string;
}

export class RemoveEvidenceDto {
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;
}
