import { MatchLogModule } from '../match-log/match-log.module.js';
import { RefereesModule } from '../referees/referees.module.js';
import { VenuesModule } from '../venues/venues.module.js';
import { CompetitionModule } from '../competition/competition.module.js';
import { MatchIncidentsModule } from '../match-incidents/match-incidents.module.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Models } from '../../common/models.js';
import { TournamentsController } from './tournaments.controller.js';
import { TournamentsService } from './tournaments.service.js';
import { TournamentMembersController } from './tournament-members.controller.js';
import { TournamentMembersService } from './tournament-members.service.js';
import { TournamentInvitationsController } from './tournament-invitations.controller.js';
import { TournamentInvitationsService } from './tournament-invitations.service.js';

import { DisciplineModule } from '../discipline/discipline.module.js';
import { FinanceModule } from '../finance/finance.module.js';
import { TournamentClosureController } from './tournament-closure.controller.js';
import { TournamentClosureService } from './tournament-closure.service.js';

@Module({
  imports: [
    CompetitionModule,
    VenuesModule,
    RefereesModule,
    MatchLogModule,
    MatchIncidentsModule,
    // 10A: la vista previa del cierre reutiliza disciplina y finanzas (sus reglas y permisos).
    DisciplineModule,
    FinanceModule,
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
      Models.playerBlock,
      Models.removedEnrollment,
      Models.financeEntry,
      Models.playerMatchStats,
      Models.player,
    ]),
  ],
  controllers: [TournamentsController, TournamentMembersController, TournamentInvitationsController, TournamentClosureController],
  providers: [TournamentsService, TournamentMembersService, TournamentInvitationsService, TournamentClosureService],
})
export class TournamentsModule {}
