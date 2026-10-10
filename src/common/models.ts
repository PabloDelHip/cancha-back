import { ModelDefinition } from '@nestjs/mongoose';
import {
  Tournament,
  TournamentSchema,
} from '../modules/tournaments/schemas/tournament.schema.js';
import {
  TournamentTeam,
  TournamentTeamSchema,
} from '../modules/tournaments/schemas/tournament-team.schema.js';
import { Team, TeamSchema } from '../modules/teams/schemas/team.schema.js';
import {
  Player,
  PlayerSchema,
} from '../modules/players/schemas/player.schema.js';
import {
  TeamMembership,
  TeamMembershipSchema,
} from '../modules/players/schemas/team-membership.schema.js';
import { Match, MatchSchema } from '../modules/matches/schemas/match.schema.js';
import {
  PlayerMatchStats,
  PlayerMatchStatsSchema,
} from '../modules/matches/schemas/player-match-stats.schema.js';
import { Round, RoundSchema } from '../modules/rounds/schemas/round.schema.js';
import { League, LeagueSchema } from '../modules/leagues/schemas/league.schema.js';
import { User, UserSchema } from '../modules/users/schemas/user.schema.js';
import { TeamAdmin, TeamAdminSchema } from '../modules/teams/schemas/team-admin.schema.js';
import { TeamRoster, TeamRosterSchema } from '../modules/teams/schemas/team-roster.schema.js';
import { RegistrationLink, RegistrationLinkSchema } from '../modules/registration/schemas/registration-link.schema.js';
import { RegistrationRequest, RegistrationRequestSchema } from '../modules/registration/schemas/registration-request.schema.js';
import { RegistrationDraft, RegistrationDraftSchema } from '../modules/registration/schemas/registration-draft.schema.js';
import { TournamentInvitation, TournamentInvitationSchema } from '../modules/tournaments/schemas/tournament-invitation.schema.js';
import { TournamentMember, TournamentMemberSchema } from '../modules/tournaments/schemas/tournament-member.schema.js';
import { MatchLog, MatchLogSchema } from '../modules/match-log/schemas/match-log.schema.js';
import { MatchIncident, MatchIncidentSchema } from '../modules/match-incidents/schemas/match-incident.schema.js';
import { MatchSheet, MatchSheetSchema } from '../modules/match-sheet/schemas/match-sheet.schema.js';
import { MatchEvidence, MatchEvidenceSchema } from '../modules/match-sheet/schemas/match-evidence.schema.js';
import { Referee, RefereeSchema } from '../modules/referees/schemas/referee.schema.js';
import { Venue, VenueSchema } from '../modules/venues/schemas/venue.schema.js';
import { Sanction, SanctionSchema } from '../modules/discipline/schemas/sanction.schema.js';
import { DisciplineLog, DisciplineLogSchema } from '../modules/discipline/schemas/discipline-log.schema.js';
import {
  AuthSession,
  AuthSessionSchema,
} from '../modules/auth/schemas/auth-session.schema.js';

/**
 * Definiciones de modelos. Cada módulo registra (forFeature) solo los que necesita leer;
 * así los módulos consultan referencias sin depender de los services de otros módulos
 * (y sin dependencias circulares).
 */
export const Models = {
  league: { name: League.name, schema: LeagueSchema },
  tournament: { name: Tournament.name, schema: TournamentSchema },
  tournamentTeam: { name: TournamentTeam.name, schema: TournamentTeamSchema },
  team: { name: Team.name, schema: TeamSchema },
  player: { name: Player.name, schema: PlayerSchema },
  membership: { name: TeamMembership.name, schema: TeamMembershipSchema },
  round: { name: Round.name, schema: RoundSchema },
  match: { name: Match.name, schema: MatchSchema },
  playerMatchStats: {
    name: PlayerMatchStats.name,
    schema: PlayerMatchStatsSchema,
  },
  user: { name: User.name, schema: UserSchema },
  teamAdmin: { name: TeamAdmin.name, schema: TeamAdminSchema },
  teamRoster: { name: TeamRoster.name, schema: TeamRosterSchema },
  registrationLink: { name: RegistrationLink.name, schema: RegistrationLinkSchema },
  registrationRequest: { name: RegistrationRequest.name, schema: RegistrationRequestSchema },
  registrationDraft: { name: RegistrationDraft.name, schema: RegistrationDraftSchema },
  authSession: { name: AuthSession.name, schema: AuthSessionSchema },
  sanction: { name: Sanction.name, schema: SanctionSchema },
  disciplineLog: { name: DisciplineLog.name, schema: DisciplineLogSchema },
  venue: { name: Venue.name, schema: VenueSchema },
  referee: { name: Referee.name, schema: RefereeSchema },
  matchLog: { name: MatchLog.name, schema: MatchLogSchema },
  matchIncident: { name: MatchIncident.name, schema: MatchIncidentSchema },
  matchSheet: { name: MatchSheet.name, schema: MatchSheetSchema },
  matchEvidence: { name: MatchEvidence.name, schema: MatchEvidenceSchema },
  tournamentMember: { name: TournamentMember.name, schema: TournamentMemberSchema },
  tournamentInvitation: { name: TournamentInvitation.name, schema: TournamentInvitationSchema },
} satisfies Record<string, ModelDefinition>;
