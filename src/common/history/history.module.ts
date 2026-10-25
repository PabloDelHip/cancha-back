import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../models.js';
import { TournamentIdentityService } from './tournament-identity.service.js';

/** 10C — nombres históricos de los torneos finalizados, disponibles en todas las consultas. */
@Global()
@Module({
  imports: [MongooseModule.forFeature([Models.tournament, Models.tournamentTeam, Models.team, Models.player, Models.membership, Models.match, Models.playerMatchStats, Models.league])],
  providers: [TournamentIdentityService],
  exports: [TournamentIdentityService],
})
export class HistoryModule {}
