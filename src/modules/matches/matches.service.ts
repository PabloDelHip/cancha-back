import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Match } from './schemas/match.schema.js';
import { Round } from '../rounds/schemas/round.schema.js';
import { PlayerMatchStats } from './schemas/player-match-stats.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { MatchLogCause, MatchStatus, SendOff, TournamentStatus } from '../../common/enums/index.js';
import { DisciplineService } from '../discipline/discipline.service.js';
import { VenuesService } from '../venues/venues.service.js';
import { RefereesService } from '../referees/referees.service.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import {
  CreateMatchDto,
  MatchQueryDto,
  SaveResultDto,
  UpdateMatchDto,
} from './dto/match.dto.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import { sameId, serialize, toObjectId } from '../../common/utils/serialize.js';
import { assertStarted, OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { CompetitionService, toStaged } from '../competition/competition.service.js';
import type { AuthUser } from '../auth/auth.types.js';

@Injectable()
export class MatchesService {
  constructor(
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name)
    private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Tournament.name)
    private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name)
    private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamMembership.name)
    private readonly memberships: Model<TeamMembership>,
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    private readonly ownership: OwnershipService,
    private readonly competition: CompetitionService,
    private readonly discipline: DisciplineService,
    private readonly venues: VenuesService,
    private readonly referees: RefereesService,
    private readonly log: MatchLogService,
    private readonly access: TournamentAccessService,
  ) {}

  async findAll(query: MatchQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.tournamentId)
      filter.tournamentId = toObjectId(query.tournamentId);
    if (query.status) filter.status = query.status;
    if (query.teamId)
      filter.$or = [
        { homeTeamId: toObjectId(query.teamId) },
        { awayTeamId: toObjectId(query.teamId) },
      ];
    const [items, total] = await Promise.all([
      this.matches
        .find(filter)
        .sort({ date: 1, time: 1, _id: 1 })
        .skip(skipFor(query))
        .limit(query.limit)
        .lean(),
      this.matches.countDocuments(filter),
    ]);
    return paginated(serialize(items), total, query);
  }

  /** Todos los partidos de un torneo (acotado por naturaleza: no se pagina). */
  async findByTournament(tournamentId: string) {
    if (!(await this.tournaments.exists({ _id: tournamentId })))
      throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);
    const items = await this.matches
      .find({ tournamentId: toObjectId(tournamentId) })
      .sort({ round: 1, date: 1, time: 1 })
      .lean();
    return serialize(items);
  }

  async findOne(id: string) {
    const match = await this.getOrFail(id);
    return { ...serialize(match), playerStats: await this.listStats(id) };
  }

  async listStats(matchId: string) {
    const rows = await this.stats
      .find({ matchId: toObjectId(matchId) })
      .sort({ teamId: 1, goals: -1 })
      .lean();
    return serialize(rows);
  }

  /**
   * Las escrituras de partidos corren con el cerrojo del torneo (OwnershipService.inTournament):
   * las validaciones que leen otros partidos (equipo repetido en jornada, historia) y la
   * escritura son atómicas frente a otras peticiones del mismo torneo.
   */
  async create(dto: CreateMatchDto, user: AuthUser) {
    // Programar exige SCHEDULE; con cancha, también ASSIGNMENTS (se revalidan dentro del cerrojo).
    await this.ownership.tournament(dto.tournamentId, user, Permission.SCHEDULE);
    if (dto.fieldId) await this.ownership.tournament(dto.tournamentId, user, Permission.ASSIGNMENTS);
    let warnings: string[] = [];
    const saved = await this.ownership.inTournament(dto.tournamentId, { user, permission: Permission.SCHEDULE }, async (session, status) => {
      // En DRAFT se programa, pero no se juega.
      if (dto.status === MatchStatus.LIVE) assertStarted(status);
      await this.assertTeams(dto.tournamentId, dto.homeTeamId, dto.awayTeamId, session);
      // El organizador arma sus jornadas como quiera, en cualquier formato: el partido cuenta en la
      // tabla de su fase (y de su grupo). Los cruces de eliminatoria se arman aparte (por cruce).
      const { stage, createPhase } = await this.placeManual(dto.tournamentId, dto.homeTeamId, dto.awayTeamId, session);
      if (dto.status !== MatchStatus.CANCELLED) {
        await this.assertRoundAvailable(session, dto.tournamentId, dto.round, dto.homeTeamId, dto.awayTeamId);
      }
      await this.ensureRound(dto.tournamentId, dto.round, session);
      if (dto.fieldId) await this.access.require(dto.tournamentId, user.id, Permission.ASSIGNMENTS, session);
      // Cancha: misma transacción, con el cerrojo de la sede (conflictos con cualquier torneo).
      const field = await this.venues.assign(session, {
        matchId: null,
        tournamentId: dto.tournamentId,
        date: dto.date,
        time: dto.time,
        status: dto.status ?? MatchStatus.SCHEDULED,
        fieldId: dto.fieldId ? toObjectId(dto.fieldId) : null,
        changed: true,
      });
      warnings = field.warnings;
      const [created] = await this.matches.create(
        [
          {
            ...dto,
            ...(field.fieldId ? { fieldId: field.fieldId, venueId: field.venueId, venue: field.venue } : { fieldId: null, venueId: null }),
            tournamentId: toObjectId(dto.tournamentId),
            homeTeamId: toObjectId(dto.homeTeamId),
            awayTeamId: toObjectId(dto.awayTeamId),
            homeScore: null,
            awayScore: null,
            stage,
          },
        ],
        { session },
      );
      if (createPhase) await this.tournaments.updateOne({ _id: toObjectId(dto.tournamentId) }, { $push: { phases: createPhase } }, { session });
      await this.log.created(session, { userId: user.id }, [created.toObject()]);
      return serialize(created.toObject());
    });
    return withWarnings(saved, warnings);
  }

  async update(id: string, dto: UpdateMatchDto, user: AuthUser) {
    // Acceso al torneo del partido; el permiso concreto depende de qué cambia (ver editPermissions).
    const before = await this.ownership.match(id, user, Permission.VIEW);
    // Mover el partido a otro torneo exige poder programar también en el destino.
    const moving = !!dto.tournamentId && !sameId(dto.tournamentId, before.tournamentId);
    if (moving) await this.ownership.tournament(dto.tournamentId!, user, Permission.SCHEDULE);

    let warnings: string[] = [];
    const saved = await this.ownership.inTournament(before.tournamentId, null, async (session, sourceStatus) => {
      const current = await this.reload(id, before.tournamentId, session);
      // RBAC dentro del cerrojo: cada tipo de cambio real exige su permiso.
      for (const permission of editPermissions(dto, current)) await this.access.require(current.tournamentId, user.id, permission, session);
      const phases = current.stage ? await this.phasesOf(current.tournamentId, session) : [];
      this.competition.assertStageWrite(phases, current.stage, {
        teams: moving || (!!dto.homeTeamId && !sameId(dto.homeTeamId, current.homeTeamId)) || (!!dto.awayTeamId && !sameId(dto.awayTeamId, current.awayTeamId)),
        cancel: dto.status === MatchStatus.CANCELLED,
        resultOrStatus: dto.status !== undefined && dto.status !== current.status,
      });
      const tournamentId = dto.tournamentId ?? current.tournamentId.toString();
      // Si se mueve, el torneo destino también queda bloqueado (y no puede estar finalizado).
      const tournamentStatus = moving ? await this.ownership.lock(tournamentId, session) : sourceStatus;
      if (moving) await this.access.require(tournamentId, user.id, Permission.SCHEDULE, session);
      const homeTeamId = dto.homeTeamId ?? current.homeTeamId.toString();
      const awayTeamId = dto.awayTeamId ?? current.awayTeamId.toString();

      const changesTeams =
        moving || !sameId(homeTeamId, current.homeTeamId) || !sameId(awayTeamId, current.awayTeamId);
      if (changesTeams) {
        // El marcador y las estadísticas pertenecen a esos equipos en ese torneo.
        if (current.homeScore !== null || current.awayScore !== null || (await this.hasStats(current._id, session))) {
          throw new ConflictException(
            'El partido ya tiene resultado o estadísticas: no se pueden cambiar el torneo ni los equipos',
          );
        }
        await this.assertTeams(tournamentId, homeTeamId, awayTeamId, session);
      }
      // Otro torneo u otros equipos: su lugar en la estructura (fase, grupo) se recalcula.
      const placement = changesTeams ? await this.placeManual(tournamentId, homeTeamId, awayTeamId, session) : null;
      // LIVE/FINISHED solo en un torneo iniciado (también al mover un partido en juego).
      const status = dto.status ?? current.status;
      const inPlay = status === MatchStatus.LIVE || status === MatchStatus.FINISHED;
      if (inPlay && (status !== current.status || moving)) assertStarted(tournamentStatus);
      await this.assertStatusChange(current, dto.status, session);
      // Con el torneo en curso, reprogramar, posponer o cancelar exige un motivo (queda en el historial).
      const reason = dto.reason?.trim() || null;
      const reschedules = (dto.date !== undefined && dto.date !== current.date) || (dto.time !== undefined && dto.time !== current.time);
      const suspends = (status === MatchStatus.POSTPONED || status === MatchStatus.CANCELLED) && status !== current.status;
      if (tournamentStatus === TournamentStatus.ACTIVE && (reschedules || suspends) && !reason) {
        throw new BadRequestException(
          reschedules ? 'Indica el motivo de la reprogramación' : `Indica el motivo para ${status === MatchStatus.POSTPONED ? 'posponer' : 'cancelar'} el partido`,
        );
      }

      // Un equipo no juega dos veces en la misma jornada (si el partido sigue vigente).
      const round = dto.round ?? current.round;
      if (status !== MatchStatus.CANCELLED) {
        await this.assertRoundAvailable(session, tournamentId, round, homeTeamId, awayTeamId, current._id.toString());
      }
      if (round !== current.round || moving) {
        await this.ensureRound(tournamentId, round, session);
      }

      // Cancha: se valida si queda asignada (nueva, o con fecha/hora/estado/torneo distintos).
      const nextField = dto.fieldId === undefined ? current.fieldId : dto.fieldId ? toObjectId(dto.fieldId) : null;
      const fieldChanged = !sameId(nextField ?? '', current.fieldId ?? '');
      const field = await this.venues.assign(session, {
        matchId: current._id,
        tournamentId,
        date: dto.date ?? current.date,
        time: dto.time ?? current.time,
        status,
        fieldId: nextField,
        changed: fieldChanged,
      });
      warnings = field.warnings;
      // Sus árbitros en funciones tampoco pueden quedar en dos partidos a la vez.
      await this.referees.revalidateMatch(session, {
        _id: current._id,
        referees: current.referees ?? [],
        tournamentId,
        venueId: field.fieldId ? field.venueId : fieldChanged ? null : current.venueId,
        date: dto.date ?? current.date,
        time: dto.time ?? current.time,
        status,
      });

      const { reason: _reason, ...fields } = dto;
      const update: Record<string, unknown> = { ...fields };
      if (field.fieldId) Object.assign(update, { fieldId: field.fieldId, venueId: field.venueId, venue: field.venue });
      else if (fieldChanged) Object.assign(update, { fieldId: null, venueId: null, venue: dto.venue ?? null });
      // Al posponerse se recuerda la fecha: reprogramarlo sin cambiarla queda señalado en Disciplina.
      if (dto.status === MatchStatus.POSTPONED && current.status !== MatchStatus.POSTPONED) {
        update.postponedFrom = { date: current.date, time: current.time };
      }
      if (dto.tournamentId) update.tournamentId = toObjectId(dto.tournamentId);
      if (dto.homeTeamId) update.homeTeamId = toObjectId(dto.homeTeamId);
      if (dto.awayTeamId) update.awayTeamId = toObjectId(dto.awayTeamId);
      if (placement) {
        update.stage = placement.stage;
        if (placement.createPhase) await this.tournaments.updateOne({ _id: toObjectId(tournamentId) }, { $push: { phases: placement.createPhase } }, { session });
      }
      const updated = await this.matches
        .findByIdAndUpdate(id, update, { new: true, runValidators: true, session })
        .lean();
      await this.log.edited(session, { userId: user.id }, current, updated!, reason);
      // Un cambio de estado en una eliminatoria (p. ej. LIVE → FINISHED) puede decidir la llave.
      if (current.stage?.tie && dto.status && dto.status !== current.status) {
        await this.competition.syncKnockout(current.tournamentId, session, { userId: user.id });
      }
      return serialize(updated!);
    });
    return withWarnings(saved, warnings);
  }

  /** Solo se eliminan partidos sin resultado ni estadísticas (p. ej. mal programados). */
  async remove(id: string, user: AuthUser) {
    const before = await this.ownership.match(id, user, Permission.SCHEDULE);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.SCHEDULE }, async (session) => {
      const match = await this.reload(id, before.tournamentId, session);
      const phases = match.stage ? await this.phasesOf(match.tournamentId, session) : [];
      this.competition.assertStageWrite(phases, match.stage, { remove: true });
      if (
        match.status === MatchStatus.FINISHED ||
        match.homeScore !== null ||
        (await this.hasStats(match._id, session))
      ) {
        throw new ConflictException(
          'El partido tiene resultado o estadísticas y no puede eliminarse; márcalo como CANCELLED',
        );
      }
      await this.discipline.assertMatchUnreferenced(match._id, session);
      await this.log.deleting(session, { userId: user.id }, { _id: match._id }, MatchLogCause.MANUAL);
      await this.matches.deleteOne({ _id: match._id }, { session });
    });
  }

  /**
   * Captura (o corrige) marcador + estadísticas individuales.
   *
   * Reglas: cada jugador aparece una vez; su teamId es el local o el visitante y pertenece
   * (o pertenecía en la fecha del partido) a ese equipo; played=false implica todo en cero;
   * la suma de goles individuales de un equipo no supera su marcador (la diferencia son
   * autogoles o goles sin autor capturado).
   *
   * Solo con el torneo ACTIVE: en DRAFT no se juega y en FINISHED el historial es inmutable (409).
   *
   * Consistencia: marcador y estadísticas se escriben en UNA transacción, con el cerrojo del
   * torneo (no se cruzan con finalizarlo ni con regenerar su calendario); las estadísticas
   * previas del partido se reemplazan completas, nunca se acumulan.
   */
  async saveResult(id: string, dto: SaveResultDto, user: AuthUser) {
    const before = await this.ownership.match(id, user, Permission.RESULTS);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.RESULTS }, async (session, status) => {
      assertStarted(status);
      const match = await this.reload(id, before.tournamentId, session);
      if (match.status === MatchStatus.CANCELLED) {
        throw new ConflictException(
          'El partido está cancelado; cambia su estado antes de capturar un resultado',
        );
      }
      await this.validateStats(match, dto, session);
      const extras = {
        homeScore: dto.homeScore,
        awayScore: dto.awayScore,
        status: dto.status,
        penalties: dto.penalties ?? null,
        extraTime: dto.extraTime ?? false,
      };
      if (match.stage?.tie) {
        const { tournament, matches, input } = await this.competition.context(match.tournamentId, session);
        const phases = tournament.phases ?? [];
        this.competition.assertStageWrite(phases, match.stage, { resultOrStatus: true });
        this.competition.assertKnockoutExtras(input, phases, matches, toStaged(match), extras);
      } else {
        // Liga o grupos: penales solo para el punto extra de un empate (si el torneo lo usa).
        if (match.stage) {
          const { tournament } = await this.competition.context(match.tournamentId, session);
          this.competition.assertStageWrite(tournament.phases ?? [], match.stage, { resultOrStatus: true });
        }
        const t = await this.tournaments.findById(match.tournamentId).select('settings').session(session).lean();
        this.competition.assertShootout(t?.settings?.pointsForShootoutWin, extras);
      }

      // Suspendidos marcados como jugados: se rechaza (BLOCK) o queda registrada la incidencia (WARN).
      await this.discipline.checkLineup(match, dto.playerStats, session, user);

      await this.matches.updateOne(
        { _id: match._id },
        {
          homeScore: dto.homeScore,
          awayScore: dto.awayScore,
          status: dto.status,
          penalties: dto.penalties ?? null,
          extraTime: dto.extraTime ?? false,
        },
        { session, runValidators: true },
      );
      await this.stats.deleteMany({ matchId: match._id }, { session });
      if (dto.playerStats.length) {
        await this.stats.insertMany(
          dto.playerStats.map((s) => ({
            matchId: match._id,
            playerId: toObjectId(s.playerId),
            teamId: toObjectId(s.teamId),
            played: s.played,
            goals: s.goals,
            assists: s.assists,
            ownGoals: s.ownGoals ?? 0,
            yellowCards: s.yellowCards,
            redCards: s.redCards,
            // Sin el campo (clientes anteriores) la fila queda sin clasificar, como las históricas.
            ...(s.sendOff !== undefined ? { sendOff: s.sendOff } : {}),
          })),
          { session },
        );
      }
      const after = await this.matches.findById(match._id).session(session).lean();
      await this.log.result(session, { userId: user.id }, match, after!);
      // Eliminatoria: el bracket se deriva del resultado (mismo cerrojo y misma transacción).
      if (match.stage?.tie) await this.competition.syncKnockout(match.tournamentId, session, { userId: user.id });
    });

    const saved = await this.findOne(id);
    const { playerStats, ...rest } = saved;
    return { match: rest, playerStats };
  }

  private async validateStats(
    match: Match & { _id: unknown },
    dto: SaveResultDto,
    session: ClientSession,
  ) {
    const home = match.homeTeamId.toString();
    const away = match.awayTeamId.toString();
    const errors: string[] = [];

    const seen = new Set<string>();
    const goalsBy: Record<string, number> = { [home]: 0, [away]: 0 };
    for (const s of dto.playerStats) {
      if (seen.has(s.playerId))
        errors.push(`El jugador ${s.playerId} aparece más de una vez`);
      seen.add(s.playerId);
      if (s.teamId !== home && s.teamId !== away) {
        errors.push(
          `teamId ${s.teamId} no es local ni visitante en este partido`,
        );
        continue;
      }
      if (!s.played && (s.goals || s.assists || s.ownGoals || s.yellowCards || s.redCards)) {
        errors.push(
          `El jugador ${s.playerId} tiene estadísticas pero played = false`,
        );
      }
      const cards = cardsError(s);
      if (cards) errors.push(`El jugador ${s.playerId}: ${cards}`);
      goalsBy[s.teamId] += s.goals;
      // Un autogol suma al marcador del rival.
      goalsBy[s.teamId === home ? away : home] += s.ownGoals ?? 0;
    }
    if (goalsBy[home] > dto.homeScore) {
      errors.push(
        `Los goles asignados al local (${goalsBy[home]}, autogoles del rival incluidos) superan su marcador (${dto.homeScore})`,
      );
    }
    if (goalsBy[away] > dto.awayScore) {
      errors.push(
        `Los goles asignados al visitante (${goalsBy[away]}, autogoles del rival incluidos) superan su marcador (${dto.awayScore})`,
      );
    }
    if (errors.length) throw new BadRequestException(errors);

    const playerIds = [...seen].map(toObjectId);
    const existing = await this.players
      .countDocuments({ _id: { $in: playerIds } })
      .session(session);
    if (existing !== playerIds.length)
      throw new BadRequestException('Uno o más jugadores no existen');

    // El jugador debe participar con ese equipo EN ESTE TORNEO: participación activa o
    // vigente en la fecha del partido. Su identidad es global; su participación, no.
    const memberships = await this.memberships
      .find({ playerId: { $in: playerIds }, tournamentId: match.tournamentId })
      .session(session)
      .lean();
    for (const s of dto.playerStats) {
      const belongs = memberships.some(
        (m) =>
          sameId(m.playerId, s.playerId) &&
          sameId(m.teamId, s.teamId) &&
          (m.active ||
            (m.startDate <= match.date &&
              (m.endDate === null || m.endDate >= match.date))),
      );
      if (!belongs)
        errors.push(
          `El jugador ${s.playerId} no está registrado con el equipo ${s.teamId} en este torneo`,
        );
    }
    if (errors.length) throw new BadRequestException(errors);
  }

  private async assertTeams(
    tournamentId: string,
    homeTeamId: string,
    awayTeamId: string,
    session: ClientSession,
  ) {
    if (!(await this.tournaments.exists({ _id: tournamentId }).session(session)))
      throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);
    if (homeTeamId === awayTeamId)
      throw new BadRequestException(
        'El equipo local y el visitante deben ser distintos',
      );
    const enrolled = await this.enrollments
      .countDocuments({
        tournamentId: toObjectId(tournamentId),
        teamId: { $in: [toObjectId(homeTeamId), toObjectId(awayTeamId)] },
      })
      .session(session);
    if (enrolled !== 2)
      throw new BadRequestException(
        'Ambos equipos deben estar inscritos en el torneo',
      );
  }

  /**
   * Transiciones de estado vía PATCH (V1):
   * - FINISHED solo se alcanza capturando el resultado (PUT /result).
   * - Un partido con marcador o estadísticas (FINISHED o LIVE) solo puede estar LIVE o FINISHED:
   *   posponerlo, cancelarlo o devolverlo a programado dejaría resultados incoherentes.
   * - Sin resultado: SCHEDULED ↔ POSTPONED (reprogramar), → LIVE, → CANCELLED y vuelta a SCHEDULED.
   */
  private async assertStatusChange(
    current: Match & { _id: Types.ObjectId },
    next: MatchStatus | undefined,
    session: ClientSession,
  ) {
    if (!next || next === current.status) return;
    const hasScore = current.homeScore !== null || current.awayScore !== null;
    if (next === MatchStatus.FINISHED) {
      if (!hasScore)
        throw new BadRequestException('Un partido FINISHED necesita marcador: captúralo con PUT /matches/:id/result');
      return;
    }
    if (next === MatchStatus.LIVE) return;
    if (hasScore || (await this.hasStats(current._id, session))) {
      throw new ConflictException(
        `El partido ya tiene resultado o estadísticas: no puede pasar a ${next}. Corrige el resultado con PUT /matches/:id/result`,
      );
    }
  }

  /** Ni el local ni el visitante pueden tener otro partido vigente en esa jornada. */
  private async assertRoundAvailable(
    session: ClientSession,
    tournamentId: string,
    round: number,
    homeTeamId: string,
    awayTeamId: string,
    excludeMatchId?: string,
  ) {
    const teams = [toObjectId(homeTeamId), toObjectId(awayTeamId)];
    const clash = await this.matches
      .findOne({
        tournamentId: toObjectId(tournamentId),
        round,
        status: { $ne: MatchStatus.CANCELLED },
        ...(excludeMatchId ? { _id: { $ne: toObjectId(excludeMatchId) } } : {}),
        $or: [{ homeTeamId: { $in: teams } }, { awayTeamId: { $in: teams } }],
      })
      .session(session)
      .lean();
    if (clash) {
      const busy = teams.find((t) => t.equals(clash.homeTeamId) || t.equals(clash.awayTeamId))!;
      throw new ConflictException(
        `El equipo ${busy.toHexString()} ya juega otro partido en la jornada ${round} de este torneo`,
      );
    }
  }

  /** Toda jornada usada por un partido tiene su registro (Round) persistido. */
  private async ensureRound(tournamentId: string, number: number, session: ClientSession) {
    await this.rounds.updateOne(
      { tournamentId: toObjectId(tournamentId), number },
      { $setOnInsert: { name: null, date: null } },
      { upsert: true, session },
    );
  }

  /** Lugar en la estructura de un partido programado a mano (ver CompetitionService.manualStage). */
  private async placeManual(tournamentId: string | Types.ObjectId, homeTeamId: string, awayTeamId: string, session: ClientSession) {
    const t = await this.tournaments.findById(tournamentId).select('settings phases dataCoverage').session(session).lean();
    if (!t) throw new NotFoundException(`Torneo ${String(tournamentId)} no encontrado`);
    return this.competition.manualStage(t, homeTeamId, awayTeamId);
  }

  private async phasesOf(tournamentId: Types.ObjectId, session: ClientSession) {
    return (await this.tournaments.findById(tournamentId).select('phases').session(session).lean())?.phases ?? [];
  }

  private async hasStats(matchId: Types.ObjectId, session: ClientSession) {
    return !!(await this.stats.exists({ matchId }).session(session));
  }

  /**
   * Relee el partido dentro de la transacción: entre la comprobación de propiedad y el cerrojo
   * pudo borrarse o moverse a otro torneo (cuyo cerrojo no tenemos).
   */
  private async reload(id: string, tournamentId: Types.ObjectId, session: ClientSession) {
    const match = await this.matches.findById(id).session(session).lean();
    if (!match) throw new NotFoundException(`Partido ${id} no encontrado`);
    if (!sameId(match.tournamentId, tournamentId))
      throw new ConflictException('El partido cambió de torneo mientras se editaba; recarga e inténtalo de nuevo');
    return match;
  }

  private async getOrFail(id: string) {
    const match = await this.matches.findById(id).lean();
    if (!match) throw new NotFoundException(`Partido ${id} no encontrado`);
    return match;
  }
}

/** Coherencia entre tarjetas y tipo de expulsión, solo cuando la captura lo indica. */
function cardsError(s: { yellowCards: number; redCards: number; sendOff?: SendOff | null }): string | null {
  if (s.sendOff === undefined) return null;
  if (s.sendOff === SendOff.SECOND_YELLOW) {
    return s.yellowCards === 2 && s.redCards === 1 ? null : 'la expulsión por doble amarilla lleva 2 amarillas y la roja';
  }
  if (s.sendOff === SendOff.DIRECT) {
    return s.redCards === 1 && s.yellowCards <= 1 ? null : 'la roja directa lleva la roja y como máximo 1 amarilla previa';
  }
  if (s.redCards) return 'tiene roja: indica si fue directa o por doble amarilla';
  if (s.yellowCards > 1) return 'dos amarillas son expulsión por doble amarilla';
  return null;
}

/** Advertencias de disponibilidad de la cancha (no bloquean): solo si las hay, para no cambiar la respuesta. */
function withWarnings<T extends object>(match: T, warnings: string[]) {
  return warnings.length ? { ...match, warnings } : match;
}

/**
 * Permisos que exige una edición según lo que CAMBIA de verdad (el formulario reenvía todo):
 * cancha → ASSIGNMENTS; en juego / finalizado → RESULTS; el resto (fecha, hora, jornada,
 * equipos, torneo, posponer, cancelar, reprogramar) → SCHEDULE. Sin cambios, SCHEDULE.
 */
function editPermissions(dto: UpdateMatchDto, current: Match): Permission[] {
  const perms = new Set<Permission>();
  if (dto.fieldId !== undefined && !sameId(dto.fieldId ?? '', current.fieldId ?? '')) perms.add(Permission.ASSIGNMENTS);
  if (dto.status !== undefined && dto.status !== current.status) {
    perms.add(dto.status === MatchStatus.LIVE || dto.status === MatchStatus.FINISHED ? Permission.RESULTS : Permission.SCHEDULE);
  }
  const differs = (a: unknown, b: unknown) => a !== undefined && String(a ?? '') !== String(b ?? '');
  const scheduling =
    differs(dto.date, current.date) ||
    differs(dto.time, current.time) ||
    differs(dto.round, current.round) ||
    differs(dto.homeTeamId, current.homeTeamId) ||
    differs(dto.awayTeamId, current.awayTeamId) ||
    differs(dto.tournamentId, current.tournamentId) ||
    // Con cancha, el texto de la sede se deriva de ella: solo cuenta sin cancha.
    (!(dto.fieldId ?? current.fieldId) && differs(dto.venue, current.venue));
  if (scheduling || !perms.size) perms.add(Permission.SCHEDULE);
  return [...perms];
}
