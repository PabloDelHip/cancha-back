import { MatchLogModule } from '../match-log/match-log.module.js';
import { RefereesModule } from '../referees/referees.module.js';
import { VenuesModule } from '../venues/venues.module.js';
import { CompetitionModule } from '../competition/competition.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { TournamentsController } from './tournaments.controller.js';
import { TournamentsService } from './tournaments.service.js';
import { TournamentMembersController } from './tournament-members.controller.js';
import { TournamentMembersService } from './tournament-members.service.js';
import { TournamentInvitationsController } from './tournament-invitations.controller.js';
import { TournamentInvitationsService } from './tournament-invitations.service.js';

@Module({
  imports: [
    CompetitionModule,
    VenuesModule,
    RefereesModule,
    MatchLogModule,
    MongooseModule.forFeature([
      Models.tournament,
      Models.tournamentTeam,
      Models.team,
      Models.match,
      Models.membership,
      Models.round,
      Models.sanction,
      Models.disciplineLog,
      Models.matchLog,
      Models.matchIncident,
      Models.matchSheet,
      Models.matchEvidence,
      Models.tournamentMember,
      Models.tournamentInvitation,
      Models.user,
    ]),
  ],
  controllers: [TournamentsController, TournamentMembersController, TournamentInvitationsController],
  providers: [TournamentsService, TournamentMembersService, TournamentInvitationsService],
})
export class TournamentsModule {}
