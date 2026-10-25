import { withTeamName, withPlayerName } from '../../common/history/identity.js';
import { TournamentIdentityService } from '../../common/history/tournament-identity.service.js';
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Readable } from 'node:stream';
import { MatchStatus, PhaseType, SanctionStatus, TournamentStatus } from '../../common/enums/index.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { can, Permission } from '../../common/authorization/permissions.js';
import { appTimeZone, todayISODate } from '../../common/utils/dates.js';
import { toObjectId } from '../../common/utils/serialize.js';
import { CompetitionService } from '../competition/competition.service.js';
import { buildStructure, type StructureView } from '../competition/structure.js';
import { DisciplineService } from '../discipline/discipline.service.js';
import { FinanceService } from '../finance/finance.service.js';
import { entriesFilter, ENTRY_ORDER } from '../finance/finance-queries.js';
import { FinanceEntry } from '../finance/schemas/finance-entry.schema.js';
import { League } from '../leagues/schemas/league.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { PlayerBlock } from '../players/schemas/player-block.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { Round } from '../rounds/schemas/round.schema.js';
import { byKickoff, pointsRuleOf, sumTotals } from '../statistics/calculations.js';
import { Team } from '../teams/schemas/team.schema.js';
import { DEFAULT_SETTINGS, Tournament } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { ReportQueryDto } from './dto/report.dto.js';
import {
  MATCH_STATUS_LABEL,
  disciplineSections,
  financeSections,
  matchesSection,
  playersSection,
  rosterSections,
  standingsSections,
  type MatchRowInput,
  type PlayerTotalsRow,
  type RosterPlayerRow,
} from './report-builders.js';
import { humanDate, initialsOf, rowCount, slug, stampDate, STATUS_LABEL, type ReportDoc, type ReportFormat, type ReportId, type ReportSection } from './report-model.js';
import { renderCsv } from './render/csv.js';
import { renderPdf } from './render/pdf.js';
import { renderXlsx } from './render/xlsx.js';
import { fetchLogo } from './render/logo.js';
import { runnerUpOf } from '../tournaments/closure.js';

type Filter = 'phase' | 'group' | 'round' | 'teamId' | 'from' | 'to' | 'status' | 'includeInactive';

interface ReportDef {
  title: string;
  description: string;
  /** Permiso que exige (además de acceso al torneo). */
  permission: Permission;
  filters: Filter[];
  /** Datos personales o financieros: la exportación se registra en la bitácora de auditoría. */
  sensitive: boolean;
  orientation: 'portrait' | 'landscape';
}

/**
 * Catálogo. Los reportes deportivos piden VIEW (el panel del torneo); los que tienen datos
 * personales, disciplinarios o financieros piden el permiso de ese módulo: tener lectura del
 * torneo NO basta para exportar plantillas, disciplina ni finanzas.
 */
export const REPORTS: Record<ReportId, ReportDef> = {
  standings: {
    title: 'Tabla de posiciones',
    description: 'Posiciones, partidos, goles y puntos por fase o grupo.',
    permission: Permission.VIEW,
    filters: ['phase', 'group'],
    sensitive: false,
    orientation: 'portrait',
  },
  matches: {
    title: 'Resultados y calendario',
    description: 'Todos los partidos con fecha, marcador, estado, cancha y árbitro.',
    permission: Permission.VIEW,
    filters: ['round', 'teamId', 'from', 'to', 'status'],
    sensitive: false,
    orientation: 'landscape',
  },
  players: {
    title: 'Goleadores y estadísticas',
    description: 'Goles, asistencias y tarjetas por jugador en partidos finalizados.',
    permission: Permission.VIEW,
    filters: ['teamId'],
    sensitive: false,
    orientation: 'landscape',
  },
  rosters: {
    title: 'Plantillas y jugadores',
    description: 'Equipos inscritos, jugadores, dorsales y estado de inscripción.',
    permission: Permission.TEAMS,
    filters: ['teamId', 'includeInactive'],
    sensitive: true,
    orientation: 'landscape',
  },
  discipline: {
    title: 'Disciplina y sanciones',
    description: 'Tarjetas, expulsiones y sanciones con su cumplimiento.',
    permission: Permission.DISCIPLINE_VIEW,
    filters: ['teamId'],
    sensitive: true,
    orientation: 'landscape',
  },
  finance: {
    title: 'Finanzas',
    description: 'Saldos por equipo, cargos, pagos y movimientos (solo administración).',
    permission: Permission.FINANCE_VIEW,
    filters: ['teamId', 'from', 'to'],
    sensitive: true,
    orientation: 'landscape',
  },
  summary: {
    title: 'Resumen del torneo',
    description: 'Datos generales, equipos, partidos, tabla y goleadores.',
    permission: Permission.VIEW,
    filters: [],
    sensitive: false,
    orientation: 'portrait',
  },
};

/**
 * Tope de filas de una exportación. 8C: era 50,000; con el heap de un contenedor de 512 MiB, seis
 * exportaciones de 45,000 filas a la vez tiraban el proceso. Un torneo real tiene decenas o cientos
 * de filas: 20,000 sigue sobrando y cabe con margen (ver docs/reports-8.md § Rendimiento).
 */
export const REPORT_MAX_ROWS = 20_000;
/** El PDF se arma en memoria para numerar páginas: más filas, mejor Excel o CSV. */
export const PDF_MAX_ROWS = 4_000;
/** Generaciones simultáneas: por usuario y en total (en memoria, por instancia). */
const MAX_PER_USER = 2;
const MAX_TOTAL = 3;

const MIME: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

export interface ReportFile {
  filename: string;
  contentType: string;
  /** PDF en flujo; Excel y CSV ya armados. */
  body: Readable | Buffer;
}

/**
 * Módulo 8A — centro de reportes. Cada exportación se genera bajo demanda y se entrega al cliente:
 * nada se guarda (ni en Mongo ni en disco ni en la nube). Los datos salen de los servicios de cada
 * módulo (estructura de competición, disciplina, finanzas…), así un reporte dice lo mismo que la
 * pantalla correspondiente.
 */
@Injectable()
export class ReportsService {
  private readonly audit = new Logger('ReportsAudit');
  private readonly running = new Map<string, number>();
  private runningTotal = 0;

  constructor(
    @InjectModel(Tournament.name)
    private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name)
    private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name)
    private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamMembership.name)
    private readonly memberships: Model<TeamMembership>,
    @InjectModel(PlayerBlock.name) private readonly blocks: Model<PlayerBlock>,
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    @InjectModel(League.name) private readonly leagues: Model<League>,
    @InjectModel(FinanceEntry.name)
    private readonly entries: Model<FinanceEntry>,
    private readonly access: TournamentAccessService,
    private readonly competition: CompetitionService,
    private readonly discipline: DisciplineService,
    private readonly finance: FinanceService,
    private readonly identity: TournamentIdentityService,
  ) {}

  /** Catálogo con lo que este usuario puede exportar en el torneo. */
  async catalog(tournamentId: string, user: AuthUser) {
    const { tournament, role } = await this.access.require(tournamentId, user.id, Permission.VIEW);
    return {
      tournamentId,
      status: tournament.status,
      formats: ['pdf', 'xlsx', 'csv'],
      reports: (Object.entries(REPORTS) as [ReportId, ReportDef][]).map(([id, r]) => ({
        id,
        title: r.title,
        description: r.description,
        filters: r.filters,
        allowed: can(role, r.permission),
        sensitive: r.sensitive,
      })),
    };
  }

  /** Genera el archivo. 403 sin el permiso del reporte; 400 con filtros que no aplican o volumen excesivo. */
  async generate(tournamentId: string, reportId: string, query: ReportQueryDto, user: AuthUser): Promise<ReportFile> {
    // Solo claves propias: «constructor» o «toString» no son reportes (8C).
    const def = Object.hasOwn(REPORTS, reportId) ? REPORTS[reportId as ReportId] : undefined;
    if (!def) throw new NotFoundException('Reporte desconocido');
    const id = reportId as ReportId;
    const format = query.format ?? 'pdf';
    const extra = (Object.keys(query) as (keyof ReportQueryDto)[]).filter((k) => k !== 'format' && query[k] !== undefined && !def.filters.includes(k as Filter));
    if (extra.length) throw new BadRequestException(`El reporte «${def.title}» no admite: ${extra.join(', ')}`);
    if (query.from && query.to && query.from > query.to) throw new BadRequestException('El periodo es inválido: «desde» es posterior a «hasta»');

    const { tournament, role } = await this.access.require(tournamentId, user.id, def.permission);
    this.acquire(user.id);
    try {
      const doc = await this.build(id, tournament, query, user, format === 'pdf' ? PDF_MAX_ROWS : REPORT_MAX_ROWS);
      const rows = rowCount(doc);
      if (rows > REPORT_MAX_ROWS) throw new BadRequestException(`El reporte tiene ${rows} filas (máximo ${REPORT_MAX_ROWS}); aplica filtros`);
      if (format === 'pdf' && rows > PDF_MAX_ROWS)
        throw new BadRequestException(`El reporte tiene ${rows} filas: para un PDF el máximo es ${PDF_MAX_ROWS}. Descárgalo en Excel o CSV, o aplica filtros`);
      const timeZone = appTimeZone();
      const filename = `${doc.fileBase}.${format}`;
      // Bitácora de auditoría (log estructurado): quién exportó qué y con qué filtros. Sin archivos.
      this.audit.log(
        JSON.stringify({
          event: 'report.export',
          at: new Date().toISOString(),
          report: id,
          format,
          sensitive: def.sensitive,
          tournamentId,
          userId: user.id,
          role,
          rows,
          filters: doc.filters,
        }),
      );
      if (format === 'pdf')
        return {
          filename,
          contentType: MIME.pdf,
          body: renderPdf(doc, timeZone),
        };
      return {
        filename,
        contentType: MIME[format],
        body: format === 'xlsx' ? renderXlsx(doc, timeZone) : renderCsv(doc),
      };
    } finally {
      this.release(user.id);
    }
  }

  // ─── Límite de generaciones simultáneas ──────────────────────────────────

  private acquire(userId: string) {
    const mine = this.running.get(userId) ?? 0;
    if (mine >= MAX_PER_USER || this.runningTotal >= MAX_TOTAL) throw new HttpException('Hay otros reportes generándose; intenta de nuevo en unos segundos', HttpStatus.TOO_MANY_REQUESTS);
    this.running.set(userId, mine + 1);
    this.runningTotal++;
  }

  private release(userId: string) {
    const mine = (this.running.get(userId) ?? 1) - 1;
    if (mine > 0) this.running.set(userId, mine);
    else this.running.delete(userId);
    this.runningTotal = Math.max(0, this.runningTotal - 1);
  }

  // ─── Construcción ─────────────────────────────────────────────────────────

  /** `max`: tope de filas del formato pedido; las fuentes grandes se cuentan ANTES de cargarse (8C). */
  private async build(id: ReportId, t: Tournament & { _id: Types.ObjectId }, q: ReportQueryDto, user: AuthUser, max: number): Promise<ReportDoc> {
    const tid = t._id;
    const [liveLeague, logo, hist] = await Promise.all([this.leagueName(t.leagueId), fetchLogo(t.logoUrl), this.identity.names(tid)]);
    // 10C: liga con su nombre al cerrar (la liga por defecto sigue sin mostrarse) y aviso de qué nombres se usan.
    const league = liveLeague && hist?.leagueName ? hist.leagueName : liveLeague;
    const namesNote =
      t.status !== TournamentStatus.FINISHED
        ? null
        : hist
          ? `Nombres de equipos y jugadores tal como se jugó (conservados al finalizar el ${humanDate(hist.takenAt.toISOString().slice(0, 10))})`
          : 'Nombres actuales: el torneo se finalizó antes de que Kisokar conservara los nombres históricos';
    const teamName = q.teamId ? await this.teamName(tid, q.teamId) : null;
    const filters = [
      q.phase !== undefined ? `Fase ${q.phase + 1}` : null,
      q.group ? `Grupo ${q.group}` : null,
      q.round ? `Jornada ${q.round}` : null,
      teamName ? `Equipo: ${teamName}` : null,
      q.from || q.to ? `Periodo: ${q.from ? humanDate(q.from) : 'inicio'} – ${q.to ? humanDate(q.to) : 'hoy'}` : null,
      q.status?.length ? `Estados: ${q.status.map((x) => (x === 'PENDING_SCHEDULE' ? 'Por programar' : (MATCH_STATUS_LABEL[x] ?? x))).join(', ')}` : null,
      q.includeInactive ? 'Incluye bajas' : null,
    ].filter((x): x is string => !!x);

    let sections: ReportSection[];
    let currency: string | null = null;
    switch (id) {
      case 'standings':
        sections = await this.standings(tid, q);
        break;
      case 'matches':
        sections = [await this.matchList(tid, q, max)];
        break;
      case 'players':
        sections = [playersSection(await this.playerTotals(tid, q.teamId))];
        break;
      case 'rosters':
        sections = await this.rosters(tid, q, max);
        break;
      case 'discipline':
        sections = await this.disciplineReport(String(tid), q, user);
        break;
      case 'finance': {
        const f = await this.financeReport(String(tid), q, user, max);
        sections = f.sections;
        currency = f.currency;
        break;
      }
      case 'summary':
        sections = await this.summary(t);
        break;
    }
    const def = REPORTS[id];
    const generatedAt = new Date();
    return {
      id,
      title: def.title,
      tournament: {
        name: t.name,
        league,
        status: t.status,
        statusLabel: STATUS_LABEL[t.status] ?? t.status,
        dates: datesOf(t.startDate, t.endDate),
      },
      generatedAt,
      filters,
      namesNote,
      logo,
      logoInitials: initialsOf(t.name),
      orientation: def.orientation,
      currency,
      sections,
      fileBase: `${slug(def.title, 30)}-${slug(t.name, 50)}-${stampDate(generatedAt, appTimeZone())}`,
    };
  }

  private async leagueName(leagueId: Types.ObjectId | null | undefined) {
    if (!leagueId) return null;
    const l = await this.leagues.findById(leagueId).select('name isDefault').lean();
    // La liga por defecto la crea el sistema: su nombre no es de una liga real.
    return l && !l.isDefault ? l.name : null;
  }

  /**
   * 8C: el equipo del filtro debe participar en ESTE torneo (inscrito, o con partidos, inscripciones
   * de jugadores o movimientos en él, p. ej. uno ya quitado): un id de otro torneo es 400 y nunca
   * pone el nombre de un equipo ajeno en el archivo.
   */
  private async teamName(tid: Types.ObjectId, teamId: string) {
    const id = toObjectId(teamId);
    const [enrolled, played, members, money] = await Promise.all([
      this.enrollments.exists({ tournamentId: tid, teamId: id }),
      this.matches.exists({
        tournamentId: tid,
        $or: [{ homeTeamId: id }, { awayTeamId: id }],
      }),
      this.memberships.exists({ tournamentId: tid, teamId: id }),
      this.entries.exists({ tournamentId: tid, teamId: id }),
    ]);
    const team = enrolled || played || members || money ? await this.teams.findById(id).select('name').lean() : null;
    if (!team) throw new BadRequestException('El equipo no participa en este torneo');
    return withTeamName({ name: team.name }, teamId, await this.identity.names(tid)).name;
  }

  /** Nombres de equipo; en un torneo finalizado con foto, los nombres con que se jugó (10C). */
  private async names(ids: Iterable<string>, tid: Types.ObjectId) {
    const list = [...new Set(ids)];
    const [rows, hist] = await Promise.all([
      this.teams
        .find({ _id: { $in: list.map(toObjectId) } })
        .select('name')
        .lean(),
      this.identity.names(tid),
    ]);
    const map = new Map(rows.map((r) => [r._id.toHexString(), withTeamName({ name: r.name }, r._id.toHexString(), hist).name]));
    return (id: string) => map.get(id) ?? 'Equipo';
  }

  // 1. Tabla de posiciones: la estructura que calcula el servidor para el panel (tablas, grupos, cuadro).
  private async structure(tid: Types.ObjectId) {
    const ctx = await this.competition.context(tid);
    const view = buildStructure(ctx.input);
    const nameOf = (id: string) => ctx.teamMap.get(id)?.name ?? 'Equipo';
    const points = pointsRuleOf({
      ...DEFAULT_SETTINGS,
      ...ctx.tournament.settings,
    });
    return {
      ctx,
      view,
      nameOf,
      points,
      withdrawn: ctx.input.withdrawnTeamIds ?? [],
    };
  }

  private async standings(tid: Types.ObjectId, q: ReportQueryDto) {
    const { view, nameOf, points, withdrawn } = await this.structure(tid);
    if (q.phase !== undefined && !view.phases.some((p) => p.index === q.phase)) throw new BadRequestException(`El torneo no tiene la fase ${q.phase + 1}`);
    if (q.group && !view.phases.some((p) => p.type === PhaseType.GROUPS && p.groups.some((g) => g.key === q.group))) throw new BadRequestException(`El torneo no tiene el grupo ${q.group}`);
    const sections = standingsSections(view, nameOf, withdrawn, points, {
      phase: q.phase,
      group: q.group,
    });
    return sections.length
      ? sections
      : [
          {
            kind: 'table' as const,
            title: 'Tabla de posiciones',
            columns: [{ label: 'Equipo', type: 'text' as const }],
            rows: [],
            empty: 'Este torneo todavía no tiene tablas de posiciones.',
          },
        ];
  }

  // 2. Resultados y calendario.
  private async matchList(tid: Types.ObjectId, q: ReportQueryDto, max: number) {
    const filter: Record<string, unknown> = { tournamentId: tid };
    if (q.round) filter.round = q.round;
    if (q.teamId) filter.$or = [{ homeTeamId: toObjectId(q.teamId) }, { awayTeamId: toObjectId(q.teamId) }];
    // Periodo: solo partidos con fecha vigente (la de un pospuesto es referencia, no su fecha).
    if (q.from || q.to)
      Object.assign(filter, {
        status: { $ne: MatchStatus.POSTPONED },
        date: {
          ...(q.from ? { $gte: q.from } : {}),
          ...(q.to ? { $lte: q.to } : {}),
        },
      });
    if (q.status?.length) {
      const or = q.status.map((s) =>
        s === 'PENDING_SCHEDULE'
          ? { status: MatchStatus.POSTPONED, pendingSchedule: true }
          : s === MatchStatus.POSTPONED
            ? { status: MatchStatus.POSTPONED, pendingSchedule: { $ne: true } }
            : { status: s },
      );
      filter.$and = [...((filter.$and as unknown[]) ?? []), { $or: or }];
    }
    tooMany(await this.matches.countDocuments(filter), max, 'partidos');
    const [list, rounds, { view }] = await Promise.all([
      this.matches
        .find(filter)
        .select('round date time status pendingSchedule postponedFrom homeTeamId awayTeamId homeScore awayScore penalties extraTime stage venue centralReferee')
        .sort({ round: 1, date: 1, time: 1, _id: 1 })
        .lean(),
      this.rounds.find({ tournamentId: tid }).select('number name').lean(),
      this.structure(tid),
    ]);
    const nameOf = await this.names(list.flatMap((m) => [m.homeTeamId.toHexString(), m.awayTeamId.toHexString()]), tid);
    const roundName = new Map(rounds.map((r) => [r.number, r.name]));
    const rows: MatchRowInput[] = list.map((m) => ({
      round: m.round,
      roundLabel: roundName.get(m.round)?.trim() || `Jornada ${m.round}`,
      date: m.date,
      time: m.time,
      status: m.status,
      pendingSchedule: !!m.pendingSchedule,
      postponedFrom: m.postponedFrom ?? null,
      home: nameOf(m.homeTeamId.toHexString()),
      away: nameOf(m.awayTeamId.toHexString()),
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      penalties: m.penalties ?? null,
      extraTime: !!m.extraTime,
      stage: stageLabel(m.stage ?? null, view),
      venue: m.venue?.trim() || null,
      referee: m.centralReferee?.trim() || null,
    }));
    return matchesSection(rows);
  }

  // 3. Goleadores y estadísticas: mismas reglas que la tabla de goleo (FINISHED y played).
  private async playerTotals(tid: Types.ObjectId, teamId?: string): Promise<PlayerTotalsRow[]> {
    const finished = await this.matches.find({ tournamentId: tid, status: MatchStatus.FINISHED }).select('date time').lean();
    const kickoff = new Map(finished.map((m) => [m._id.toHexString(), { date: m.date, time: m.time }]));
    const stats = await this.stats.find({ matchId: { $in: finished.map((m) => m._id) }, played: true }).lean();
    const byPlayer = new Map<string, typeof stats>();
    for (const s of stats) byPlayer.set(s.playerId.toHexString(), [...(byPlayer.get(s.playerId.toHexString()) ?? []), s]);
    const latestTeam = (list: typeof stats) => [...list].sort((a, b) => byKickoff(kickoff.get(b.matchId.toHexString())!, kickoff.get(a.matchId.toHexString())!))[0].teamId.toHexString();
    let entries = [...byPlayer.entries()].map(([playerId, list]) => ({
      playerId,
      teamId: latestTeam(list),
      list,
    }));
    if (teamId) entries = entries.filter((e) => e.teamId === teamId);
    const [players, nameOf, hist] = await Promise.all([
      this.players
        .find({ _id: { $in: entries.map((e) => toObjectId(e.playerId)) } })
        .select('firstName lastName')
        .lean(),
      this.names(entries.map((e) => e.teamId), tid),
      this.identity.names(tid),
    ]);
    const playerName = new Map(players.map((p) => ((n) => [p._id.toHexString(), `${n.firstName} ${n.lastName}`.trim()] as const)(withPlayerName(p, p._id.toHexString(), hist))));
    return entries.map((e) => {
      const totals = sumTotals(
        e.list.map((s) => ({
          ...s,
          playerId: s.playerId.toHexString(),
          teamId: s.teamId.toHexString(),
          matchId: s.matchId.toHexString(),
        })),
      );
      return {
        player: playerName.get(e.playerId) ?? 'Jugador',
        team: nameOf(e.teamId),
        played: totals.matchesPlayed,
        goals: totals.goals,
        assists: totals.assists,
        ownGoals: e.list.reduce((n, s) => n + (s.ownGoals ?? 0), 0),
        yellows: totals.yellowCards,
        reds: totals.redCards,
      };
    });
  }

  // 4. Plantillas: inscripciones del torneo (sin fecha de nacimiento, contacto ni fotos).
  private async rosters(tid: Types.ObjectId, q: ReportQueryDto, max: number) {
    const teamFilter = q.teamId ? { teamId: toObjectId(q.teamId) } : {};
    const [enrolled, members, blocks] = await Promise.all([
      this.enrollments
        .find({ tournamentId: tid, ...teamFilter })
        .select('teamId withdrawnAt')
        .lean(),
      this.memberships
        .find({
          tournamentId: tid,
          ...teamFilter,
          ...(q.includeInactive ? {} : { active: true }),
        })
        .select('playerId teamId jerseyNumber startDate registeredAt endDate endReason active')
        .lean(),
      this.blocks.find({ tournamentId: tid, liftedAt: null }).select('playerId since until').lean(),
    ]);
    tooMany(members.length, max, 'inscripciones');
    const today = todayISODate();
    const blockOf = new Map(blocks.filter((b) => b.until === null || b.until > today).map((b) => [b.playerId.toHexString(), { since: b.since, until: b.until }]));
    const [players, nameOf, hist] = await Promise.all([
      this.players
        .find({ _id: { $in: members.map((m) => m.playerId) } })
        .select('firstName lastName position')
        .lean(),
      this.names([...enrolled.map((e) => e.teamId.toHexString()), ...members.map((m) => m.teamId.toHexString())], tid),
      this.identity.names(tid),
    ]);
    const player = new Map(players.map((p) => [p._id.toHexString(), withPlayerName(p, p._id.toHexString(), hist)]));
    const counts = (teamId: string, active: boolean) => members.filter((m) => m.teamId.toHexString() === teamId && m.active === active).length;
    const teams = enrolled
      .map((e) => ({
        team: nameOf(e.teamId.toHexString()),
        status: (e.withdrawnAt ? 'WITHDRAWN' : 'ENROLLED') as 'ENROLLED' | 'WITHDRAWN',
        active: counts(e.teamId.toHexString(), true),
        inactive: q.includeInactive ? counts(e.teamId.toHexString(), false) : 0,
      }))
      .sort((a, b) => a.team.localeCompare(b.team, 'es'));
    const rows: RosterPlayerRow[] = members
      .map((m) => {
        const p = player.get(m.playerId.toHexString());
        return {
          team: nameOf(m.teamId.toHexString()),
          jersey: m.jerseyNumber ?? null,
          player: p ? `${p.firstName} ${p.lastName}`.trim() : 'Jugador',
          position: p?.position ?? '',
          registeredAt: m.registeredAt ?? null,
          eligibleFrom: m.startDate,
          active: m.active,
          endDate: m.endDate ?? null,
          endReason: m.endReason ?? null,
          blocked: m.active ? (blockOf.get(m.playerId.toHexString()) ?? null) : null,
        };
      })
      .sort((a, b) => a.team.localeCompare(b.team, 'es') || Number(b.active) - Number(a.active) || (a.jersey ?? 999) - (b.jersey ?? 999) || a.player.localeCompare(b.player, 'es'));
    return rosterSections(teams, rows);
  }

  // 5. Disciplina: exactamente lo que calcula el módulo de disciplina (con su permiso).
  private async disciplineReport(tid: string, q: ReportQueryDto, user: AuthUser) {
    const o = await this.discipline.overview(tid, user);
    const player = (id: string) => {
      const p = o.refs.players[id];
      return p ? `${p.firstName} ${p.lastName}`.trim() : 'Jugador';
    };
    const team = (id: string) => o.refs.teams[id]?.name ?? 'Equipo';
    const origin = (matchId: string) => {
      const m = o.refs.matches[matchId];
      return m ? `J${m.round} · ${team(m.homeTeamId)} vs ${team(m.awayTeamId)}${m.date ? ` (${humanDate(m.date)})` : ''}` : '';
    };
    const ORDER: Record<string, number> = {
      [SanctionStatus.ACTIVE]: 0,
      [SanctionStatus.PENDING]: 1,
      [SanctionStatus.SERVED]: 2,
      [SanctionStatus.ANNULLED]: 3,
    };
    const sanctions = o.sanctions
      .filter((s) => !q.teamId || s.teamId === q.teamId)
      .map((s) => ({
        player: player(s.playerId),
        team: team(s.teamId),
        kind: s.kind,
        cause: s.cause,
        origin: origin(s.matchId),
        matches: s.matches,
        served: s.served,
        remaining: s.remaining,
        status: s.status,
        reason: s.reason,
        adjusted: s.adjusted,
      }))
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.team.localeCompare(b.team, 'es') || a.player.localeCompare(b.player, 'es'));
    const cards = o.players
      .filter((p) => (!q.teamId || p.teamId === q.teamId) && p.yellows + p.secondYellows + p.directReds + p.unclassified > 0)
      .map((p) => ({
        player: player(p.playerId),
        team: team(p.teamId),
        yellows: p.yellows,
        secondYellows: p.secondYellows,
        directReds: p.directReds,
        unclassified: p.unclassified,
        towardNext: p.towardNext,
        suspended: p.suspended,
      }))
      .sort((a, b) => a.team.localeCompare(b.team, 'es') || a.player.localeCompare(b.player, 'es'));
    return disciplineSections(sanctions, cards);
  }

  // 6. Finanzas: saldos de FinanceService.accounts (la misma agregación que la pantalla) y movimientos.
  private async financeReport(tid: string, q: ReportQueryDto, user: AuthUser, max: number) {
    const data = await this.finance.accounts(tid, user);
    const filter = entriesFilter(toObjectId(tid), {
      teamId: q.teamId,
      from: q.from,
      to: q.to,
    });
    tooMany(await this.entries.countDocuments(filter), max, 'movimientos');
    // Solo lo que se exporta (sin notas internas ni autores: menos memoria y nada sensible de más).
    const list = await this.entries.find(filter).select('date teamId kind category concept method reference amount voidedAt voidReason').sort(ENTRY_ORDER).lean();
    const nameOf = new Map(data.accounts.map((a) => [a.teamId, a.teamName ?? 'Equipo']));
    const accounts = q.teamId ? data.accounts.filter((a) => a.teamId === q.teamId) : data.accounts;
    const sum = (k: 'charged' | 'paid' | 'discounted' | 'refunded' | 'balance' | 'due' | 'credit') => accounts.reduce((n, a) => n + a[k], 0);
    const totals = q.teamId
      ? {
          charged: sum('charged'),
          paid: sum('paid'),
          discounted: sum('discounted'),
          refunded: sum('refunded'),
          balance: sum('balance'),
          due: sum('due'),
          credit: sum('credit'),
        }
      : data.totals;
    const sections = financeSections(
      {
        accounts,
        totals,
        // Con un equipo, los desgloses del torneo no aplican (serían de todos los equipos).
        byCategory: q.teamId ? [] : data.byCategory,
        byMethod: q.teamId ? [] : data.byMethod,
        entries: list.map((e) => ({
          date: e.date,
          team: nameOf.get(e.teamId.toHexString()) ?? 'Equipo',
          kind: e.kind,
          category: e.category ?? null,
          concept: e.concept,
          method: e.method ?? null,
          reference: e.reference ?? null,
          amount: e.amount,
          voided: !!e.voidedAt,
          voidReason: e.voidReason ?? null,
        })),
      },
      data.currency,
    );
    return {
      sections: q.teamId ? sections.filter((s) => s.title !== 'Cargos por concepto' && s.title !== 'Pagos y devoluciones por método') : sections,
      currency: data.currency,
    };
  }

  // 7. Resumen del torneo.
  private async summary(t: Tournament & { _id: Types.ObjectId }) {
    const tid = t._id;
    const [{ view, nameOf, points, withdrawn, ctx }, players, matches] = await Promise.all([
      this.structure(tid),
      this.playerTotals(tid),
      this.matches.find({ tournamentId: tid }).select('status pendingSchedule homeScore awayScore').lean(),
    ]);
    const finished = matches.filter((m) => m.status === MatchStatus.FINISHED && m.homeScore !== null && m.awayScore !== null);
    const goals = finished.reduce((n, m) => n + (m.homeScore ?? 0) + (m.awayScore ?? 0), 0);
    const count = (s: MatchStatus, pending?: boolean) => matches.filter((m) => m.status === s && (pending === undefined || !!m.pendingSchedule === pending)).length;
    const s = { ...DEFAULT_SETTINGS, ...t.settings };
    const official = t.status === TournamentStatus.FINISHED;
    const champion = official && view.championTeamId ? nameOf(view.championTeamId) : null;
    const runnerUp = official ? runnerUpOf(view) : null;
    const general: [string, string][] = [
      ['Torneo', t.name],
      ['Estado', `${STATUS_LABEL[t.status] ?? t.status}${t.status === TournamentStatus.ACTIVE ? ' (datos parciales)' : ''}`],
      ['Fechas', datesOf(t.startDate, t.endDate)],
      ['Categoría', t.category || '—'],
      ['Modalidad', String(t.format ?? '').replace('FOOTBALL_', 'Fútbol ') || '—'],
      ['Sistema', SYSTEM_LABEL[s.system] ?? s.system],
      ['Equipos', `${ctx.input.teamIds.length}${withdrawn.length ? ` (${withdrawn.length} retirados)` : ''}`],
      ...(official ? ([['Campeón', champion ?? 'No determinado por la estructura del torneo'], ...(runnerUp ? [['Subcampeón', nameOf(runnerUp)]] : [])] as [string, string][]) : []),
    ];
    const totals: [string, string][] = [
      ['Partidos programados', String(matches.length)],
      ['Finalizados', String(finished.length)],
      ['Por jugar', String(count(MatchStatus.SCHEDULED) + count(MatchStatus.LIVE))],
      ['Pospuestos', String(count(MatchStatus.POSTPONED, false))],
      ['Por programar', String(count(MatchStatus.POSTPONED, true))],
      ['Suspendidos', String(count(MatchStatus.SUSPENDED))],
      ['Cancelados', String(count(MatchStatus.CANCELLED))],
      ['Goles', String(goals)],
      ['Promedio de goles por partido', finished.length ? (goals / finished.length).toFixed(2) : '—'],
      ['Jugadores con participación', String(players.length)],
    ];
    const scorers = playersSection(
      players.filter((p) => p.goals > 0),
      'Goleadores',
    );
    scorers.rows = scorers.rows.slice(0, 10);
    scorers.note = 'Los 10 primeros. Solo partidos finalizados.';
    const teamsSection: ReportSection = {
      kind: 'table',
      title: 'Equipos participantes',
      columns: [
        { label: 'Equipo', type: 'text', weight: 4 },
        { label: 'Estado', type: 'text', weight: 1.4 },
      ],
      rows: [...ctx.input.teamIds].map((id) => [nameOf(id), withdrawn.includes(id) ? 'Retirado' : 'Inscrito'] as [string, string]).sort((a, b) => a[0].localeCompare(b[0], 'es')),
      empty: 'No hay equipos inscritos.',
    };
    return [
      { kind: 'kv' as const, title: 'Datos generales', items: general },
      { kind: 'kv' as const, title: 'Partidos y goles', items: totals },
      teamsSection,
      ...standingsSections(view, nameOf, withdrawn, points, {}),
      scorers,
    ];
  }
}

/**
 * Conteo previo de una fuente grande contra el tope del formato: un PDF de 45,000 movimientos se
 * rechaza sin cargarlos (antes se cargaban y luego se rechazaba: ~1 s y +170 MB, ver docs/reports-8.md).
 */
function tooMany(total: number, max: number, what: string) {
  if (total <= max) return;
  if (max === PDF_MAX_ROWS) throw new BadRequestException(`El reporte tiene ${total} ${what}: para un PDF el máximo es ${PDF_MAX_ROWS}. Descárgalo en Excel o CSV, o aplica filtros`);
  throw new BadRequestException(`El reporte tiene ${total} ${what} (máximo ${REPORT_MAX_ROWS}); aplica filtros`);
}

const SYSTEM_LABEL: Record<string, string> = {
  LEAGUE: 'Liga',
  KNOCKOUT: 'Eliminación directa',
  GROUPS_KNOCKOUT: 'Grupos y eliminatoria',
  LEAGUE_PLAYOFFS: 'Liga y liguilla',
};

function datesOf(start: string | null | undefined, end: string | null | undefined): string {
  if (start && end) return `${humanDate(start)} – ${humanDate(end)}`;
  return start ? `Desde ${humanDate(start)}` : '';
}

/** «Grupo A», el nombre de la ronda de eliminatoria («Semifinal») o null (liga). */
function stageLabel(
  stage: {
    phase: number;
    group: string | null;
    tie: { round: number; leg: number } | null;
  } | null,
  view: StructureView,
): string | null {
  if (!stage) return null;
  if (stage.group) return `Grupo ${stage.group}`;
  if (stage.tie) {
    const p = view.phases.find((x) => x.index === stage.phase);
    const name = p?.type === PhaseType.KNOCKOUT ? p.rounds.find((r) => r.round === stage.tie!.round)?.name : null;
    return `${name ?? 'Eliminatoria'}${stage.tie.leg > 1 ? ' (vuelta)' : ''}`;
  }
  return view.phases.length > 1 && stage.phase === 0 ? 'Fase regular' : null;
}

