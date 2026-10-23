import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Round } from './schemas/round.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { CompetitionSystem, MatchLogCause, MatchStatus } from '../../common/enums/index.js';
import { GenerateScheduleDto } from './dto/round.dto.js';
import { manualBracketSizes, pendingAware, planInitialPhase, planManualStart } from '../competition/planner.js';
import { validateFormatForTeams } from '../competition/formats.js';
import { DEFAULT_SETTINGS, Tournament } from '../tournaments/schemas/tournament.schema.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { assertAssignmentsReleased } from '../venues/venues.service.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import { SchedulingService } from '../scheduling/scheduling.service.js';
import { applyAssignments, fixtureKey, roundsWithDates } from '../scheduling/auto-scheduler.js';
import type { AuthUser } from '../auth/auth.types.js';

/**
 * Genera el calendario de liga (jornadas + partidos) con los equipos inscritos. Con `manual: true`
 * solo arma la estructura (grupos o cuadro vacío) y el organizador programa sus partidos.
 *
 * Reglas:
 * - dueño del torneo y torneo no finalizado; sistema LEAGUE; al menos 2 equipos;
 * - si algún partido tiene resultado, estadísticas o está LIVE/FINISHED → 409 (nunca se
 *   regenera un calendario con historia);
 * - si hay partidos sin resultado, se reemplazan solo con `replaceExisting: true`.
 *
 * Atomicidad: las comprobaciones, el borrado del calendario anterior y la creación del nuevo
 * van en UNA transacción con el cerrojo del torneo (MongoDB en replica set). Si algo falla,
 * no queda ni el calendario a medias ni se pierde el anterior; y un resultado capturado a la
 * vez no puede quedar borrado (o huérfano) por la regeneración.
 */
@Injectable()
export class ScheduleService {
  constructor(
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    private readonly ownership: OwnershipService,
    private readonly log: MatchLogService,
    private readonly scheduling: SchedulingService,
  ) {}

  async generate(tournamentId: string, dto: GenerateScheduleDto, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.SCHEDULE);
    // 6B: confirmar una propuesta con canchas también asigna canchas.
    if (dto.assignments?.some((a) => a.fieldId)) await this.ownership.tournament(tournamentId, user, Permission.ASSIGNMENTS);
    const tid = toObjectId(tournamentId);
    return this.ownership.inTournament(tid, { user, permission: Permission.SCHEDULE }, async (session) => {
      const { plan, existing } = await this.prepare(tid, dto, session);
      await assertAssignmentsReleased(this.matches, tid, dto.releaseAssignments, session);
      if (existing.length && !dto.replaceExisting) {
        throw new ConflictException(
          `El torneo ya tiene ${existing.length} partidos programados. Para reemplazarlos envía replaceExisting: true`,
        );
      }
      // 6B: los horarios de la propuesta confirmada, sobre los mismos partidos que vuelve a planear el servidor.
      const planned = dto.assignments && !dto.manual ? applyAssignments(plan.matches, dto.assignments, dto.allowPending ?? 0) : plan.matches.map((m) => ({ ...m, fieldId: null as string | null, pending: false }));
      const rounds = dto.assignments && !dto.manual ? roundsWithDates(plan.rounds, planned) : plan.rounds;
      // 6A: el calendario nuevo (que reemplaza al anterior) cumple las restricciones obligatorias o no
      // se genera (409 con cada partido y lo que incumple). Se revalida también al confirmar una
      // propuesta (6B): la disponibilidad pudo cambiar desde la vista previa.
      // Los por programar (6C) no tienen horario: no se evalúan ni reservan nada.
      const warnings = await this.scheduling.enforce(session, tid, planned.filter((m) => !m.pending).map((m, i) => ({
        key: String(i), matchId: null, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, date: m.date, time: m.time, fieldId: m.fieldId, round: m.round,
      })), { replaceAll: true });

      // Los partidos reemplazados quedan en el historial del torneo (una sola entrada, con lo liberado).
      await this.log.removeMatches(session, { userId: user.id }, { tournamentId: tid }, MatchLogCause.SCHEDULE_REGENERATED, { bulk: true });
      await this.rounds.deleteMany({ tournamentId: tid }, { session });
      await this.rounds.insertMany(rounds.map((r) => ({ tournamentId: tid, ...r })), { session });
      if (planned.length) {
        const inserted = await this.matches.insertMany(planned.map(pendingAware(tid)), { session });
        // 6B: canchas con la validación de siempre (cerrojo de la sede, choques con otros torneos).
        warnings.push(...(await this.scheduling.assignFields(session, tid, inserted)));
      }
      await this.tournaments.updateOne({ _id: tid }, { $set: { phases: plan.phase ? [plan.phase] : [] } }, { session });

      const savedRounds = await this.rounds.find({ tournamentId: tid }).sort({ number: 1 }).session(session).lean();
      const matches = await this.matches
        .find({ tournamentId: tid })
        .sort({ round: 1, date: 1, time: 1 })
        .session(session)
        .lean();
      return { rounds: serialize(savedRounds), matches: serialize(matches), replaced: existing.length, warnings: [...new Set(warnings)] };
    });
  }

  /**
   * 6B — vista previa: los partidos del formato (los mismos que `generate`) con la fecha, hora y
   * cancha que les encuentra la búsqueda. No escribe nada; confirmar es `generate` con `assignments`.
   */
  async proposal(tournamentId: string, dto: GenerateScheduleDto, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user, Permission.SCHEDULE);
    if (dto.fieldIds?.length) await this.ownership.tournament(tournamentId, user, Permission.ASSIGNMENTS);
    if (dto.manual) throw new BadRequestException('Armar a mano no genera partidos: no hay propuesta que calcular');
    const tid = toObjectId(tournamentId);
    const { plan, existing } = await this.prepare(tid, dto, null);
    const proposal = await this.scheduling.propose(null, tid, {
      fixtures: plan.matches.map((m) => ({ key: fixtureKey(m), round: m.round, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId })),
      from: dto.startDate,
      to: dto.endDate ?? null,
      days: dto.days,
      firstKickoff: dto.firstKickoff,
      lastKickoff: dto.lastKickoff ?? null,
      step: dto.minutesBetweenMatches > 0 ? dto.minutesBetweenMatches : null,
      daysBetweenRounds: dto.daysBetweenRounds,
      fieldIds: dto.fieldIds,
      parallel: dto.fieldIds?.length ? null : (dto.parallel ?? 1),
      replaceAll: true,
    });
    return {
      ...proposal,
      rounds: plan.rounds.map((r) => ({ number: r.number, name: r.name })),
      replaces: existing.length,
      replacesWithAssignments: existing.filter((m) => m.fieldId || m.referees?.length).length,
    };
  }

  /**
   * Lo que comparten la generación y su vista previa: inscritos, siembra, grupos, la regla de no
   * regenerar con historia y los partidos del formato.
   */
  private async prepare(tid: Types.ObjectId, dto: GenerateScheduleDto, session: ClientSession | null) {
    const tournament = (await this.tournaments.findById(tid).session(session).lean())!;
    const settings = { ...DEFAULT_SETTINGS, ...tournament.settings };
    // 3D: los retirados no entran en un calendario nuevo.
    const enrolled = (await this.enrollments.distinct('teamId', { tournamentId: tid, withdrawnAt: null }).session(session)).map(String);
    const formatErrors = validateFormatForTeams(settings, enrolled.length);
    if (formatErrors.length) throw new BadRequestException(formatErrors);
    // Orden determinista: la siembra del organizador o, por defecto, alfabético.
    const byName = (await this.teams.find({ _id: { $in: enrolled.map(toObjectId) } }).select('name').sort({ name: 1, _id: 1 }).session(session).lean()).map((t) =>
      t._id.toHexString(),
    );
    const seeding = dto.seeding ?? byName;
    if (dto.seeding && !samePermutation(dto.seeding, enrolled)) {
      throw new BadRequestException('seeding debe contener exactamente a cada equipo inscrito una vez');
    }
    if (dto.groups) this.assertGroups(dto.groups, enrolled, settings);

    const existing = await this.matches
      .find({ tournamentId: tid })
      .select('status homeScore awayScore fieldId referees')
      .session(session)
      .lean();
    const withHistory =
      existing.filter(
        (m) =>
          m.status === MatchStatus.FINISHED ||
          m.status === MatchStatus.LIVE ||
          m.status === MatchStatus.SUSPENDED ||
          m.homeScore !== null ||
          m.awayScore !== null,
      ).length ||
      (existing.length
        ? await this.stats.countDocuments({ matchId: { $in: existing.map((m) => m._id) } }).session(session)
        : 0);
    if (withHistory) {
      throw new ConflictException(
        'El torneo ya tiene partidos jugados o en juego: su calendario no se puede regenerar. Agrega jornadas y partidos manualmente.',
      );
    }

    if (dto.manual && settings.system === CompetitionSystem.KNOCKOUT && !manualBracketSizes(enrolled.length).includes(dto.bracketSize ?? 0)) {
      throw new BadRequestException(
        `Elige con qué ronda empieza el cuadro: ${manualBracketSizes(enrolled.length).join(', ')} equipos (con ${enrolled.length} inscritos)`,
      );
    }
    const base = {
      system: settings.system,
      legs: dto.legs ?? settings.roundRobinLegs,
      knockoutLegs: settings.knockoutLegs,
      reseed: settings.reseed ?? false,
      groupCount: settings.groupCount,
      teamIds: seeding,
      groups: dto.groups,
    };
    const plan = dto.manual ? planManualStart({ ...base, bracketSize: dto.bracketSize ?? null }) : planInitialPhase({
      ...base,
      schedule: {
        startDate: dto.startDate,
        daysBetweenRounds: dto.daysBetweenRounds,
        firstKickoff: dto.firstKickoff,
        minutesBetweenMatches: dto.minutesBetweenMatches,
        venue: dto.venue?.trim() || tournament.venue || null,
      },
    });
    if (plan.rounds.length > 99) throw new BadRequestException('El calendario superaría las 99 jornadas');
    return { plan, existing };
  }

  /** Grupos explícitos: partición exacta de los inscritos, con el número y tamaño configurados. */
  private assertGroups(groups: string[][], enrolled: string[], settings: { system: CompetitionSystem; groupCount: number | null; qualifiersPerGroup: number | null }) {
    if (settings.system !== CompetitionSystem.GROUPS_KNOCKOUT) throw new BadRequestException('groups solo aplica al formato de grupos + eliminación');
    if (groups.length !== settings.groupCount) throw new BadRequestException(`Se esperaban ${settings.groupCount} grupos`);
    if (!samePermutation(groups.flat(), enrolled)) throw new BadRequestException('Los grupos deben contener exactamente a cada equipo inscrito una vez');
    const min = Math.min(...groups.map((g) => g.length));
    if (min < 2) throw new BadRequestException('Cada grupo necesita al menos 2 equipos');
    if ((settings.qualifiersPerGroup ?? 0) > min) {
      throw new BadRequestException(`Clasifican ${settings.qualifiersPerGroup} por grupo pero hay un grupo de ${min}`);
    }
  }
}

const samePermutation = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && [...a].sort().join() === [...b].sort().join();

