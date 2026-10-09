import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { RefereesModule } from '../referees/referees.module.js';
import { VenuesController } from './venues.controller.js';
import { VenuesService } from './venues.service.js';

/** Sedes y canchas (Módulo 2, etapa 2A). */
@Module({
  imports: [RefereesModule, MongooseModule.forFeature([Models.venue, Models.match, Models.tournament, Models.team])],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
