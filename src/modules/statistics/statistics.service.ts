import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { DEFAULT_SETTINGS, Tournament, withCoverage } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { MatchStatus, PhaseType } from '../../common/enums/index.js';
import { phasesOf } from '../competition/formats.js';
import { phaseMatches } from '../competition/tables.js';
import {
  paginated,
  PaginationQueryDto,
  skipFor,
} from '../../common/dto/pagination.dto.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { publicPlayer } from '../../common/utils/public.js';
import { officialMatchesPipeline, type StatWithMatch } from './player-profile.service.js';
import {
  byKickoff,
  computeStandings,
  computeTopScorers,
  pointsRuleOf,
  resultFor,
  sumTotals,
} from './calculations.js';
import { StatsQueryDto } from './dto/statistics.dto.js';

/**
 * Estadísticas derivadas, calculadas en cada consulta a partir de Match (FINISHED)
 * y PlayerMatchStats. Nada se persiste: la consistencia es más importante que el
 * rendimiento en el MVP (ver README para la evolución prevista).
 */
@Injectable()
export class StatisticsService {
  constructor(
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name)
    private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Tournament.name)
    private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name)
    private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
  ) {}

  /**
   * Tabla de la fase de LIGA del torneo, con su puntuación (Tournament.settings). Solo partidos
   * FINISHED de esa fase: los playoffs de LEAGUE_PLAYOFFS no cuentan en la tabla regular. Los
   * formatos sin fase de liga (eliminación, grupos) devuelven []: sus tablas por grupo y su cuadro
   * están en GET /tournaments/:id/structure (una tabla global de grupos sería incorrecta).
   */
  async standings(tournamentId: string) {
    const tournament = await this.tournaments.findById(tournamentId).select('settings dataCoverage').lean();
    if (!tournament) throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);

    const s = { ...DEFAULT_SETTINGS, ...tournament.settings };
    if (phasesOf(s.system)[0] !== PhaseType.LEAGUE) return [];
    const points = pointsRuleOf(s);
    const teamIds = (
      await this.enrollments.distinct('teamId', {
        tournamentId: toObjectId(tournamentId),
      })
    ).map(String);
    const [all, teams] = await Promise.all([
      this.finishedMatches({ tournamentId: toObjectId(tournamentId) }),
      this.teamsById(teamIds),
    ]);
    const matches = phaseMatches(all.map((m) => ({ ...m, stage: m.stage ?? null })), 0);
    return computeStandings(
      teamIds,
      matches,
      (id) => teams.get(id)?.name ?? '',
      points,
    ).map((row) => ({
      ...row,
      team: teams.get(row.teamId) ?? null,
    }));
  }

  /** Goleadores GLOBALES del torneo: solo con cobertura FULL (los del equipo están en su perfil). */
  async topScorers(tournamentId: string, limit: number) {
    const tournament = await this.tournaments.findById(tournamentId).select('dataCoverage').lean();
    if (!tournament) throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);

    const matches = await this.finishedMatches({
      tournamentId: toObjectId(tournamentId),
    });
    const stats = await this.statsOf({
      matchId: { $in: matches.map((m) => toObjectId(m.id)) },
    });
    const rows = computeTopScorers(matches, stats, limit);
    const [players, teams] = await Promise.all([
      this.playersById(rows.map((r) => r.playerId)),
      this.teamsById(rows.map((r) => r.teamId)),
    ]);
    return rows.map((r) => ({
      ...r,
      player: players.get(r.playerId) ?? null,
      team: teams.get(r.teamId) ?? null,
    }));
  }

  /** Totales globales + desglose por torneo/equipo. Solo partidos finalizados y jugados. */
  async playerStats(playerId: string) {
    await this.assertPlayer(playerId);
    const entries = await this.playerEntries(playerId);
    const groups = new Map<string, typeof entries>();
    for (const e of entries) {
      const key = `${e.match.tournamentId}|${e.stat.teamId}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const tournamentIds = [
      ...new Set(entries.map((e) => e.match.tournamentId)),
    ];
    const [tournaments, teams] = await Promise.all([
      this.tournaments
        .find({ _id: { $in: tournamentIds.map(toObjectId) } })
        .lean(),
      this.teamsById(entries.map((e) => e.stat.teamId)),
    ]);
    const tournamentById = new Map(
      serialize(tournaments.map(withCoverage)).map((t) => [t.id, t]),
    );

    const byTournament = [...groups.entries()]
      .map(([key, list]) => {
        const [tournamentId, teamId] = key.split('|');
        return {
          tournament: tournamentById.get(tournamentId) ?? null,
          team: teams.get(teamId) ?? null,
          ...sumTotals(list.map((e) => e.stat)),
        };
      })
      .sort((a, b) =>
        (b.tournament?.startDate ?? '').localeCompare(
          a.tournament?.startDate ?? '',
        ),
      );

    return {
      playerId,
      totals: sumTotals(entries.map((e) => e.stat)),
      byTournament,
    };
  }

  /**
   * Partidos oficiales del jugador con sus estadísticas (más reciente primero), paginados EN LA
   * BASE: una consulta ($lookup + $facet) para la página y el total, y otra para sus equipos y
   * torneos. Forma compatible con V1 (`match, stats, isHome, team, opponent, result`) más
   * `tournament` para no requerir otra petición.
   */
  async playerMatches(playerId: string, query: PaginationQueryDto) {
    await this.assertPlayer(playerId);
    const [facet] = await this.stats.aggregate<{ rows: StatWithMatch[]; total: { n: number }[] }>(
      officialMatchesPipeline(playerId, { skip: skipFor(query), limit: query.limit }),
    );
    const rows = facet?.rows ?? [];
    const [teams, tournaments] = await Promise.all([
      this.teamsById(rows.flatMap((r) => [r.match.homeTeamId.toHexString(), r.match.awayTeamId.toHexString()])),
      this.tournaments
        .find({ _id: { $in: rows.map((r) => r.match.tournamentId) } })
        .select('name')
        .lean(),
    ]);
    const tournamentName = new Map(tournaments.map((t) => [t._id.toHexString(), t.name]));
    const data = rows.map(({ match: raw, ...rawStat }) => {
      const match = serialize(raw);
      const stat = serialize(rawStat);
      const isHome = match.homeTeamId === stat.teamId;
      return {
        match,
        stats: stat,
        isHome,
        tournament: { id: match.tournamentId, name: tournamentName.get(match.tournamentId) ?? null },
        team: teams.get(stat.teamId) ?? null,
        opponent: teams.get(isHome ? match.awayTeamId : match.homeTeamId) ?? null,
        result: resultFor(match, stat.teamId),
      };
    });
    return paginated(data, facet?.total[0]?.n ?? 0, query);
  }

  /** Listado crudo de participaciones (lo usa el frontend para sus cálculos en cliente). */
  async list(query: StatsQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.playerId) filter.playerId = toObjectId(query.playerId);
    if (query.matchId) filter.matchId = toObjectId(query.matchId);
    if (query.tournamentId) {
      const ids = (await this.matches.distinct('_id', {
        tournamentId: toObjectId(query.tournamentId),
      })) as Types.ObjectId[];
      filter.matchId = query.matchId
        ? { $in: ids.filter((id) => id.equals(query.matchId!)) }
        : { $in: ids };
    }
    const [items, total] = await Promise.all([
      this.stats
        .find(filter)
        .sort({ _id: 1 })
        .skip(skipFor(query))
        .limit(query.limit)
        .lean(),
      this.stats.countDocuments(filter),
    ]);
    return paginated(serialize(items), total, query);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async playerEntries(playerId: string) {
    const stats = await this.statsOf({
      playerId: toObjectId(playerId),
      played: true,
    });
    const matches = await this.finishedMatches({
      _id: { $in: stats.map((s) => toObjectId(s.matchId)) },
    });
    const matchById = new Map(matches.map((m) => [m.id, m]));
    return stats
      .filter((s) => matchById.has(s.matchId))
      .map((stat) => ({ stat, match: matchById.get(stat.matchId)! }))
      .sort((a, b) => byKickoff(b.match, a.match));
  }

  private async finishedMatches(filter: Record<string, unknown>) {
    return serialize(
      await this.matches
        .find({ ...filter, status: MatchStatus.FINISHED })
        .lean(),
    );
  }

  private async statsOf(filter: Record<string, unknown>) {
    return serialize(await this.stats.find(filter).lean());
  }

  private async teamsById(ids: string[]) {
    const teams = await this.teams
      .find({ _id: { $in: [...new Set(ids)].map(toObjectId) } })
      .lean();
    return new Map(serialize(teams).map((t) => [t.id, t]));
  }

  private async playersById(ids: string[]) {
    const players = await this.players
      .find({ _id: { $in: ids.map(toObjectId) } })
      .lean();
    return new Map(players.map((p) => [p._id.toHexString(), publicPlayer(p)]));
  }

  private async assertPlayer(id: string) {
    if (!(await this.players.exists({ _id: id })))
      throw new NotFoundException(`Jugador ${id} no encontrado`);
  }
}
