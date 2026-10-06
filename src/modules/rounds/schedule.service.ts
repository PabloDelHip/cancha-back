import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Round } from './schemas/round.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { CompetitionSystem, MatchStatus } from '../../common/enums/index.js';
import { GenerateScheduleDto } from './dto/round.dto.js';
import { manualBracketSizes, matchDoc, planInitialPhase, planManualStart } from '../competition/planner.js';
import { validateFormatForTeams } from '../competition/formats.js';
import { DEFAULT_SETTINGS, Tournament } from '../tournaments/schemas/tournament.schema.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
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
  ) {}

  async generate(tournamentId: string, dto: GenerateScheduleDto, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user);
    const tid = toObjectId(tournamentId);
    return this.ownership.inTournament(tid, async (session) => {
      const tournament = (await this.tournaments.findById(tid).session(session).lean())!;
      const settings = { ...DEFAULT_SETTINGS, ...tournament.settings };
      const enrolled = (await this.enrollments.distinct('teamId', { tournamentId: tid }).session(session)).map(String);
      const formatErrors = validateFormatForTeams(settings, enrolled.length);
      if (formatErrors.length) throw new BadRequestException(formatErrors);
      // Orden determinista: la siembra del organizador o, por defecto, alfabético.
      const byName = (await this.teams.find({ _id: { $in: enrolled.map(toObjectId) } }).select('name').sort({ name: 1, _id: 1 }).lean()).map((t) =>
        t._id.toHexString(),
      );
      const seeding = dto.seeding ?? byName;
      if (dto.seeding && !samePermutation(dto.seeding, enrolled)) {
        throw new BadRequestException('seeding debe contener exactamente a cada equipo inscrito una vez');
      }
      if (dto.groups) this.assertGroups(dto.groups, enrolled, settings);

      const existing = await this.matches
        .find({ tournamentId: tid })
        .select('status homeScore awayScore')
        .session(session)
        .lean();
      const withHistory =
        existing.filter(
          (m) =>
            m.status === MatchStatus.FINISHED ||
            m.status === MatchStatus.LIVE ||
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
      if (existing.length && !dto.replaceExisting) {
        throw new ConflictException(
          `El torneo ya tiene ${existing.length} partidos programados. Para reemplazarlos envía replaceExisting: true`,
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

      await this.matches.deleteMany({ tournamentId: tid }, { session });
      await this.rounds.deleteMany({ tournamentId: tid }, { session });
      await this.rounds.insertMany(plan.rounds.map((r) => ({ tournamentId: tid, ...r })), { session });
      if (plan.matches.length) await this.matches.insertMany(plan.matches.map((m) => matchDoc(tid, m)), { session });
      await this.tournaments.updateOne({ _id: tid }, { $set: { phases: plan.phase ? [plan.phase] : [] } }, { session });

      const rounds = await this.rounds.find({ tournamentId: tid }).sort({ number: 1 }).session(session).lean();
      const matches = await this.matches
        .find({ tournamentId: tid })
        .sort({ round: 1, date: 1, time: 1 })
        .session(session)
        .lean();
      return { rounds: serialize(rounds), matches: serialize(matches), replaced: existing.length };
    });
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
