import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsEnum, IsIn, ValidateNested, IsInt, IsMongoId, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { IsISODateOnly, Trim } from '../../../common/validators.js';
import { FinanceCategory, FinanceEntryKind, MAX_AMOUNT_CENTS, PaymentMethod } from '../finance.js';

/** 4A/4B — cargo (también multa), pago/abono, descuento o devolución en la cuenta de un equipo del torneo. */
export class CreateFinanceEntryDto {
  @ApiProperty({ format: 'uuid', description: 'Clave de idempotencia generada por el cliente (una por formulario)' })
  @IsUUID()
  requestId: string;

  @ApiProperty()
  @IsMongoId()
  teamId: string;

  @ApiProperty({ enum: FinanceEntryKind })
  @IsEnum(FinanceEntryKind)
  kind: FinanceEntryKind;

  @ApiProperty({ description: 'Importe en CENTAVOS (entero positivo): $150.50 = 15050', minimum: 1, maximum: MAX_AMOUNT_CENTS })
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_CENTS)
  amount: number;

  @ApiPropertyOptional({ enum: FinanceCategory, description: 'Solo cargos (por defecto OTHER)' })
  @IsOptional()
  @IsEnum(FinanceCategory)
  category?: FinanceCategory;

  @ApiPropertyOptional({ enum: PaymentMethod, description: 'Obligatorio en pagos y devoluciones; no aplica a cargos ni descuentos' })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional({ maxLength: 120, description: 'Folio, número de transferencia…' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiPropertyOptional({ description: 'Fecha efectiva (YYYY-MM-DD). Por defecto hoy; no puede ser futura.' })
  @IsOptional()
  @IsISODateOnly()
  date?: string;

  @ApiProperty({ minLength: 3, maxLength: 200, example: 'Inscripción' })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  concept: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Motivo: obligatorio en multas (category FINE) y descuentos' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ description: 'Solo multas: partido del torneo en el que jugó el equipo' })
  @IsOptional()
  @IsMongoId()
  matchId?: string;

  @ApiPropertyOptional({ description: 'Solo multas: jugador que está o estuvo en la plantilla del equipo en este torneo' })
  @IsOptional()
  @IsMongoId()
  playerId?: string;

  @ApiPropertyOptional({ description: 'Solo pagos: confirma que el excedente sobre el adeudo quede como saldo a favor (F5)' })
  @IsOptional()
  @IsBoolean()
  allowCredit?: boolean;
}

/** 4B — generar los cargos de inscripción que falten (cuota única del torneo, F1). */
export class GenerateEnrollmentChargesDto {
  @ApiPropertyOptional({ description: 'Fecha efectiva de los cargos (YYYY-MM-DD). Por defecto hoy; no puede ser futura.' })
  @IsOptional()
  @IsISODateOnly()
  date?: string;
}

/** 4D (F6) — anular un movimiento: queda en el libro, marcado, y deja de contar en el saldo. */
export class VoidFinanceEntryDto {
  @ApiProperty({ format: 'uuid', description: 'Clave de idempotencia (una por diálogo)' })
  @IsUUID()
  requestId: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Trim()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ description: 'Confirma que el cambio deje (más) saldo a favor del equipo' })
  @IsOptional()
  @IsBoolean()
  allowCredit?: boolean;
}

/** El movimiento que reemplaza al corregido: mismo equipo (no se indica) y su propia validación. */
export class ReplacementEntryDto extends OmitType(CreateFinanceEntryDto, ['requestId', 'teamId', 'allowCredit'] as const) {}

/** 4D (F6) — corregir = anular y registrar el reemplazo, enlazados y en una sola transacción. */
export class CorrectFinanceEntryDto extends VoidFinanceEntryDto {
  @ApiProperty({ type: ReplacementEntryDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ReplacementEntryDto)
  entry: ReplacementEntryDto;
}

/** 4D — filtros del listado y de la exportación de movimientos. */
export class FinanceEntriesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  teamId?: string;

  @ApiPropertyOptional({ enum: [...Object.values(FinanceEntryKind), 'FINE'] })
  @IsOptional()
  @IsIn([...Object.values(FinanceEntryKind), 'FINE'])
  kind?: FinanceEntryKind | 'FINE';

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional({ description: 'Desde (YYYY-MM-DD, incluido)' })
  @IsOptional()
  @IsISODateOnly()
  from?: string;

  @ApiPropertyOptional({ description: 'Hasta (YYYY-MM-DD, incluido)' })
  @IsOptional()
  @IsISODateOnly()
  to?: string;

  @ApiPropertyOptional({ enum: ['active', 'voided', 'all'], default: 'all', description: 'Vigentes, anulados o todos' })
  @IsOptional()
  @IsIn(['active', 'voided', 'all'])
  status?: 'active' | 'voided' | 'all';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** 4D — página del estado de cuenta (por defecto, la última: lo más reciente). */
export class StatementQueryDto {
  @ApiPropertyOptional({ minimum: 1, description: 'Por defecto, la última página' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
