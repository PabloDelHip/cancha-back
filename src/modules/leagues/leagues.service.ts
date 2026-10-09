import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { League } from './schemas/league.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { CompetitionService } from '../competition/competition.service.js';
import { buildStructure } from '../competition/structure.js';
import { MatchStatus, PhaseType, PlayerPosition, TournamentStatus } from '../../common/enums/index.js';
import { OrganizerAccessService } from '../../common/authorization/organizer-access.service.js';
import { LeagueAccessService } from '../../common/authorization/league-access.service.js';
import { publicPlayer, teamRef, tournamentRef, type TeamRef } from '../../common/utils/public.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { CreateLeagueDto, UpdateLeagueDto } from './dto/league.dto.js';

const TOURNAMENT_FIELDS = 'name status category format startDate endDate dataCoverage settings';

/**
 * Ligas: agrupan torneos (Apertura, Clausura, copas…) de un mismo dueño y construyen su histórico.
 * Lectura pública; escribir solo el dueño (LeagueAccessService).
 */
@Injectable()
export class LeaguesService {
  constructor(
    @InjectModel(League.name) private readonly leagues: Model<League>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    private readonly access: LeagueAccessService,
    private readonly organizers: OrganizerAccessService,
    private readonly competition: CompetitionService,
  ) {}

  async create(dto: CreateLeagueDto, user: AuthUser) {
    await this.organizers.requireOrganizer(user);
    const created = await this.leagues.create({ ...dto, organizerId: toObjectId(user.id) });
    return this.view(created.toObject());
  }

  async update(id: string, dto: UpdateLeagueDto, user: AuthUser) {
    await this.access.owned(id, user);
    const updated = await this.leagues.findByIdAndUpdate(id, dto, { new: true, runValidators: true }).lean();
    return this.view(updated!);
  }

  /** Solo una liga vacía: sus torneos (y su historia) no se borran en cascada. */
  async remove(id: string, user: AuthUser) {
    await this.access.owned(id, user);
    if (await this.tournaments.exists({ leagueId: toObjectId(id) })) {
      throw new ConflictException('La liga tiene torneos: muévelos a otra liga o bórralos antes');
    }
    await this.leagues.deleteOne({ _id: toObjectId(id) });
  }

  /** GET /leagues — ligas con al menos un torneo (las vacías no se publican). */
  async list() {
    const counts = await this.tournaments.aggregate<{ _id: Types.ObjectId; n: number; last: string }>([
      { $match: { leagueId: { $ne: null } } },
      { $group: { _id: '$leagueId', n: { $sum: 1 }, last: { $max: '$startDate' } } },
    ]);
    const byId = new Map(counts.map((c) => [c._id.toHexString(), c]));
    const leagues = await this.leagues.find({ _id: { $in: counts.map((c) => c._id) } }).lean();
    return leagues
      .map((l) => ({ ...this.view(l), tournaments: byId.get(l._id.toHexString())!.n, lastStartDate: byId.get(l._id.toHexString())!.last }))
      .sort((a, b) => b.lastStartDate.localeCompare(a.lastStartDate));
  }

  /** GET /admin/leagues — mis ligas (también las vacías), con su número de torneos. */
  async mine(user: AuthUser) {
    const id = toObjectId(user.id);
    const [leagues, counts] = await Promise.all([
      this.leagues.find({ organizerId: id }).sort({ createdAt: -1 }).lean(),
      this.tournaments.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { organizerId: id } }, { $group: { _id: '$leagueId', n: { $sum: 1 } } }]),
    ]);
    const n = new Map(counts.filter((c) => c._id).map((c) => [c._id.toHexString(), c.n]));
    return leagues.map((l) => ({ ...this.view(l), tournaments: n.get(l._id.toHexString()) ?? 0 }));
  }

  /** GET /leagues/:id — la liga y sus torneos (más recientes primero). */
  async findOne(id: string) {
    const league = await this.leagues.findById(id).lean();
    if (!league) throw new NotFoundException('Liga no encontrada');
    const tournaments = await this.tournaments.find({ leagueId: league._id }).select(TOURNAMENT_FIELDS).sort({ startDate: -1 }).lean();
    return { ...this.view(league), tournaments: tournaments.map((t) => ({ ...tournamentRef(t), system: t.settings?.system ?? 'LEAGUE' })) };
  }

  /**
   * GET /leagues/:id/history — histórico de la liga con partidos oficiales FINALIZADOS de todos sus
   * torneos. Incluye campeones, tabla histórica, récords y estadísticas de jugadores.
   */
  async history(id: string) {
    const league = await this.leagues.findById(id).lean();
    if (!league) throw new NotFoundException('Liga no encontrada');
    const tournaments = await this.tournaments.find({ leagueId: league._id }).select(TOURNAMENT_FIELDS).sort({ startDate: 1 }).lean();
    const ids = tournaments.map((t) => t._id);

    const [matches, enrolled] = await Promise.all([
      this.matches.find({ tournamentId: { $in: ids }, status: MatchStatus.FINISHED, homeScore: { $ne: null }, awayScore: { $ne: null } })
        .select('tournamentId date time homeTeamId awayTeamId homeScore awayScore penalties stage').lean(),
      this.enrollments.find({ tournamentId: { $in: ids } }).select('tournamentId teamId').lean(),
    ]);
    const stats = await this.stats.find({ matchId: { $in: matches.map((m) => m._id) }, played: true }).select('matchId playerId teamId goals assists ownGoals yellowCards redCards').lean();
    const teamIds = [...new Set([...enrolled.map((e) => e.teamId.toHexString()), ...matches.flatMap((m) => [m.homeTeamId.toHexString(), m.awayTeamId.toHexString()])])];
    const [teamDocs, playerDocs] = await Promise.all([
      this.teams.find({ _id: { $in: teamIds.map(toObjectId) } }).select('name shortName logoUrl colors').lean(),
      this.players.find({ _id: { $in: [...new Set(stats.map((s) => s.playerId.toHexString()))].map(toObjectId) } }).lean(),
    ]);
    const teams = new Map<string, TeamRef>(teamDocs.map((t) => [t._id.toHexString(), teamRef(t)]));
    const players = new Map(playerDocs.map((p) => [p._id.toHexString(), publicPlayer(p)]));
    const matchById = new Map(matches.map((m) => [m._id.toHexString(), m]));

    // ─── Campeones (torneos finalizados con la competición completa) ────────────────
    const goalsBy = new Map<string, Map<string, number>>(); // torneo → jugador → goles
    for (const s of stats) {
      const tid = matchById.get(s.matchId.toHexString())!.tournamentId.toHexString();
      const g = goalsBy.get(tid) ?? new Map<string, number>();
      g.set(s.playerId.toHexString(), (g.get(s.playerId.toHexString()) ?? 0) + s.goals);
      goalsBy.set(tid, g);
    }
    const champions: {
      tournament: ReturnType<typeof tournamentRef>;
      year: number;
      champion: TeamRef | null;
      runnerUp: TeamRef | null;
      decidedBy: 'LEAGUE_TABLE' | 'FINAL';
      topScorer: { player: ReturnType<typeof publicPlayer>; goals: number } | null;
    }[] = [];
    for (const t of tournaments) {
      const tid = t._id.toHexString();
      if (t.status !== TournamentStatus.FINISHED) continue;
      const { input } = await this.competition.context(tid);
      const view = buildStructure(input);
      const ko = view.phases.find((p) => p.type === PhaseType.KNOCKOUT);
      const final = ko?.type === PhaseType.KNOCKOUT ? ko.rounds.at(-1)?.ties[0] : undefined;
      const loser = final?.winnerTeamId ? (final.winnerTeamId === final.homeTeamId ? final.awayTeamId : final.homeTeamId) : null;
      const top = [...(goalsBy.get(tid) ?? new Map()).entries()].filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1])[0];
      champions.push({
        tournament: tournamentRef(t),
        year: Number(t.startDate.slice(0, 4)),
        champion: view.championTeamId ? (teams.get(view.championTeamId) ?? null) : null,
        runnerUp: loser ? (teams.get(loser) ?? null) : null,
        decidedBy: ko ? 'FINAL' : 'LEAGUE_TABLE',
        topScorer: top && players.has(top[0]) ? { player: players.get(top[0])!, goals: top[1] } : null,
      });
    }
    champions.reverse(); // más reciente primero

    // ─── Tabla histórica de equipos (3/1/0, igual para todos los formatos) ───────────
    const table = new Map<string, { played: number; won: number; drawn: number; lost: number; goalsFor: number; goalsAgainst: number; cleanSheets: number; tournaments: Set<string> }>();
    const row = (id: string) => {
      const r = table.get(id) ?? { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, cleanSheets: 0, tournaments: new Set<string>() };
      table.set(id, r);
      return r;
    };
    for (const e of enrolled) row(e.teamId.toHexString()).tournaments.add(e.tournamentId.toHexString());
    let biggest: (typeof matches)[number] | null = null;
    let wildest: (typeof matches)[number] | null = null;
    for (const m of matches) {
      for (const [id, gf, ga] of [[m.homeTeamId.toHexString(), m.homeScore!, m.awayScore!], [m.awayTeamId.toHexString(), m.awayScore!, m.homeScore!]] as const) {
        const r = row(id);
        r.played++;
        r.goalsFor += gf;
        r.goalsAgainst += ga;
        if (ga === 0) r.cleanSheets++;
        if (gf > ga) r.won++;
        else if (gf < ga) r.lost++;
        else r.drawn++;
      }
      const diff = Math.abs(m.homeScore! - m.awayScore!);
      if (!biggest || diff > Math.abs(biggest.homeScore! - biggest.awayScore!)) biggest = m;
      if (!wildest || m.homeScore! + m.awayScore! > wildest.homeScore! + wildest.awayScore!) wildest = m;
    }
    const titles = new Map<string, number>();
    const finals = new Map<string, number>();
    for (const c of champions) {
      if (c.champion) titles.set(c.champion.id, (titles.get(c.champion.id) ?? 0) + 1);
      if (c.runnerUp) finals.set(c.runnerUp.id, (finals.get(c.runnerUp.id) ?? 0) + 1);
    }
    const teamTable = [...table.entries()]
      .filter(([id]) => teams.has(id))
      .map(([id, r]) => ({
        team: teams.get(id)!,
        played: r.played,
        won: r.won,
        drawn: r.drawn,
        lost: r.lost,
        goalsFor: r.goalsFor,
        goalsAgainst: r.goalsAgainst,
        goalDifference: r.goalsFor - r.goalsAgainst,
        points: r.won * 3 + r.drawn,
        cleanSheets: r.cleanSheets,
        tournaments: r.tournaments.size,
        titles: titles.get(id) ?? 0,
        runnerUps: finals.get(id) ?? 0,
      }))
      .sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor || a.team.name.localeCompare(b.team.name));

    // ─── Jugadores (todo lo registrado) ───────────────────────────────────────────
    const prow = new Map<string, { appearances: number; goals: number; assists: number; ownGoals: number; yellowCards: number; redCards: number; conceded: number; cleanSheets: number; teams: Set<string>; tournaments: Set<string>; last: string; team: string }>();
    for (const s of stats) {
      const pid = s.playerId.toHexString();
      if (!players.has(pid)) continue;
      const m = matchById.get(s.matchId.toHexString())!;
      const tid = s.teamId.toHexString();
      const against = m.homeTeamId.toHexString() === tid ? m.awayScore! : m.homeScore!;
      const r = prow.get(pid) ?? { appearances: 0, goals: 0, assists: 0, ownGoals: 0, yellowCards: 0, redCards: 0, conceded: 0, cleanSheets: 0, teams: new Set<string>(), tournaments: new Set<string>(), last: '', team: tid };
      r.appearances++;
      r.goals += s.goals;
      r.assists += s.assists;
      r.ownGoals += s.ownGoals ?? 0;
      r.yellowCards += s.yellowCards;
      r.redCards += s.redCards;
      r.conceded += against;
      if (against === 0) r.cleanSheets++;
      r.teams.add(tid);
      r.tournaments.add(m.tournamentId.toHexString());
      const when = `${m.date}${m.time}`;
      if (when >= r.last) {
        r.last = when;
        r.team = tid;
      }
      prow.set(pid, r);
    }
    const playerStats = [...prow.entries()]
      .map(([id, r]) => ({
        player: players.get(id)!,
        team: teams.get(r.team) ?? null,
        appearances: r.appearances,
        goals: r.goals,
        assists: r.assists,
        ownGoals: r.ownGoals,
        yellowCards: r.yellowCards,
        redCards: r.redCards,
        // Para porteros: goles que recibió su equipo en los partidos que jugó.
        conceded: r.conceded,
        cleanSheets: r.cleanSheets,
        teams: r.teams.size,
        tournaments: r.tournaments.size,
      }))
      .sort((a, b) => b.goals - a.goals || a.appearances - b.appearances || a.player.id.localeCompare(b.player.id));

    const matchRef = (m: (typeof matches)[number] | null) =>
      m && {
        id: m._id.toHexString(),
        date: m.date,
        tournament: (() => {
          const t = tournaments.find((x) => x._id.equals(m.tournamentId));
          return t ? { id: t._id.toHexString(), name: t.name } : null;
        })(),
        homeTeam: teams.get(m.homeTeamId.toHexString()) ?? null,
        awayTeam: teams.get(m.awayTeamId.toHexString()) ?? null,
        homeScore: m.homeScore!,
        awayScore: m.awayScore!,
      };
    const fullMatches = matches;
    const goals = fullMatches.reduce((n, m) => n + m.homeScore! + m.awayScore!, 0);
    return {
      leagueId: id,
      summary: {
        tournaments: tournaments.length,
        finished: tournaments.filter((t) => t.status === TournamentStatus.FINISHED).length,
        matches: fullMatches.length,
        goals,
        goalsPerMatch: fullMatches.length ? Math.round((goals / fullMatches.length) * 100) / 100 : null,
        teams: teamTable.length,
        players: playerStats.length,
        firstYear: tournaments.length ? Number(tournaments[0].startDate.slice(0, 4)) : null,
      },
      champions,
      teams: teamTable,
      players: playerStats,
      keepers: playerStats.filter((p) => p.player.position === PlayerPosition.GOALKEEPER),
      records: { biggestWin: matchRef(biggest), highestScoring: matchRef(wildest) },
    };
  }

  private view(l: { _id: Types.ObjectId; name: string; city?: string | null; description?: string | null; isDefault?: boolean; createdAt?: Date }) {
    const { organizerId: _o, ...rest } = serialize(l as unknown as Record<string, unknown>) as Record<string, unknown>;
    return { ...rest, city: l.city ?? null, description: l.description ?? null, isDefault: !!l.isDefault } as {
      id: string;
      name: string;
      city: string | null;
      description: string | null;
      isDefault: boolean;
      createdAt: string;
      updatedAt: string;
    };
  }
}
