import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { PlayersController } from './players.controller.js';
import { PlayersService } from './players.service.js';
import { MembershipsService } from './memberships.service.js';
import { PlayerDuplicatesService } from './player-duplicates.service.js';
import { PlayerBlocksService } from './player-blocks.service.js';
import { RosterHistoryService } from './roster-history.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      Models.player,
      Models.membership,
      Models.team,
      Models.playerMatchStats,
      Models.tournament,
      Models.teamRoster,
      Models.match,
      Models.matchSheet,
      Models.sanction,
      Models.playerBlock,
      Models.removedEnrollment,
      Models.tournamentTeam,
      Models.matchLog,
      Models.user,
      Models.financeEntry,
      Models.registrationRequest,
      Models.registrationDraft,
    ]),
  ],
  controllers: [PlayersController],
  providers: [PlayersService, MembershipsService, PlayerDuplicatesService, PlayerBlocksService, RosterHistoryService],
  exports: [MembershipsService, PlayerDuplicatesService],
})
export class PlayersModule {}
