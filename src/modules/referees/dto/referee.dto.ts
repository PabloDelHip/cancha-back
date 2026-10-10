import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsEnum, IsMongoId, IsOptional, IsString, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { RefereeRole } from '../../../common/enums/index.js';
import { Trim } from '../../../common/validators.js';
import { AvailabilityDto } from '../../venues/dto/venue.dto.js';

export class CreateRefereeDto {
  @ApiProperty({ maxLength: 60 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  firstName: string;

  @ApiProperty({ maxLength: 60 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  lastName: string;

  @ApiPropertyOptional({ nullable: true, description: 'Privado: nunca se publica' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Privado: nunca se publica' })
  @IsOptional()
  @Trim()
  @ValidateIf((_, v) => v !== null)
  @IsEmail()
  @MaxLength(120)
  email?: string | null;

  @ApiPropertyOptional({ type: AvailabilityDto, description: 'Solo genera avisos al asignar' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AvailabilityDto)
  availability?: AvailabilityDto;
}

export class UpdateRefereeDto extends PartialType(CreateRefereeDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class AssignRefereeDto {
  @ApiProperty()
  @IsMongoId()
  refereeId: string;

  @ApiProperty({ enum: RefereeRole })
  @IsEnum(RefereeRole)
  role: RefereeRole;
}

export class RefereeAbsenceDto {
  @ApiPropertyOptional({ nullable: true, description: 'Árbitro que lo sustituye en el mismo rol (opcional)' })
  @IsOptional()
  @IsMongoId()
  substituteId?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 300 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(300)
  note?: string | null;
}

/**
 * Corrección justificada (2C-2). Sobre una AUSENCIA: sin `substituteId` la anula (sí se presentó) y
 * anula a su sustituto; con `substituteId` cambia el sustituto. Sobre un SUSTITUTO: lo anula y, si
 * se indica, registra al correcto. Nada se borra: lo corregido queda VOID con el motivo.
 */
export class RefereeCorrectionDto {
  @ApiProperty({ minLength: 3, maxLength: 300, description: 'Motivo de la corrección (obligatorio, queda en el historial)' })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  reason: string;

  @ApiPropertyOptional({ nullable: true, description: 'Sustituto correcto (mismo rol)' })
  @IsOptional()
  @IsMongoId()
  substituteId?: string | null;
}
