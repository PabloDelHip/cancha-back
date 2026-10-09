import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { DisciplineController } from './discipline.controller.js';
import { DisciplineService } from './discipline.service.js';

/** Control disciplinario y sanciones por torneo. */
@Module({
  imports: [
    MongooseModule.forFeature([
      Models.tournament,
      Models.match,
      Models.playerMatchStats,
      Models.player,
      Models.team,
      Models.membership,
      Models.user,
      Models.sanction,
      Models.disciplineLog,
    ]),
  ],
  controllers: [DisciplineController],
  providers: [DisciplineService],
  exports: [DisciplineService],
})
export class DisciplineModule {}
