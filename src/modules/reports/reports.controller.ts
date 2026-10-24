import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiOperation, ApiProduces, ApiTags, ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { Readable } from 'node:stream';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ReportQueryDto } from './dto/report.dto.js';
import { ReportsService } from './reports.service.js';

/** Módulo 8A — reportes y exportaciones del torneo (PDF, Excel y CSV bajo demanda; nada se guarda). */
@ApiTags('reports')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'Sin acceso al torneo o sin el permiso del reporte' })
@Controller('tournaments/:tournamentId/reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get()
  @ApiOperation({ summary: 'Catálogo de reportes y si el usuario puede exportar cada uno' })
  catalog(@Param('tournamentId', IsObjectIdPipe) tournamentId: string, @CurrentUser() user: AuthUser) {
    return this.service.catalog(tournamentId, user);
  }

  @Get(':report')
  @ApiOperation({ summary: 'Genera y descarga un reporte', description: 'report: standings, matches, players, rosters, discipline, finance, summary. format: pdf (por defecto), xlsx o csv.' })
  @ApiProduces('application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv')
  @ApiBadRequestResponse({ description: 'Filtro que no aplica al reporte, periodo inválido o volumen excesivo' })
  @ApiTooManyRequestsResponse({ description: 'Demasiadas generaciones simultáneas' })
  async download(
    @Param('tournamentId', IsObjectIdPipe) tournamentId: string,
    @Param('report') report: string,
    @Query() query: ReportQueryDto,
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
  ) {
    const file = await this.service.generate(tournamentId, report, query, user);
    res.setHeader('Content-Type', file.contentType);
    // Nombre ASCII seguro (generado por el servidor) y su versión UTF-8.
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (file.body instanceof Readable) {
      file.body.on('error', () => res.destroy());
      file.body.pipe(res);
    } else {
      res.setHeader('Content-Length', String(file.body.length));
      res.end(file.body);
    }
  }
}
