import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { CompetitionSystem, DataCoverage, KnockoutTiebreak, MatchLogCause, MatchStatus, TournamentStatus } from '../../common/enums/index.js';
import { DEFAULT_REGISTRATION, DEFAULT_SETTINGS, Tournament, TournamentSettings, withCoverage } from './schemas/tournament.schema.js';
import { TournamentTeam } from './schemas/tournament-team.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { Sanction } from '../discipline/schemas/sanction.schema.js';
import { DisciplineLog } from '../discipline/schemas/discipline-log.schema.js';
import { RefereesService } from '../referees/referees.service.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import { MatchLog } from '../match-log/schemas/match-log.schema.js';
import { TournamentMember } from './schemas/tournament-member.schema.js';
import { TournamentInvitation } from './schemas/tournament-invitation.schema.js';
import { assertAssignmentsReleased, VenuesService } from '../venues/venues.service.js';
import { DEFAULT_MATCH_MINUTES } from '../venues/occupancy.js';
import { Round } from '../rounds/schemas/round.schema.js';
import {
  CreateTournamentDto,
  EnrollmentQueryDto,
  FinishTournamentDto,
  TournamentQueryDto,
  TournamentSettingsDto,
  UpdateTournamentDto,
} from './dto/tournament.dto.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import {
  serialize,
  toObjectId,
  type WithId,
} from '../../common/utils/serialize.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission, permissionsOf } from '../../common/authorization/permissions.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { LeagueAccessService } from '../../common/authorization/league-access.service.js';
import { OrganizerAccessService } from '../../common/authorization/organizer-access.service.js';
import { validateFormatSettings } from '../competition/formats.js';
import { CompetitionService } from '../competition/competition.service.js';
import type { AuthUser } from '../auth/auth.types.js';

import { definedInformation, mergeInformation, validateInformation } from './tournament-information.js';
import { assertImage, type UploadedImage } from '../media/image-upload.js';
import { CloudinaryService, IMAGE_PRESETS } from '../media/cloudinary.service.js';

@Injectable()
export class TournamentsService {
  constructor(
    @InjectModel(Tournament.name)
    private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name)
    private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(TeamMembership.name)
    private readonly memberships: Model<TeamMembership>,
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    @InjectModel(Sanction.name) private readonly sanctions: Model<Sanction>,
    @InjectModel(DisciplineLog.name) private readonly disciplineLog: Model<DisciplineLog>,
    @InjectModel(MatchLog.name) private readonly matchLogs: Model<MatchLog>,
    @InjectModel(TournamentMember.name) private readonly members: Model<TournamentMember>,
    @InjectModel(TournamentInvitation.name) private readonly invitations: Model<TournamentInvitation>,
    private readonly ownership: OwnershipService,
    private readonly competition: CompetitionService,
    private readonly organizers: OrganizerAccessService,
    private readonly leagues: LeagueAccessService,
    private readonly cloudinary: CloudinaryService,
    private readonly venues: VenuesService,
    private readonly referees: RefereesService,
    private readonly log: MatchLogService,
    private readonly access: TournamentAccessService,
  ) {}

  async findOwned(id: string, user: AuthUser) {
    const { tournament, role } = await this.access.require(id, user.id, Permission.VIEW);
    return { ...serialize(withCoverage(tournament), { includePrivateTournamentContact: true }), myRole: role, permissions: permissionsOf(role) };
  }

  async setLogo(id: string, file: UploadedImage | undefined, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SETTINGS);
    assertImage(file);
    const stored = await this.cloudinary.upload(file, IMAGE_PRESETS.tournamentLogo);
    let previous: string | null | undefined;
    try {
      previous = await this.ownership.inTournament(id, { user, permission: Permission.SETTINGS }, async (session) => {
        const before = await this.tournaments.findByIdAndUpdate(id, { $set: { logoUrl: stored.url, logoPublicId: stored.publicId } }, { session, returnDocument: 'before' }).select('+logoPublicId').lean();
        if (!before) throw new NotFoundException('El torneo ya no existe');
        return before.logoPublicId;
      });
    } catch (error) {
      await this.cloudinary.destroy(stored.publicId);
      throw error;
    }
    await this.cloudinary.destroy(previous);
    return this.findOwned(id, user);
  }

  async removeLogo(id: string, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SETTINGS);
    const previous = await this.ownership.inTournament(id, { user, permission: Permission.SETTINGS }, async (session) => {
      const before = await this.tournaments.findByIdAndUpdate(id, { $set: { logoUrl: null, logoPublicId: null } }, { session, returnDocument: 'before' }).select('+logoPublicId').lean();
      return before?.logoPublicId;
    });
    await this.cloudinary.destroy(previous);
    return this.findOwned(id, user);
  }

  /** Listado público. */
  async findAll(query: TournamentQueryDto) {
    return this.list(query.status ? { status: query.status } : {}, query);
  }

  /**
   * Torneos que administra el usuario (panel /admin): los propios y aquellos donde colabora,
   * cada uno con su rol y permisos (`myRole`, `permissions`). El backend vuelve a validar cada
   * acción: estos campos solo sirven para que la interfaz muestre lo que corresponde.
   */
  async findMine(user: AuthUser, query: TournamentQueryDto) {
    const roles = await this.access.accessible(user.id);
    const filter: Record<string, unknown> = { _id: { $in: [...roles.keys()].map(toObjectId) } };
    if (query.status) filter.status = query.status;
    const page = await this.list(filter, query, true);
    return { ...page, data: page.data.map((t) => ({ ...t, myRole: roles.get(t.id) ?? null, permissions: permissionsOf(roles.get(t.id) ?? null) })) };
  }

  async findOne(id: string) {
    const tournament = await this.tournaments.findById(id).lean();
    if (!tournament) throw new NotFoundException(`Torneo ${id} no encontrado`);
    return serialize(withCoverage(tournament));
  }

  async create(dto: CreateTournamentDto, user: AuthUser) {
    // Crear torneos requiere la capacidad de organizar (activada o ya organizando alguno).
    await this.organizers.requireOrganizer(user);
    assertDateRange(dto.startDate, dto.endDate);
    // Todo torneo vive en una liga del organizador (la indicada o su liga por defecto).
    const leagueId = await this.leagues.forNewTournament(user, dto.leagueId);
    // El propietario sale del JWT; el DTO ni siquiera admite organizerId.
    const information = mergeInformation(undefined, dto.information);
    const registration = { ...DEFAULT_REGISTRATION, ...definedInformation(dto.registration) };
    validateInformation(information, registration.deadline);
    const created = await this.tournaments.create({
      ...dto,
      leagueId,
      information,
      registration,
      settings: mergeSettings(DEFAULT_SETTINGS, dto.settings),
      organizerId: toObjectId(user.id),
    });
    return serialize(created.toObject(), { includePrivateTournamentContact: true });
  }

  /** Datos y configuración. El estado no: tiene acciones propias (start/finish). */
  async update(id: string, dto: UpdateTournamentDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SETTINGS);
    // Cambiar de liga: solo el propietario y solo a otra liga suya (un colaborador no puede
    // llevarse el torneo a su propia liga).
    if (dto.leagueId) {
      await this.ownership.tournament(id, user, Permission.DELETE);
      await this.leagues.owned(dto.leagueId, user);
    }
    // Con el cerrojo: no se cuela un cambio en un torneo que se está finalizando.
    return this.ownership.inTournament(id, { user, permission: Permission.SETTINGS }, async (session) => {
      const current = (await this.tournaments.findById(id).session(session).lean())!;
      assertDateRange(
        dto.startDate ?? current.startDate,
        dto.endDate === undefined ? current.endDate : dto.endDate,
      );
      const { resetSchedule, releaseAssignments: _releaseAssignments, trackedTeamIds: _trackedTeamIds, ...fields } = dto;
      const update: Record<string, unknown> = { ...fields };
      const information = mergeInformation(current.information, dto.information);
      const registration = { ...DEFAULT_REGISTRATION, ...current.registration, ...definedInformation(dto.registration) };
      validateInformation(information, registration.deadline);
      if (dto.registration?.maxTeams != null) {
        const enrolled = await this.enrollments.countDocuments({ tournamentId: toObjectId(id) }).session(session);
        if (registration.maxTeams! < enrolled) throw new BadRequestException(`Ya hay ${enrolled} equipos inscritos: el cupo no puede ser menor`);
      }
      if (dto.information !== undefined) update.information = information;
      // Otra duración cambia lo que ocupan sus partidos con cancha: se rechaza si alguno chocaría.
      const duration = information.schedule.durationMinutes ?? DEFAULT_MATCH_MINUTES;
      if (duration !== (current.information?.schedule?.durationMinutes ?? DEFAULT_MATCH_MINUTES)) {
        await this.venues.revalidateTournament(session, toObjectId(id), duration);
        await this.referees.revalidate(session, { tournamentId: toObjectId(id) }, { tournamentId: toObjectId(id), minutes: duration });
      }
      if (dto.registration !== undefined) update.registration = registration;
      // Explícito: la liga se guarda como ObjectId (las consultas por liga lo comparan así).
      if (dto.leagueId) update.leagueId = toObjectId(dto.leagueId);
      update.dataCoverage = DataCoverage.FULL;
      update.trackedTeamIds = [];
      if (dto.settings) {
        const next = mergeSettings(current.settings ?? DEFAULT_SETTINGS, dto.settings);
        // La estructura (formato, vueltas, grupos, playoffs) no cambia con partidos ya generados:
        // dejaría fases y partidos incoherentes. La puntuación sí (la tabla se recalcula).
        const before = { ...DEFAULT_SETTINGS, ...current.settings };
        const structural = STRUCTURAL_SETTINGS.some((k) => next[k] !== before[k]);
        const tournamentId = toObjectId(id);
        if (structural && (await this.matches.exists({ tournamentId }).session(session))) {
          const played = await this.matches
            .exists({
              tournamentId,
              $or: [{ status: { $in: [MatchStatus.LIVE, MatchStatus.FINISHED] } }, { homeScore: { $ne: null } }, { awayScore: { $ne: null } }],
            })
            .session(session);
          if (played) {
            throw new ConflictException('El torneo ya tiene partidos jugados o en juego: su formato y estructura ya no pueden cambiar');
          }
          if (!resetSchedule) {
            throw new ConflictException(
              'El torneo tiene un calendario generado. Para cambiar su formato o estructura envía resetSchedule: true (se borrarán sus partidos y jornadas, ninguno jugado).',
            );
          }
          await assertAssignmentsReleased(this.matches, tournamentId, dto.releaseAssignments, session);
          await this.log.deleting(session, { userId: user.id }, { tournamentId }, MatchLogCause.FORMAT_CHANGED, { bulk: true });
          await this.matches.deleteMany({ tournamentId }, { session });
          await this.rounds.deleteMany({ tournamentId }, { session });
        }
        // La regla de desempate decide llaves ya jugadas: cambiarla podría cambiar quién pasó.
        const rulesChanged = next.knockoutTiebreak !== before.knockoutTiebreak || next.finalTiebreak !== before.finalTiebreak;
        if (
          rulesChanged &&
          (await this.matches
            .exists({ tournamentId, 'stage.tie': { $ne: null }, $or: [{ status: { $in: [MatchStatus.LIVE, MatchStatus.FINISHED] } }, { homeScore: { $ne: null } }] })
            .session(session))
        ) {
          throw new ConflictException('Ya hay llaves de eliminatoria jugadas: la regla de desempate ya no puede cambiar');
        }
        if (structural) update.phases = [];
        update.settings = next;
      }
      const updated = await this.tournaments
        .findByIdAndUpdate(id, update, { new: true, runValidators: true, session })
        .lean();
      return serialize(withCoverage(updated!), { includePrivateTournamentContact: true });
    });
  }

  // ─── Ciclo de vida: DRAFT → ACTIVE → FINISHED ───────────────────────────────

  async start(id: string, user: AuthUser) {
    const current = await this.ownership.ownedTournament(id, user, Permission.LIFECYCLE);
    if (current.status !== TournamentStatus.DRAFT) {
      throw new ConflictException(
        current.status === TournamentStatus.ACTIVE
          ? 'El torneo ya está en curso'
          : 'El torneo está finalizado y no puede reabrirse',
      );
    }
    // En transacción con el cerrojo: el permiso se revalida (una revocación concurrente gana).
    return this.ownership.inTournament(id, { user, permission: Permission.LIFECYCLE }, (session) =>
      this.transition(id, TournamentStatus.DRAFT, TournamentStatus.ACTIVE, session),
    );
  }

  /**
   * Cierra la competición. No borra ni modifica nada: desde aquí el torneo es historial
   * inmutable (ver OwnershipService). Con partidos sin jugar exige confirmación explícita.
   *
   * Recuento y cambio de estado van en una transacción con el cerrojo del torneo: ninguna
   * escritura deportiva puede entrar entre la comprobación de pendientes y el FINISHED
   * (espera y, al reintentarse, recibe 409); y las que ya estaban en curso terminan antes
   * de que se cuente.
   */
  async finish(id: string, dto: FinishTournamentDto, user: AuthUser) {
    const current = await this.ownership.ownedTournament(id, user, Permission.LIFECYCLE);
    assertFinishable(current.status);
    return this.ownership.inTournament(id, { user, permission: Permission.LIFECYCLE }, async (session, status) => {
      assertFinishable(status);
      // Formatos con eliminatoria: el campeón es el ganador de la final; sin él no hay cierre.
      const blockers = await this.competition.finishBlockers(toObjectId(id), session);
      if (blockers.length) {
        throw new ConflictException({ statusCode: 409, error: 'Conflict', message: blockers.join('. '), blockers });
      }
      const summary = await this.summary(id, session);
      if (summary.pending > 0 && !dto.allowPendingMatches) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: `Quedan ${summary.pending} partidos sin jugar. Para finalizar igualmente envía allowPendingMatches: true`,
          summary,
        });
      }
      const tournament = await this.tournaments
        .findByIdAndUpdate(id, { status: TournamentStatus.FINISHED }, { new: true, session })
        .lean();
      return { tournament: serialize(withCoverage(tournament!)), summary };
    });
  }

  /** Recuento de partidos del torneo por estado (lo que se muestra antes de cerrarlo). */
  async summary(id: string, session: ClientSession | null = null) {
    const rows = await this.matches
      .aggregate<{ _id: MatchStatus; n: number }>([
        { $match: { tournamentId: toObjectId(id) } },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ])
      .session(session);
    const by = (s: MatchStatus) => rows.find((r) => r._id === s)?.n ?? 0;
    const counts = {
      scheduled: by(MatchStatus.SCHEDULED),
      live: by(MatchStatus.LIVE),
      postponed: by(MatchStatus.POSTPONED),
      finished: by(MatchStatus.FINISHED),
      cancelled: by(MatchStatus.CANCELLED),
    };
    return {
      total: rows.reduce((sum, r) => sum + r.n, 0),
      ...counts,
      pending: counts.scheduled + counts.live + counts.postponed,
    };
  }

  /** Cambio de estado condicionado al estado actual (evita carreras entre dos peticiones). */
  private async transition(id: string, from: TournamentStatus, to: TournamentStatus, session: ClientSession | null = null) {
    const updated = await this.tournaments
      .findOneAndUpdate({ _id: id, status: from }, { status: to }, { new: true, session })
      .lean();
    if (!updated) throw new ConflictException('El estado del torneo cambió; recarga e inténtalo de nuevo');
    return serialize(withCoverage(updated));
  }

  /** Solo se elimina un torneo sin partidos: los partidos son historia de los jugadores. */
  async remove(id: string, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.DELETE);
    const imageId = await this.ownership.inTournament(id, { user, permission: Permission.DELETE }, async (session) => {
      const tournamentId = toObjectId(id);
      const before = await this.tournaments.findById(id).select('+logoPublicId').session(session).lean();
      if (await this.matches.exists({ tournamentId }).session(session)) {
        throw new ConflictException(
          'El torneo tiene partidos registrados y no puede eliminarse. Cámbialo a FINISHED o elimina antes sus partidos sin resultado.',
        );
      }
      // Sin partidos no hay historia: se retiran inscripciones, participaciones, jornadas y lo
      // disciplinario (sin partidos solo puede haber cambios de reglamento en el historial).
      await this.enrollments.deleteMany({ tournamentId }, { session });
      await this.memberships.deleteMany({ tournamentId }, { session });
      await this.rounds.deleteMany({ tournamentId }, { session });
      await this.sanctions.deleteMany({ tournamentId }, { session });
      await this.disciplineLog.deleteMany({ tournamentId }, { session });
      // Historial de partidos (solo puede tener partidos ya eliminados: un torneo con partidos no se borra).
      await this.matchLogs.deleteMany({ tournamentId }, { session });
      await this.members.deleteMany({ tournamentId }, { session });
      await this.invitations.deleteMany({ tournamentId }, { session });
      await this.tournaments.deleteOne({ _id: id }, { session });
      return before?.logoPublicId;
    });
    await this.cloudinary.destroy(imageId);
  }

  // ─── Inscripciones (TournamentTeam) ─────────────────────────────────────────

  /** Equipos inscritos en un torneo, con los datos del equipo. */
  async listTeams(tournamentId: string) {
    await this.findOne(tournamentId);
    const rows = await this.enrollments
      .find({ tournamentId: toObjectId(tournamentId) })
      .populate<{ teamId: WithId<Team> }>('teamId')
      .lean();
    return rows
      .map(({ teamId: team, ...rest }) => ({
        ...serialize(rest),
        teamId: serialize(team).id,
        team: serialize(team),
      }))
      .sort((a, b) => a.team.name.localeCompare(b.team.name));
  }

  async listEnrollments(query: EnrollmentQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.tournamentId)
      filter.tournamentId = toObjectId(query.tournamentId);
    if (query.teamId) filter.teamId = toObjectId(query.teamId);
    const [items, total] = await Promise.all([
      this.enrollments
        .find(filter)
        .sort({ _id: 1 })
        .skip(skipFor(query))
        .limit(query.limit)
        .lean(),
      this.enrollments.countDocuments(filter),
    ]);
    return paginated(serialize(items), total, query);
  }

  /**
   * Inscribe un equipo (global) en un torneo del usuario. Cualquier equipo existente puede
   * participar en tu torneo; la inscripción solo afecta a tu torneo.
   */
  async addTeam(tournamentId: string, teamId: string, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    if (!(await this.teams.exists({ _id: teamId })))
      throw new NotFoundException(`Equipo ${teamId} no encontrado`);
    const filter = {
      tournamentId: toObjectId(tournamentId),
      teamId: toObjectId(teamId),
    };
    return this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      if (await this.enrollments.exists(filter).session(session))
        throw new ConflictException('El equipo ya está inscrito en este torneo');
      const [created] = await this.enrollments.create([filter], { session });
      return serialize(created.toObject());
    });
  }

  async removeTeam(tournamentId: string, teamId: string, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.TEAMS);
    const filter = {
      tournamentId: toObjectId(tournamentId),
      teamId: toObjectId(teamId),
    };
    // Con el cerrojo: no se retira un equipo mientras se le programa un partido.
    await this.ownership.inTournament(tournamentId, { user, permission: Permission.TEAMS }, async (session) => {
      if (!(await this.enrollments.exists(filter).session(session)))
        throw new NotFoundException('El equipo no está inscrito en este torneo');
      const hasMatches = await this.matches
        .exists({
          tournamentId: filter.tournamentId,
          $or: [{ homeTeamId: filter.teamId }, { awayTeamId: filter.teamId }],
        })
        .session(session);
      if (hasMatches)
        throw new ConflictException(
          'El equipo ya tiene partidos en este torneo y no puede darse de baja',
        );
      // Sin partidos no hay historia: se retiran también sus participaciones en ESTE torneo y, si
      // estaba en seguimiento (6G), deja de estarlo en la misma transacción (sin referencias huérfanas).
      await this.memberships.deleteMany(filter, { session });
      await this.enrollments.deleteOne(filter, { session });
      await this.tournaments.updateOne({ _id: filter.tournamentId }, { $pull: { trackedTeamIds: filter.teamId } }, { session });
    });
  }

  private async list(
    filter: Record<string, unknown>,
    query: TournamentQueryDto,
    includePrivateTournamentContact = false,
  ) {
    const [items, total] = await Promise.all([
      this.tournaments
        .find(filter)
        .sort({ startDate: -1, _id: 1 })
        .skip(skipFor(query))
        .limit(query.limit)
        .lean(),
      this.tournaments.countDocuments(filter),
    ]);
    return paginated(serialize(items.map(withCoverage), { includePrivateTournamentContact }), total, query);
  }
}

/** Fusiona la configuración vigente con el cambio y valida su coherencia (puntos y formato). */
function mergeSettings(current: TournamentSettings, patch?: TournamentSettingsDto): TournamentSettings {
  const pick = <K extends keyof TournamentSettings>(k: K): TournamentSettings[K] =>
    (patch?.[k as keyof TournamentSettingsDto] as TournamentSettings[K] | undefined) ?? current[k] ?? DEFAULT_SETTINGS[k];
  const nullable = <K extends 'pointsForShootoutWin' | 'finalTiebreak'>(k: K): TournamentSettings[K] =>
    patch && k in patch ? ((patch[k] ?? null) as TournamentSettings[K]) : (current[k] ?? DEFAULT_SETTINGS[k]);
  const next: TournamentSettings = {
    system: pick('system'),
    pointsForWin: pick('pointsForWin'),
    pointsForDraw: pick('pointsForDraw'),
    pointsForLoss: pick('pointsForLoss'),
    roundRobinLegs: pick('roundRobinLegs'),
    knockoutLegs: pick('knockoutLegs'),
    groupCount: pick('groupCount'),
    qualifiersPerGroup: pick('qualifiersPerGroup'),
    playoffTeams: pick('playoffTeams'),
    // Anulables: un null explícito los desactiva (pick no distinguiría null de "sin cambio").
    pointsForShootoutWin: nullable('pointsForShootoutWin'),
    knockoutTiebreak: pick('knockoutTiebreak'),
    reseed: pick('reseed'),
    finalTiebreak: nullable('finalTiebreak'),
  };
  const formatErrors = validateFormatSettings(next);
  if (formatErrors.length) throw new BadRequestException(formatErrors);
  if (next.pointsForWin <= next.pointsForDraw)
    throw new BadRequestException('La victoria debe valer más puntos que el empate');
  if (next.pointsForDraw < next.pointsForLoss)
    throw new BadRequestException('El empate no puede valer menos puntos que la derrota');
  if (next.system === CompetitionSystem.LEAGUE_PLAYOFFS ? false : [next.knockoutTiebreak, next.finalTiebreak].includes(KnockoutTiebreak.BETTER_POSITION))
    throw new BadRequestException('"Pasa el mejor de la tabla" solo existe en Liga + playoffs (la posición sale de la fase regular)');
  return next;
}

const STRUCTURAL_SETTINGS = ['system', 'roundRobinLegs', 'knockoutLegs', 'groupCount', 'qualifiersPerGroup', 'playoffTeams'] as const;

function assertFinishable(status: TournamentStatus) {
  if (status !== TournamentStatus.ACTIVE) {
    throw new ConflictException(
      status === TournamentStatus.FINISHED
        ? 'El torneo ya está finalizado'
        : 'Solo se puede finalizar un torneo en curso: inícialo primero',
    );
  }
}

function assertDateRange(start: string, end: string | null | undefined) {
  if (end && end < start)
    throw new BadRequestException('endDate no puede ser anterior a startDate');
}
