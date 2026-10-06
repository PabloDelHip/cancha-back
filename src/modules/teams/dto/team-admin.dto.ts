import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsMongoId, IsOptional, MaxLength } from 'class-validator';
import { Trim } from '../../../common/validators.js';

/** Usuario EXISTENTE a agregar como MANAGER: por id o por email (exactamente uno). */
export class AddManagerDto {
  @ApiPropertyOptional({ description: 'Id del User' })
  @IsOptional()
  @IsMongoId()
  userId?: string;

  @ApiPropertyOptional({ description: 'Email de la cuenta (no se crean cuentas)' })
  @IsOptional()
  @Trim()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}
