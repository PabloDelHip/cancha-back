import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { AgendaController } from './agenda.controller.js';
import { AgendaService } from './agenda.service.js';

/** Agenda global de partidos (Módulo 2, etapa 2C-3). */
@Module({
  imports: [MongooseModule.forFeature([Models.match, Models.tournament, Models.team, Models.round, Models.venue, Models.referee])],
  controllers: [AgendaController],
  providers: [AgendaService],
})
export class AgendaModule {}
