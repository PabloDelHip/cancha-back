import { withPlayerName, withTeamName } from '../../common/history/identity.js';
import { TournamentIdentityService } from '../../common/history/tournament-identity.service.js';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { DataCoverage, MatchStatus, SanctionStatus, TournamentStatus } from '../../common/enums/index.js';
import { Permission } from '../../common/authorization/permissions.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { LeagueAccessService } from '../../common/authorization/league-access.service.js';
import { OrganizerAccessService } from '../../common/authorization/organizer-access.service.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { CompetitionService } from '../competition/competition.service.js';
import { buildStructure } from '../competition/structure.js';
import { DisciplineService } from '../discipline/discipline.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { Round } from '../rounds/schemas/round.schema.js';
import { computeTopScorers } from '../statistics/calculations.js';
import { Team } from '../teams/schemas/team.schema.js';
import type { AuthUser } from '../auth/auth.types.js';
import { closureBlockers, pendingWarnings, runnerUpOf, type ClosureIssue } from './closure.js';
import type { NextSeasonDto } from './dto/closure.dto.js';
import { Tournament, withCoverage } from './schemas/tournament.schema.js';
import { TournamentTeam } from './schemas/tournament-team.schema.js';
import { TournamentsService } from './tournaments.service.js';

/** Estados que todavía cuentan como «por jugar» al cerrar (los cancelados no). */
const PENDING = [MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.POSTPONED, MatchStatus.SUSPENDED];

/**
 * Módulo 10A — cierre y temporadas.
 * - Vista previa del cierre (solo lectura): ¿se puede finalizar?, bloqueantes, advertencias y lo
 *   deportivo que quedará como definitivo. Mismas reglas que POST /finish (closure.ts).
 * - Nueva temporada a partir de otra: copia la configuración reutilizable y los equipos; nunca
 *   resultados, estadísticas, sanciones, jugadores ni dinero. Nace en DRAFT.
 */
@Injectable()
export class TournamentClosureService {
  constructor(
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    @InjectConnection() private readonly connection: Connection,
    private readonly access: TournamentAccessService,
    private readonly leagues: LeagueAccessService,
    private readonly organizers: OrganizerAccessService,
    private readonly competition: CompetitionService,
    private readonly discipline: DisciplineService,
    private readonly finance: FinanceService,
    private readonly service: TournamentsService,
    private readonly identity: TournamentIdentityService,
  ) {}

  // ─── Vista previa del cierre ─────────────────────────────────────────────────

  /** GET /tournaments/:id/closure — quien puede finalizar (LIFECYCLE). No escribe nada. */
  async preview(id: string, user: AuthUser) {
    const { tournament } = await this.access.require(id, user.id, Permission.LIFECYCLE);
    const tid = toObjectId(id);
    const [summary, enrolled, unscheduled, competitionBlockers, ctx, pendingRounds, roundNames] = await Promise.all([
      this.service.summary(id),
      this.enrollments.find({ tournamentId: tid }).select('withdrawnAt').lean(),
      this.matches.countDocuments({ tournamentId: tid, status: MatchStatus.POSTPONED, pendingSchedule: true }),
      tournament.status === TournamentStatus.ACTIVE ? this.competition.finishBlockers(tid) : Promise.resolve([]),
      this.competition.context(tid),
      this.matches.aggregate<{ _id: number; pending: number; total: number }>([
        { $match: { tournamentId: tid, status: { $ne: MatchStatus.CANCELLED } } },
        { $group: { _id: '$round', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $in: ['$status', PENDING] }, 1, 0] } } } },
        { $sort: { _id: 1 } },
      ]),
      this.rounds.find({ tournamentId: tid }).select('number name').lean(),
    ]);
    const name = new Map(roundNames.map((r) => [r.number, r.name]));
    const nameOf = (teamId: string) => ctx.teamMap.get(teamId)?.name ?? 'Equipo';
    const view = buildStructure(ctx.input);

    const blockers = closureBlockers(tournament.status, competitionBlockers, summary.live);
    const warnings: ClosureIssue[] = pendingWarnings({ scheduled: summary.scheduled, postponed: summary.postponed - unscheduled, pendingSchedule: unscheduled, suspended: summary.suspended });
    const incomplete = pendingRounds.filter((r) => r.pending > 0).map((r) => ({ round: r._id, label: name.get(r._id)?.trim() || `Jornada ${r._id}`, pending: r.pending, total: r.total }));
    if (incomplete.length) warnings.push({ code: 'INCOMPLETE_ROUNDS', count: incomplete.length, message: `${incomplete.length === 1 ? 'Una jornada incompleta' : `${incomplete.length} jornadas incompletas`}: ${incomplete.map((r) => r.label).join(', ')}` });
    // Sin campeón determinado (liga sin terminar o empate en el primer lugar sin desempate): el
    // historial no mostrará campeón. En eliminatoria ya es un bloqueante.
    if (!competitionBlockers.length && !view.championTeamId && tournament.status === TournamentStatus.ACTIVE)
      warnings.push({ code: 'NO_CHAMPION', message: 'La competición todavía no define un campeón (faltan partidos o hay un empate en el primer lugar sin desempate): si finalizas así, el historial no mostrará campeón' });

    // Información que el organizador debe conocer (no impide cerrar): sanciones y adeudos.
    const disc = await this.discipline.overview(id, user);
    const unserved = disc.sanctions.filter((s) => (s.status === SanctionStatus.ACTIVE || s.status === SanctionStatus.PENDING) && s.remaining > 0);
    if (unserved.length) warnings.push({ code: 'UNSERVED_SANCTIONS', count: unserved.length, message: `${unserved.length === 1 ? 'Una sanción quedará' : `${unserved.length} sanciones quedarán`} sin cumplir: las sanciones no pasan a otro torneo` });
    const accounts = await this.finance.accounts(id, user);
    const owing = accounts.accounts.filter((a) => a.due > 0);
    if (owing.length)
      warnings.push({
        code: 'OUTSTANDING_BALANCES',
        count: owing.length,
        message: `${owing.length === 1 ? 'Un equipo tiene' : `${owing.length} equipos tienen`} adeudo (${(owing.reduce((n, a) => n + a.due, 0) / 100).toFixed(2)} ${accounts.currency}). Finalizar no lo borra: los cobros pueden registrarse después del cierre`,
      });

    return {
      tournamentId: id,
      status: tournament.status,
      canFinish: blockers.length === 0,
      /** Con partidos sin jugar, POST /finish exige `allowPendingMatches: true`. */
      requiresConfirmation: summary.pending > 0,
      blockers,
      warnings,
      teams: { enrolled: enrolled.length, withdrawn: enrolled.filter((e) => e.withdrawnAt).length },
      matches: { ...summary, pendingSchedule: unscheduled },
      rounds: { total: pendingRounds.length, incomplete },
      // Lo deportivo según la estructura actual (el mismo cálculo que las tablas y el historial).
      champion: view.championTeamId ? { teamId: view.championTeamId, name: nameOf(view.championTeamId) } : null,
      runnerUp: ((r) => (r ? { teamId: r, name: nameOf(r) } : null))(runnerUpOf(view)),
      topScorers: await this.topScorers(tid),
      finished: tournament.status === TournamentStatus.FINISHED ? { at: tournament.finishedAt ?? null, by: tournament.finishedBy ? String(tournament.finishedBy) : null, role: tournament.finishedRole ?? null, pendingAtFinish: tournament.pendingAtFinish ?? null } : null,
    };
  }

  /** Los 3 primeros goleadores (solo partidos FINISHED y participaciones `played`, como Estadísticas). */
  private async topScorers(tid: Types.ObjectId) {
    const finished = serialize(await this.matches.find({ tournamentId: tid, status: MatchStatus.FINISHED }).lean());
    const stats = serialize(await this.stats.find({ matchId: { $in: finished.map((m) => toObjectId(m.id)) } }).lean());
    const rows = computeTopScorers(finished, stats, 3);
    const [players, teams, hist] = await Promise.all([
      this.players.find({ _id: { $in: rows.map((r) => toObjectId(r.playerId)) } }).select('firstName lastName').lean(),
      this.teams.find({ _id: { $in: rows.map((r) => toObjectId(r.teamId)) } }).select('name').lean(),
      this.identity.names(tid),
    ]);
    // 10C: en un torneo finalizado, goleador y equipo con los nombres con que se jugó.
    const p = new Map(players.map((x) => ((n) => [x._id.toHexString(), `${n.firstName} ${n.lastName}`.trim()] as const)(withPlayerName(x, x._id.toHexString(), hist))));
    const t = new Map(teams.map((x) => [x._id.toHexString(), withTeamName({ name: x.name }, x._id.toHexString(), hist).name]));
    return rows.map((r) => ({ position: r.position, playerId: r.playerId, name: p.get(r.playerId) ?? 'Jugador', team: t.get(r.teamId) ?? 'Equipo', goals: r.goals, matches: r.matchesPlayed }));
  }

  // ─── Nueva temporada ─────────────────────────────────────────────────────────

  /**
   * POST /tournaments/:id/next-season — solo el PROPIETARIO del torneo de origen (crea un torneo en su
   * cuenta y en su liga). Copia: liga, modalidad, categoría, sede, configuración deportiva, reglamento
   * disciplinario, restricciones de calendario, información y límites de inscripción. Inscribe los
   * equipos elegidos (por defecto, los que no se retiraron). Nunca copia partidos, jornadas, fases,
   * resultados, estadísticas, sanciones, bloqueos, jugadores, colaboradores, dinero ni el logo.
   * Las fechas de la temporada anterior (apertura y cierre de inscripciones, límite de transferencias)
   * se vacían y las inscripciones por enlace quedan cerradas: el organizador las abre cuando quiera.
   * Todo en una transacción: o se crea la temporada con sus equipos, o nada.
   */
  async nextSeason(id: string, dto: NextSeasonDto, user: AuthUser) {
    const source = await this.tournaments.findById(id).select('+scheduling +discipline').lean();
    if (!source) throw new NotFoundException(`Torneo ${id} no encontrado`);
    const role = await this.access.roleOf(id, user.id);
    if (!role) throw new ForbiddenException('No tienes permiso para administrar este torneo');
    if (role !== 'OWNER') throw new ForbiddenException('Solo el propietario del torneo puede crear la siguiente temporada');
    await this.organizers.requireOrganizer(user);
    if (dto.endDate && dto.endDate < dto.startDate) throw new BadRequestException('La fecha de fin no puede ser anterior a la de inicio');
    const leagueId = await this.leagues.forNewTournament(user, source.leagueId ? String(source.leagueId) : null);

    // Equipos: por defecto los que siguieron hasta el final; si se eligen, deben haber participado.
    const enrolled = await this.enrollments.find({ tournamentId: source._id }).select('teamId withdrawnAt').lean();
    const inSource = new Map(enrolled.map((e) => [e.teamId.toHexString(), e]));
    let teamIds: string[];
    if (dto.teamIds) {
      const unknown = dto.teamIds.filter((t) => !inSource.has(t));
      if (unknown.length) throw new BadRequestException('Solo se pueden inscribir equipos que participaron en el torneo de origen');
      teamIds = [...new Set(dto.teamIds)];
    } else teamIds = enrolled.filter((e) => !e.withdrawnAt).map((e) => e.teamId.toHexString());
    const existing = new Set((await this.teams.find({ _id: { $in: teamIds.map(toObjectId) } }).select('_id').lean()).map((t) => t._id.toHexString()));
    const missing = teamIds.filter((t) => !existing.has(t));
    teamIds = teamIds.filter((t) => existing.has(t));
    const maxTeams = source.registration?.maxTeams ?? null;
    if (maxTeams && teamIds.length > maxTeams) throw new BadRequestException(`El torneo admite hasta ${maxTeams} equipos y elegiste ${teamIds.length}`);

    const information = { ...source.information, season: dto.season?.trim() || null, enrollment: { ...source.information?.enrollment, opensOn: null } };
    const registration = { ...source.registration, enabled: false, deadline: null, transferDeadline: null };
    const doc = {
      name: dto.name,
      format: source.format,
      category: source.category,
      startDate: dto.startDate,
      endDate: dto.endDate ?? null,
      venue: source.venue ?? null,
      settings: source.settings,
      information,
      registration,
      ...(source.discipline ? { discipline: source.discipline } : {}),
      ...(source.scheduling ? { scheduling: source.scheduling } : {}),
      status: TournamentStatus.DRAFT,
      dataCoverage: DataCoverage.FULL,
      leagueId,
      organizerId: toObjectId(user.id),
      previousTournamentId: source._id,
    };
    const created = await this.connection.transaction(async (session) => {
      const [t] = await this.tournaments.create([doc], { session });
      if (teamIds.length) await this.enrollments.insertMany(teamIds.map((teamId) => ({ tournamentId: t._id, teamId: toObjectId(teamId) })), { session });
      return t.toObject();
    });
    // Como el resto de respuestas del torneo: sin los subdocumentos internos (reglamento y calendario).
    const { discipline: _d, scheduling: _s, writeSeq: _w, ...tournament } = created;
    return {
      tournament: serialize(withCoverage(tournament), { includePrivateTournamentContact: true }),
      teams: { enrolled: teamIds.length, notEnrolled: enrolled.length - teamIds.length - missing.length, missing: missing.length },
      copied: ['Liga', 'Modalidad y categoría', 'Sede', 'Sistema de competición y puntuación', 'Reglamento disciplinario', 'Restricciones de calendario', 'Información del torneo', 'Límites de inscripción', 'Equipos'],
      notCopied: ['Calendario, jornadas y resultados', 'Estadísticas, tabla y goleadores', 'Sanciones y bloqueos', 'Jugadores inscritos (se inscriben de nuevo)', 'Cargos, pagos y adeudos', 'Colaboradores', 'Logo', 'Fechas de inscripción de la temporada anterior'],
    };
  }
}
