import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Trim } from '../../../common/validators.js';

export class RegisterDto {
  @ApiProperty({ example: 'Pablo' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  firstName: string;

  @ApiProperty({ example: 'Hipólito' })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  lastName: string;

  @ApiProperty({ example: 'pablo@example.com' })
  @Trim()
  @IsEmail({}, { message: 'email debe ser un email válido' })
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'una-contraseña-larga', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  // Argon2 acepta más, pero limitar evita abusar del hashing con cuerpos enormes.
  @MaxLength(128)
  password: string;
}

export class LoginDto {
  @ApiProperty({ example: 'demo@cancha.local' })
  @Trim()
  @IsEmail({}, { message: 'email debe ser un email válido' })
  @MaxLength(254)
  email: string;

  @ApiProperty({ example: 'Demo12345' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password: string;
}
