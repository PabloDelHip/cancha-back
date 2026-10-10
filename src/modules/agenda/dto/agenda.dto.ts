import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsBoolean, IsEnum, IsMongoId, IsOptional } from 'class-validator';
import { MatchStatus } from '../../../common/enums/index.js';
import { PaginationQueryDto } from '../../../common/dto/pagination.dto.js';
import { IsISODateOnly } from '../../../common/validators.js';

const bool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';
/** `status=SCHEDULED,LIVE` o `status=SCHEDULED&status=LIVE`. */
const list = ({ value }: { value: unknown }) => (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);

/** Agenda global (2C-3): todos los filtros se combinan (AND). */
export class AgendaQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: '2027-03-01', description: 'Desde (inclusive), fecha local YYYY-MM-DD' })
  @IsOptional()
  @IsISODateOnly()
  from?: string;

  @ApiPropertyOptional({ example: '2027-03-31', description: 'Hasta (inclusive)' })
  @IsOptional()
  @IsISODateOnly()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  tournamentId?: string;

  @ApiPropertyOptional({ enum: MatchStatus, isArray: true, description: 'Uno o varios (separados por coma)' })
  @IsOptional()
  @Transform(list)
  @ArrayMaxSize(6)
  @IsEnum(MatchStatus, { each: true })
  status?: MatchStatus[];

  @ApiPropertyOptional({ description: 'Sede (catálogo del propietario de algún torneo donde gestionas asignaciones)' })
  @IsOptional()
  @IsMongoId()
  venueId?: string;

  @ApiPropertyOptional({ description: 'Cancha' })
  @IsOptional()
  @IsMongoId()
  fieldId?: string;

  @ApiPropertyOptional({ description: 'Árbitro en funciones en el partido' })
  @IsOptional()
  @IsMongoId()
  refereeId?: string;

  @ApiPropertyOptional({ default: false, description: 'Incluir torneos finalizados (por defecto se excluyen)' })
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  includeFinished?: boolean;
}

export class AgendaOptionsQueryDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  includeFinished?: boolean;
}
