import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Match } from './schemas/match.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { MatchStatus, TournamentStatus } from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { todayISODate } from '../../common/utils/dates.js';
import { durationOf, minutesOf, RESERVING } from '../venues/occupancy.js';
import { VenuesService } from '../venues/venues.service.js';
import { RefereesService } from '../referees/referees.service.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import { DisciplineService } from '../discipline/discipline.service.js';
import { CompetitionService } from '../competition/competition.service.js';
import { SchedulingService } from '../scheduling/scheduling.service.js';
import { rulesOf, timeZoneOf } from '../scheduling/scheduling-rules.js';
import type { Reason, RescheduleItem } from '../scheduling/auto-scheduler.js';
import { MatchesService } from './matches.service.js';
import type { RescheduleConfirmDto, RescheduleProposalDto, RescheduleSelectionDto } from './dto/reschedule.dto.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { TournamentPhase } from '../competition/types.js';

type LeanMatch = Match & { _id: Types.ObjectId; updatedAt: Date };
/** Cuántos partidos se pueden reprogramar de una vez (búsqueda acotada). */
export const MAX_RESCHEDULE = 200;
const version = (m: { updatedAt: Date }) => new Date(m.updatedAt).toISOString();

/**
 * 6C — reprogramación parcial. El organizador elige partidos (uno, una jornada, unas fechas, una
 * cancha o sede, o una lista) y recibe una propuesta que cambia lo menos posible: el resto del
 * calendario queda fijo. La vista previa no escribe; la confirmación vuelve a validarlo todo dentro
 * del cerrojo del torneo (versiones, permisos, restricciones de 6A, canchas con su cerrojo, árbitros,
 * elegibilidad de 3B, orden de la eliminatoria) y escribe todo o nada.
 */
@Injectable()
export class MatchRescheduleService {
  constructor(
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
    private readonly venues: VenuesService,
    private readonly referees: RefereesService,
    private readonly log: MatchLogService,
    private readonly discipline: DisciplineService,
    private readonly competition: CompetitionService,
    private readonly scheduling: SchedulingService,
    private readonly matchesService: MatchesService,
  ) {}

  // ─── Vista previa ───────────────────────────────────────────────────────────

  async proposal(id: string, dto: RescheduleProposalDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    if (dto.search?.fieldIds?.length) await this.ownership.tournament(id, user, Permission.ASSIGNMENTS);
    const tid = toObjectId(id);
    const { eligible, excluded, tournament } = await this.select(tid, dto.selection, null);
    const items = await this.items(tid, eligible, tournament, null);
    const view = await this.scheduling.proposeReschedule(null, tid, items, dto.search ?? {}, [...new Set(eligible.flatMap((m) => (m.fieldId ? [m.fieldId.toHexString()] : [])))]);

    // El orden de la eliminatoria también entre los elegidos (los límites solo veían a los demás).
    const final = new Map(eligible.map((m) => [m._id.toHexString(), { date: m.date, time: m.time }]));
    for (const p of view.placements) final.set(p.matchId, { date: p.date, time: p.time });
    const broken = await this.bracketViolations(tid, final, eligible.map((m) => m._id.toHexString()), null);
    const placements = view.placements.filter((p) => !broken.has(p.matchId));
    const unscheduled = [...view.unscheduled, ...[...broken].filter((mid) => view.placements.some((p) => p.matchId === mid)).map((matchId) => ({ matchId, reasons: [bracketReason()] }))];

    const byId = new Map(eligible.map((m) => [m._id.toHexString(), m]));
    const names = await this.names([...eligible, ...excluded.map((e) => e.match)]);
    const before = (m: LeanMatch) => ({ date: m.date, time: m.time, fieldId: m.fieldId?.toHexString() ?? null, venue: m.venue ?? null, status: m.status, pendingSchedule: !!m.pendingSchedule });
    const base = (m: LeanMatch) => ({ matchId: m._id.toHexString(), version: version(m), round: m.round, homeTeamId: m.homeTeamId.toHexString(), awayTeamId: m.awayTeamId.toHexString(), stage: m.stage ?? null, before: before(m) });
    const items_ = [
      ...placements.map((p) => ({ ...base(byId.get(p.matchId)!), action: p.changed ? ('MOVE' as const) : ('KEEP' as const), after: { date: p.date, time: p.time, fieldId: p.fieldId, field: p.field }, warnings: p.warnings, reasons: [] as Reason[] })),
      ...unscheduled.map((u) => ({ ...base(byId.get(u.matchId)!), action: 'PENDING' as const, after: null, warnings: [], reasons: u.reasons })),
    ].sort((a, b) => a.before.date.localeCompare(b.before.date) || a.before.time.localeCompare(b.before.time) || a.matchId.localeCompare(b.matchId));
    return {
      items: items_,
      excluded: excluded.map((e) => ({ matchId: e.match._id.toHexString(), round: e.match.round, homeTeamId: e.match.homeTeamId.toHexString(), awayTeamId: e.match.awayTeamId.toHexString(), date: e.match.date, time: e.match.time, reason: e.reason })),
      summary: {
        selected: eligible.length,
        move: items_.filter((i) => i.action === 'MOVE').length,
        keep: items_.filter((i) => i.action === 'KEEP').length,
        pending: items_.filter((i) => i.action === 'PENDING').length,
        excluded: excluded.length,
      },
      metrics: { ...view.metrics, unplaced: unscheduled.length },
      search: view.search,
      fields: view.fields,
      teams: Object.fromEntries(names),
      reasonRequired: tournament.status === TournamentStatus.ACTIVE,
    };
  }

  // ─── Confirmación ───────────────────────────────────────────────────────────

  async confirm(id: string, dto: RescheduleConfirmDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    const tid = toObjectId(id);
    const ids = dto.items.map((i) => i.matchId);
    if (new Set(ids).size !== ids.length) throw new BadRequestException('Un partido aparece dos veces');
    return this.ownership.inTournament(tid, { user, permission: Permission.SCHEDULE }, async (session, status) => {
      const tournament = (await this.tournaments.findById(tid).select('+scheduling phases status information.schedule.durationMinutes').session(session).lean())!;
      const found = await this.matches.find({ _id: { $in: ids.map(toObjectId) }, tournamentId: tid }).session(session).lean<LeanMatch[]>();
      if (found.length !== ids.length) throw new NotFoundException('Algún partido no existe en este torneo');
      const byId = new Map(found.map((m) => [m._id.toHexString(), m]));
      // Versiones: si algo cambió desde la vista previa, se vuelve a proponer.
      const stale = dto.items.filter((i) => version(byId.get(i.matchId)!) !== new Date(i.version).toISOString());
      if (stale.length) {
        throw new ConflictException({ statusCode: 409, error: 'PROPOSAL_STALE', message: `${stale.length === 1 ? 'Un partido cambió' : `${stale.length} partidos cambiaron`} desde la propuesta: genera una nueva`, matchIds: stale.map((i) => i.matchId) });
      }
      const phases = tournament.phases ?? [];
      for (const i of dto.items) {
        const why = this.notReschedulable(byId.get(i.matchId)!, phases, i.action);
        if (why) throw new ConflictException({ statusCode: 409, error: 'MATCH_NOT_RESCHEDULABLE', message: why, matchId: i.matchId });
      }
      const moves = dto.items.filter((i) => i.action === 'MOVE');
      const pendings = dto.items.filter((i) => i.action === 'PENDING');
      if (pendings.length !== (dto.allowPending ?? 0)) {
        throw new ConflictException({ statusCode: 409, error: 'PENDING_NOT_CONFIRMED', message: pendings.length ? `Quedarían ${pendings.length} partidos por programar: confírmalo (allowPending: ${pendings.length})` : 'No queda ningún partido por programar', pending: pendings.length });
      }
      for (const m of moves) if (!m.date || !m.time) throw new BadRequestException('Cada partido que se mueve necesita fecha y hora');
      const changes = [...moves, ...pendings.filter((p) => byId.get(p.matchId)!.status === MatchStatus.SCHEDULED)];
      const reason = dto.reason?.trim() || null;
      if (status === TournamentStatus.ACTIVE && changes.length && !reason) throw new BadRequestException('Indica el motivo de la reprogramación');
      const target = (i: (typeof moves)[number]) => (i.fieldId === undefined ? (byId.get(i.matchId)!.fieldId?.toHexString() ?? null) : i.fieldId);
      if (moves.some((i) => (target(i) ?? '') !== (byId.get(i.matchId)!.fieldId?.toHexString() ?? ''))) await this.access.require(tid, user.id, Permission.ASSIGNMENTS, session);

      // Orden de la eliminatoria con todo en su lugar final.
      const final = new Map(found.map((m) => [m._id.toHexString(), { date: m.date, time: m.time }]));
      for (const i of moves) final.set(i.matchId, { date: i.date!, time: i.time! });
      const broken = await this.bracketViolations(tid, final, ids, session, durationOf(tournament));
      if (broken.size) throw new ConflictException({ statusCode: 409, error: 'BRACKET_ORDER', message: 'En la eliminatoria un partido debe jugarse después de los que lo definen y antes de los que dependen de él', matchIds: [...broken] });

      // 6A con los movidos juntos (el contexto excluye a los propios).
      const warnings = await this.scheduling.enforce(
        session,
        tid,
        moves.map((i) => {
          const m = byId.get(i.matchId)!;
          return { key: i.matchId, matchId: i.matchId, homeTeamId: m.homeTeamId.toHexString(), awayTeamId: m.awayTeamId.toHexString(), date: i.date!, time: i.time!, fieldId: target(i), round: m.round };
        }),
      );
      // 3B: las participaciones registradas no pueden quedar irregulares.
      const incidentsBefore = new Map<string, Set<string>>();
      for (const i of moves) {
        const m = byId.get(i.matchId)!;
        if (i.date === m.date) continue;
        const before = await this.matchesService.assertPlacementKeepsEligibility(m, { date: i.date!, round: m.round }, session);
        if (before) incidentsBefore.set(i.matchId, before);
      }

      // Escritura en dos pasos: primero todos los horarios (sin cancha), después cada cancha y sus
      // árbitros con el estado final; así un intercambio entre dos partidos no choca consigo mismo.
      for (const i of moves) {
        await this.matches.updateOne({ _id: toObjectId(i.matchId) }, { $set: { date: i.date, time: i.time, status: MatchStatus.SCHEDULED, pendingSchedule: false, fieldId: null, venueId: null } }, { session, runValidators: true });
      }
      for (const i of moves) {
        const m = byId.get(i.matchId)!;
        const fieldId = target(i);
        const field = await this.venues.assign(session, { matchId: m._id, tournamentId: tid, date: i.date!, time: i.time!, status: MatchStatus.SCHEDULED, fieldId: fieldId ? toObjectId(fieldId) : null, changed: (fieldId ?? '') !== (m.fieldId?.toHexString() ?? '') });
        warnings.push(...field.warnings);
        const venue = field.fieldId ? field.venue : m.fieldId ? null : (m.venue ?? null);
        await this.matches.updateOne({ _id: m._id }, { $set: { fieldId: field.fieldId, venueId: field.venueId, venue } }, { session });
      }
      for (const i of moves) {
        const m = byId.get(i.matchId)!;
        const now = (await this.matches.findById(m._id).select('venueId').session(session).lean())!;
        await this.referees.revalidateMatch(session, { _id: m._id, referees: m.referees ?? [], tournamentId: tid, venueId: now.venueId ?? null, date: i.date!, time: i.time!, status: MatchStatus.SCHEDULED });
      }
      for (const p of pendings) {
        const m = byId.get(p.matchId)!;
        if (m.status !== MatchStatus.SCHEDULED) continue;
        // Tenía horario: queda pospuesto (recuerda de dónde venía), no «sin programar».
        await this.matches.updateOne({ _id: m._id }, { $set: { status: MatchStatus.POSTPONED, postponedFrom: { date: m.date, time: m.time } } }, { session });
      }

      const after = await this.matches.find({ _id: { $in: changes.map((c) => toObjectId(c.matchId)) } }).session(session).lean<LeanMatch[]>();
      for (const a of after) {
        const before = byId.get(a._id.toHexString())!;
        const incidents = incidentsBefore.get(a._id.toHexString());
        if (incidents) await this.discipline.checkMove(before, incidents, session, user);
        await this.log.edited(session, { userId: user.id }, before, a, reason);
      }
      return {
        moved: moves.filter((i) => {
          const m = byId.get(i.matchId)!;
          return m.status !== MatchStatus.SCHEDULED || m.date !== i.date || m.time !== i.time || (m.fieldId?.toHexString() ?? null) !== (target(i) ?? null);
        }).length,
        kept: dto.items.length - changes.length,
        pending: pendings.length,
        matches: serialize(after),
        warnings: [...new Set(warnings)],
      };
    });
  }

  // ─── Interno ────────────────────────────────────────────────────────────────

  /** Partidos elegidos: los que se pueden reprogramar y los que no (con el motivo). */
  private async select(tid: Types.ObjectId, sel: RescheduleSelectionDto, session: ClientSession | null) {
    const tournament = await this.tournaments.findById(tid).select('+scheduling status phases information.schedule.durationMinutes').session(session).lean();
    if (!tournament) throw new NotFoundException('Torneo no encontrado');
    const filters: Record<string, unknown>[] = [];
    if (sel.matchIds?.length) filters.push({ _id: { $in: sel.matchIds.map(toObjectId) } });
    if (sel.round !== undefined) filters.push({ round: sel.round });
    if (sel.fieldId) filters.push({ fieldId: toObjectId(sel.fieldId) });
    if (sel.venueId) filters.push({ venueId: toObjectId(sel.venueId) });
    if (sel.pending) filters.push({ pendingSchedule: true });
    const byPlace = !!(sel.fieldId || sel.venueId);
    const from = sel.from ?? (byPlace ? todayISODate(new Date(), timeZoneOf(rulesOf(tournament))) : undefined);
    if (from || sel.to) filters.push({ date: { ...(from ? { $gte: from } : {}), ...(sel.to ? { $lte: sel.to } : {}) } });
    if (!filters.length) throw new BadRequestException('Elige qué partidos reprogramar: partidos, jornada, fechas, cancha o sede');
    // Los por programar no tienen fecha real: un filtro de fechas no los alcanza.
    const query = { tournamentId: tid, $and: filters, ...(from || sel.to ? { pendingSchedule: { $ne: true } } : {}) };
    const found = await this.matches.find(query).sort({ date: 1, time: 1, _id: 1 }).limit(MAX_RESCHEDULE * 3).session(session).lean<LeanMatch[]>();
    if (sel.matchIds?.length && found.length !== sel.matchIds.length && !sel.round && !from && !sel.to && !byPlace) throw new NotFoundException('Algún partido no existe en este torneo');
    const phases = tournament.phases ?? [];
    const eligible: LeanMatch[] = [];
    const excluded: { match: LeanMatch; reason: string }[] = [];
    for (const m of found) {
      const why = this.notReschedulable(m, phases, 'MOVE');
      if (why) excluded.push({ match: m, reason: why });
      else eligible.push(m);
    }
    if (eligible.length > MAX_RESCHEDULE) throw new BadRequestException(`Son ${eligible.length} partidos: reprograma como máximo ${MAX_RESCHEDULE} a la vez`);
    return { eligible, excluded, tournament };
  }

  /** null = se puede reprogramar; si no, por qué (lo jugado y la historia no se tocan). */
  private notReschedulable(m: LeanMatch, phases: TournamentPhase[], action: 'KEEP' | 'MOVE' | 'PENDING'): string | null {
    if (m.status === MatchStatus.FINISHED || m.homeScore !== null || m.awayScore !== null) return 'Ya tiene resultado';
    if (m.status === MatchStatus.LIVE) return 'Está en juego';
    if (m.status === MatchStatus.SUSPENDED) return 'Está suspendido: primero decide qué pasa con él';
    if (m.status === MatchStatus.CANCELLED) return 'Está cancelado';
    if (m.sheetClosed) return 'Su ficha técnica está cerrada';
    if (action === 'KEEP') return null;
    try {
      this.competition.assertStageWrite(phases, m.stage, { resultOrStatus: m.status !== MatchStatus.SCHEDULED });
    } catch (e) {
      return (e as Error).message;
    }
    return null;
  }

  /** Partidos elegidos como entrada de la búsqueda, con los límites de su eliminatoria. */
  private async items(tid: Types.ObjectId, eligible: LeanMatch[], tournament: { information?: { schedule?: { durationMinutes?: number | null } } }, session: ClientSession | null): Promise<RescheduleItem[]> {
    const duration = durationOf(tournament);
    const selected = new Set(eligible.map((m) => m._id.toHexString()));
    const staged = eligible.some((m) => m.stage?.tie) ? await this.bracketMatches(tid, session) : [];
    return eligible.map((m) => {
      let notBefore: number | null = null;
      let notAfter: number | null = null;
      const tie = m.stage?.tie;
      if (tie) {
        for (const o of staged) {
          if (selected.has(o._id.toHexString()) || o.stage!.phase !== m.stage!.phase) continue;
          const start = minutesOf(o.date, o.time);
          if (feeds(o.stage!.tie!, tie)) notBefore = Math.max(notBefore ?? -Infinity, start + duration);
          if (feeds(tie, o.stage!.tie!)) notAfter = Math.min(notAfter ?? Infinity, start);
        }
      }
      return {
        key: m._id.toHexString(),
        matchId: m._id.toHexString(),
        round: m.round,
        homeTeamId: m.homeTeamId.toHexString(),
        awayTeamId: m.awayTeamId.toHexString(),
        origin: m.pendingSchedule ? null : { date: m.date, time: m.time, fieldId: m.fieldId?.toHexString() ?? null },
        keepable: m.status === MatchStatus.SCHEDULED,
        notBefore,
        notAfter,
      };
    });
  }

  /**
   * Partidos de llaves que reservan horario (los pendientes no ordenan nada), más los que esta
   * operación mueve aunque hoy no reserven (un pospuesto o por programar que se va a programar).
   */
  private bracketMatches(tid: Types.ObjectId, session: ClientSession | null, include: string[] = []) {
    return this.matches
      .find({ tournamentId: tid, 'stage.tie': { $ne: null }, $or: [{ status: { $in: RESERVING } }, { _id: { $in: include.map(toObjectId) } }] })
      .select('date time stage status')
      .session(session)
      .lean<LeanMatch[]>();
  }

  /** Partidos de eliminatoria que, en su lugar final, quedarían antes de los que los definen. */
  private async bracketViolations(tid: Types.ObjectId, final: Map<string, { date: string; time: string }>, involved: string[], session: ClientSession | null, duration?: number) {
    const minutes = duration ?? durationOf(await this.tournaments.findById(tid).select('information.schedule.durationMinutes').session(session).lean());
    const all = await this.bracketMatches(tid, session, [...final.keys()].filter((id) => involved.includes(id)));
    const pos = (m: LeanMatch) => final.get(m._id.toHexString()) ?? { date: m.date, time: m.time };
    const placed = all.filter((m) => final.has(m._id.toHexString()) || !involved.includes(m._id.toHexString()));
    const out = new Set<string>();
    for (const a of placed) {
      for (const b of placed) {
        if (a === b || a.stage!.phase !== b.stage!.phase || !feeds(a.stage!.tie!, b.stage!.tie!)) continue;
        // a define a b: b empieza después de que termine a.
        if (minutesOf(pos(b).date, pos(b).time) < minutesOf(pos(a).date, pos(a).time) + minutes) {
          for (const m of [a, b]) if (involved.includes(m._id.toHexString())) out.add(m._id.toHexString());
        }
      }
    }
    // Solo cuentan los que la operación mueve (lo que ya estaba mal antes no se le atribuye).
    return new Set([...out].filter((mid) => {
      const m = all.find((x) => x._id.toHexString() === mid)!;
      const p = final.get(mid);
      return p && (p.date !== m.date || p.time !== m.time);
    }));
  }

  private async names(ms: LeanMatch[]) {
    const ids = [...new Set(ms.flatMap((m) => [m.homeTeamId.toHexString(), m.awayTeamId.toHexString()]))];
    const rows = await this.teams.find({ _id: { $in: ids.map(toObjectId) } }).select('name').lean();
    return new Map(rows.map((t) => [t._id.toHexString(), t.name]));
  }
}

/** ¿La llave `a` se juega antes que `b`? Rondas anteriores, o la ida de la misma llave. */
function feeds(a: { round: number; slot: number; leg: number }, b: { round: number; slot: number; leg: number }) {
  return a.round < b.round || (a.round === b.round && a.slot === b.slot && a.leg < b.leg);
}

const bracketReason = (): Reason => ({ code: 'BRACKET_ORDER', count: 0, message: 'En la eliminatoria debe jugarse después de los partidos que lo definen y antes de los que dependen de él', teamId: null, fieldId: null });

