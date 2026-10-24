import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, Matches, Max, Min } from 'class-validator';
import { ISO_DATE_REGEX } from '../../../common/utils/dates.js';
import { REPORT_FORMATS, type ReportFormat } from '../report-model.js';
import { STATUS_FILTERS, type StatusFilter } from '../report-builders.js';

/**
 * 8A — formato y filtros de un reporte. Cada reporte acepta solo SUS filtros (los demás → 400, ver
 * REPORTS en reports.service.ts): un filtro que no aplica nunca se ignora en silencio.
 */
export class ReportQueryDto {
  @ApiPropertyOptional({ enum: REPORT_FORMATS, default: 'pdf' })
  @IsOptional()
  @IsIn(REPORT_FORMATS)
  format?: ReportFormat;

  @ApiPropertyOptional({ description: 'Tabla de posiciones: fase (0 = primera)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9)
  phase?: number;

  @ApiPropertyOptional({ description: 'Tabla de posiciones: grupo («A», «B»…)' })
  @IsOptional()
  @Matches(/^[A-Z]{1,2}$/, { message: 'El grupo es una o dos letras mayúsculas' })
  group?: string;

  @ApiPropertyOptional({ description: 'Resultados y calendario: jornada' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  round?: number;

  @ApiPropertyOptional({ description: 'Equipo (resultados, jugadores, plantillas, disciplina, finanzas)' })
  @IsOptional()
  @IsMongoId()
  teamId?: string;

  @ApiPropertyOptional({ description: 'Desde (YYYY-MM-DD): partidos o movimientos' })
  @IsOptional()
  @Matches(ISO_DATE_REGEX, { message: 'from debe ser YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ description: 'Hasta (YYYY-MM-DD): partidos o movimientos' })
  @IsOptional()
  @Matches(ISO_DATE_REGEX, { message: 'to debe ser YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ description: `Resultados y calendario: estados separados por coma (${STATUS_FILTERS.join(', ')})` })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((s: string) => s.trim()).filter(Boolean) : value))
  @IsArray()
  @ArrayMaxSize(STATUS_FILTERS.length)
  @IsIn(STATUS_FILTERS, { each: true })
  status?: StatusFilter[];

  @ApiPropertyOptional({ description: 'Plantillas: incluir bajas' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value))
  @IsBoolean()
  includeInactive?: boolean;
}
