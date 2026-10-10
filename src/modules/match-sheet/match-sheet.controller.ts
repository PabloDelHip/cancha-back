import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsObjectIdPipe } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiConflictResponse, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { UploadedImage } from '../media/image-upload.js';
import { MatchSheetService } from './match-sheet.service.js';
import { EvidenceService } from './evidence.service.js';
import { evidenceUploadOptions } from './evidence-rules.js';
import { RemoveEvidenceDto, ReopenSheetDto, SaveObservationsDto, SaveSheetTeamDto, UploadEvidenceDto } from './dto/match-sheet.dto.js';

/** Ficha técnica digital del partido y sus fotografías de evidencia (Módulo 2D). */
@ApiTags('match-sheet')
@ApiBearerAuth()
@Controller('matches/:id')
export class MatchSheetController {
  constructor(
    private readonly sheets: MatchSheetService,
    private readonly evidence: EvidenceService,
  ) {}

  @Get('sheet')
  @ApiOperation({ summary: 'Ficha técnica completa (VIEW). Documento versionado (`schemaVersion`), base de un PDF futuro' })
  view(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sheets.view(id, user);
  }

  @Put('sheet/teams/:teamId')
  @ApiOperation({ summary: 'Alineación y sustituciones de un equipo (RESULTS). Reemplaza las anteriores' })
  @ApiConflictResponse({ description: 'SHEET_CLOSED, LINEUP_MISMATCH, suspendidos con reglamento BLOCK' })
  saveTeam(@Param('id', IsObjectIdPipe) id: string, @Param('teamId', IsObjectIdPipe) teamId: string, @Body() dto: SaveSheetTeamDto, @CurrentUser() user: AuthUser) {
    return this.sheets.saveTeam(id, teamId, dto, user);
  }

  @Put('sheet/observations')
  @ApiOperation({ summary: 'Observaciones del partido (RESULTS)' })
  observations(@Param('id', IsObjectIdPipe) id: string, @Body() dto: SaveObservationsDto, @CurrentUser() user: AuthUser) {
    return this.sheets.saveObservations(id, dto, user);
  }

  @Post('sheet/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cerrar la ficha (SHEET_CLOSE): congela la información deportiva del partido' })
  @ApiConflictResponse({ description: 'No finalizado, ya cerrada o SHEET_INCONSISTENT' })
  close(@Param('id', IsObjectIdPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sheets.close(id, user);
  }

  @Post('sheet/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reabrir la ficha con motivo (SHEET_REOPEN)' })
  reopen(@Param('id', IsObjectIdPipe) id: string, @Body() dto: ReopenSheetDto, @CurrentUser() user: AuthUser) {
    return this.sheets.reopen(id, dto, user);
  }

  @Post('evidence')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Subir una fotografía de evidencia (EVIDENCE_UPLOAD). Privada; idempotente por uploadKey' })
  @UseInterceptors(FileInterceptor('file', evidenceUploadOptions))
  upload(@Param('id', IsObjectIdPipe) id: string, @Body() dto: UploadEvidenceDto, @UploadedFile() file: UploadedImage | undefined, @CurrentUser() user: AuthUser) {
    return this.evidence.upload(id, dto, file, user);
  }

  @Get('evidence/:evidenceId/url')
  @ApiOperation({ summary: 'URL temporal (5 min) para ver una fotografía (LOGS_VIEW). 410 si fue retirada' })
  url(@Param('id', IsObjectIdPipe) id: string, @Param('evidenceId', IsObjectIdPipe) evidenceId: string, @CurrentUser() user: AuthUser) {
    return this.evidence.url(id, evidenceId, user);
  }

  @Post('evidence/:evidenceId/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Retirar una fotografía con motivo (EVIDENCE_REMOVE). El registro se conserva' })
  remove(@Param('id', IsObjectIdPipe) id: string, @Param('evidenceId', IsObjectIdPipe) evidenceId: string, @Body() dto: RemoveEvidenceDto, @CurrentUser() user: AuthUser) {
    return this.evidence.remove(id, evidenceId, dto, user);
  }
}
