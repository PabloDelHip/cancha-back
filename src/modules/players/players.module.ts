import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { PlayersController } from './players.controller.js';
import { PlayersService } from './players.service.js';
import { MembershipsService } from './memberships.service.js';
import { PlayerDuplicatesService } from './player-duplicates.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      Models.player,
      Models.membership,
      Models.team,
      Models.playerMatchStats,
      Models.tournament,
      Models.tournamentTeam,
      Models.teamRoster,
    ]),
  ],
  controllers: [PlayersController],
  providers: [PlayersService, MembershipsService, PlayerDuplicatesService],
  exports: [MembershipsService, PlayerDuplicatesService],
})
export class PlayersModule {}
