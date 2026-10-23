import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Match } from '../matches/schemas/match.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Venue } from '../venues/schemas/venue.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { MatchLogAction, MatchStatus } from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { sameId, toObjectId } from '../../common/utils/serialize.js';
import { todayISODate } from '../../common/utils/dates.js';
import { addDays, clockOf, DEFAULT_MATCH_MINUTES, durationOf, RESERVING } from '../venues/occupancy.js';
import { VenuesService, venueLabel } from '../venues/venues.service.js';
import { RefereesService } from '../referees/referees.service.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import {
  assertTeamRules,
  assertTournamentRules,
  DEFAULT_TEAM_RULES,
  evaluate,
  hasTeamRules,
  rulesOf,
  teamRulesOf,
  timeZoneOf,
  type Booked,
  type Evaluation,
  type EvaluationContext,
  type Proposal,
  type TeamRules,
  type TournamentRules,
  type Violation,
  toMinutes,
} from './scheduling-rules.js';
import { autoSchedule, rescheduleSearch, type AutoMetrics, type CandidateField, type Fixture, type Reason, type RescheduleItem, type RescheduleMetrics } from './auto-scheduler.js';
import type { SchedulingCheckDto, SchedulingPreviewDto, TeamSchedulingDto, UpdateTournamentSchedulingDto } from './dto/scheduling.dto.js';

type LeanTournament = Tournament & { _id: Types.ObjectId };
/** El descanso máximo (336 h) más un día: lo que puede influir en un partido. */
const WINDOW_DAYS = 15;
const RULE_KEYS = ['timeZone', 'days', 'startTime', 'endTime', 'fieldGapMinutes', 'maxMatchesPerDay', 'maxSimultaneous', 'fieldAvailability', 'softRules'] as const;

export interface EnforceOptions {
  /** Partidos del torneo que no cuentan (el que se mueve; todos si el calendario se reemplaza). */
  exclude?: Types.ObjectId[];
  replaceAll?: boolean;
}

/** 6B: qué buscar y dónde (periodo, horario, canchas). Lo omitido sale de las restricciones del torneo. */
export interface ProposeInput {
  fixtures: Fixture[];
  from: string;
  to?: string | null;
  days?: number[];
  firstKickoff?: string | null;
  lastKickoff?: string | null;
  step?: number | null;
  daysBetweenRounds: number;
  fieldIds?: string[];
  parallel?: number | null;
  preferredTime?: string;
  replaceAll?: boolean;
  exclude?: Types.ObjectId[];
}

export interface ProposalView {
  matches: { key: string; round: number; homeTeamId: string; awayTeamId: string; date: string; time: string; fieldId: string | null; field: string | null; warnings: Violation[] }[];
  unscheduled: { key: string; round: number; homeTeamId: string; awayTeamId: string; reasons: Reason[] }[];
  metrics: AutoMetrics;
  search: { from: string; to: string; days: number[]; firstKickoff: string; lastKickoff: string; step: number; parallel: number | null; fieldIds: string[] };
  teams: Record<string, string>;
}

/** 6C: dónde buscar al reprogramar. `fieldIds` omitido = las canchas que ya usan los partidos elegidos. */
export interface RescheduleSearchInput {
  from?: string | null;
  to?: string | null;
  days?: number[];
  firstKickoff?: string | null;
  lastKickoff?: string | null;
  step?: number | null;
  fieldIds?: string[];
  keepValid?: boolean;
  avoidDates?: string[];
  avoidFieldIds?: string[];
}

export interface RescheduleView {
  placements: { matchId: string; date: string; time: string; fieldId: string | null; field: string | null; changed: boolean; warnings: Violation[] }[];
  unscheduled: { matchId: string; reasons: Reason[] }[];
  metrics: RescheduleMetrics;
  search: { from: string; to: string; days: number[]; firstKickoff: string; lastKickoff: string; step: number; fieldIds: string[]; keepValid: boolean; avoidDates: string[]; avoidFieldIds: string[] };
  fields: Record<string, string>;
}

/** Periodo máximo de búsqueda (días). */
export const MAX_PERIOD_DAYS = 366;

export interface ProposalIssues {
  key: string;
  matchId: string | null;
  round: number | null;
  date: string;
  time: string;
  homeTeamId: string;
  awayTeamId: string;
  errors: Violation[];
  warnings: Violation[];
}

/**
 * 6A — restricciones de calendario. Un solo evaluador (`scheduling-rules.ts`) para la programación
 * manual, la generación automática, los cruces de eliminatoria y la revisión de lo ya programado.
 * `enforce` corre dentro de la transacción (y el cerrojo) de quien escribe los partidos: dos
 * escrituras del mismo torneo no pueden saltarse un límite viéndose a medias.
 */
@Injectable()
export class SchedulingService {
  constructor(
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Venue.name) private readonly venues: Model<Venue>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly ownership: OwnershipService,
    private readonly venuesService: VenuesService,
    private readonly referees: RefereesService,
    private readonly log: MatchLogService,
  ) {}

  // ─── Consulta y configuración ───────────────────────────────────────────────

  /** Configuración actual, restricciones por equipo y conflictos de lo ya programado. */
  async view(id: string, user: AuthUser) {
    await this.ownership.ownedTournament(id, user, Permission.VIEW);
    return this.build(toObjectId(id), null);
  }

  async updateTournament(id: string, dto: UpdateTournamentSchedulingDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    const tid = toObjectId(id);
    return this.ownership.inTournament(tid, { user, permission: Permission.SCHEDULE }, async (session) => {
      const t = await this.tournament(tid, session);
      const before = rulesOf(t);
      const { next, duration } = this.merge(t, dto);
      await this.assertAll(tid, next, duration, session);
      const currentDuration = durationOf(t);
      if (duration !== currentDuration) {
        // Otra duración cambia lo que ocupan sus partidos con cancha y sus árbitros (como en Configuración).
        await this.venuesService.revalidateTournament(session, tid, duration);
        await this.referees.revalidate(session, { tournamentId: tid }, { tournamentId: tid, minutes: duration });
      }
      await this.tournaments.updateOne(
        { _id: tid },
        {
          $set: {
            scheduling: { ...next, updatedAt: new Date(), updatedBy: toObjectId(user.id) },
            ...(dto.durationMinutes !== undefined ? { 'information.schedule.durationMinutes': dto.durationMinutes } : {}),
          },
        },
        { session, runValidators: true },
      );
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of RULE_KEYS) if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changes[k] = { from: before[k], to: next[k] };
      if (duration !== currentDuration) changes.durationMinutes = { from: currentDuration, to: duration };
      if (Object.keys(changes).length) await this.log.tournamentEntry(session, { userId: user.id }, tid, MatchLogAction.SCHEDULING_RULES_UPDATED, changes);
      return this.build(tid, session);
    });
  }

  async updateTeam(id: string, teamId: string, dto: TeamSchedulingDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    const tid = toObjectId(id);
    return this.ownership.inTournament(tid, { user, permission: Permission.SCHEDULE }, async (session) => {
      const t = await this.tournament(tid, session);
      const enrollment = await this.enrollments.findOne({ tournamentId: tid, teamId: toObjectId(teamId) }).select('+scheduling').session(session).lean();
      if (!enrollment) throw new NotFoundException('El equipo no está inscrito en este torneo');
      const name = (await this.teams.findById(teamId).select('name').session(session).lean())?.name ?? 'El equipo';
      const next = normalizeTeam(dto);
      assertTeamRules(next, rulesOf(t), name);
      const stored = hasTeamRules(next) || next.notes ? next : null;
      const before = enrollment.scheduling ? teamRulesOf(enrollment) : null;
      await this.enrollments.updateOne({ _id: enrollment._id }, { $set: { scheduling: stored } }, { session, runValidators: true });
      if (JSON.stringify(before) !== JSON.stringify(stored)) {
        await this.log.tournamentEntry(session, { userId: user.id }, tid, MatchLogAction.SCHEDULING_RULES_UPDATED, {
          teamId: { from: teamId, to: teamId },
          teamRules: { from: before, to: stored },
        });
      }
      return this.build(tid, session);
    });
  }

  /** Conflictos que tendría lo ya programado con otra configuración (no guarda nada). */
  async preview(id: string, dto: SchedulingPreviewDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    const tid = toObjectId(id);
    const t = await this.tournament(tid, null);
    const { next, duration } = this.merge(t, dto.tournament ?? {});
    let team: { teamId: string; rules: TeamRules } | null = null;
    if (dto.team) {
      if (!(await this.enrollments.exists({ tournamentId: tid, teamId: toObjectId(dto.team.teamId) }))) throw new NotFoundException('El equipo no está inscrito en este torneo');
      team = { teamId: dto.team.teamId, rules: normalizeTeam(dto.team.rules) };
    }
    const teamRules = await this.teamRules(tid, null);
    if (team) teamRules.set(team.teamId, team.rules);
    await this.assertAll(tid, next, duration, null, teamRules);
    return { conflicts: await this.existingConflicts(tid, null, { rules: next, duration, teamRules }) };
  }

  /** Revisar un partido propuesto, para el formulario (el servidor revalida al guardar). */
  async check(id: string, dto: SchedulingCheckDto, user: AuthUser) {
    const t = await this.ownership.tournament(id, user, Permission.SCHEDULE);
    const tid = toObjectId(id);
    let exclude: Types.ObjectId[] = [];
    if (dto.matchId) {
      // Solo partidos de ESTE torneo (un id ajeno no revela nada).
      const m = await this.matches.findOne({ _id: toObjectId(dto.matchId), tournamentId: tid }).select('_id').lean();
      if (!m) throw new NotFoundException('Partido no encontrado en este torneo');
      exclude = [m._id];
    }
    if (dto.fieldId) {
      const venue = await this.venues.findOne({ 'fields._id': toObjectId(dto.fieldId) }).select('organizerId').lean();
      if (!venue || !sameId(venue.organizerId, t.organizerId)) throw new NotFoundException('Cancha no encontrada');
    }
    const [issues] = await this.evaluateAll(null, tid, [{ key: 'check', matchId: dto.matchId ?? null, homeTeamId: dto.homeTeamId, awayTeamId: dto.awayTeamId, date: dto.date, time: dto.time, fieldId: dto.fieldId ?? null }], { exclude });
    return { valid: issues.errors.length === 0, errors: issues.errors, warnings: issues.warnings };
  }

  // ─── Aplicación (dentro de la transacción de quien escribe) ────────────────

  /** Evalúa sin bloquear (vistas previas del generador). */
  async evaluateAll(session: ClientSession | null, tournamentId: Types.ObjectId | string, proposals: Proposal[], opts: EnforceOptions = {}): Promise<ProposalIssues[]> {
    if (!proposals.length) return [];
    const tid = toObjectId(String(tournamentId));
    const ctx = await this.context(session, tid, proposals, opts);
    const result = evaluate(proposals, ctx);
    return proposals.map((p) => issuesOf(p, result.get(p.key)!));
  }

  /**
   * Restricciones obligatorias: 409 SCHEDULE_CONSTRAINTS con cada partido y lo que incumple. Devuelve
   * los avisos (preferencias) para la respuesta.
   */
  async enforce(session: ClientSession, tournamentId: Types.ObjectId | string, proposals: Proposal[], opts: EnforceOptions = {}): Promise<string[]> {
    const issues = await this.evaluateAll(session, tournamentId, proposals, opts);
    const failing = issues.filter((i) => i.errors.length);
    if (failing.length) {
      const names = await this.names(failing.flatMap((i) => [i.homeTeamId, i.awayTeamId]), session);
      const total = failing.reduce((n, i) => n + i.errors.length, 0);
      const first = failing[0];
      const where = proposals.length > 1 ? `${names.get(first.homeTeamId) ?? 'Local'} vs ${names.get(first.awayTeamId) ?? 'Visitante'} (${first.date} ${first.time}): ` : '';
      throw new ConflictException({
        statusCode: 409,
        error: 'SCHEDULE_CONSTRAINTS',
        message:
          (proposals.length > 1 ? `${failing.length} de ${proposals.length} partidos incumplen restricciones obligatorias del calendario. ` : 'La programación incumple restricciones obligatorias del calendario. ') +
          `${where}${first.errors[0].message}${total > 1 ? ` (y ${total - 1} más)` : ''}`,
        matches: failing,
        teams: Object.fromEntries(names),
      });
    }
    // La disponibilidad de la cancha en modo aviso ya la informa la asignación de la cancha.
    return [...new Set(issues.flatMap((i) => i.warnings.filter((w) => w.code !== 'FIELD_UNAVAILABLE').map((w) => w.message)))];
  }

  // ─── 6B: generación inteligente ─────────────────────────────────────────────

  /**
   * Busca fecha, hora y (si se piden) cancha para cada partido, sin escribir nada. Lo que no cabe
   * vuelve en `unscheduled` con sus motivos; nunca se relaja una restricción obligatoria.
   */
  async propose(session: ClientSession | null, tournamentId: Types.ObjectId | string, input: ProposeInput): Promise<ProposalView> {
    const tid = toObjectId(String(tournamentId));
    const t = await this.tournament(tid, session);
    const rules = rulesOf(t);
    const duration = durationOf(t);
    const search = this.searchOf(rules, duration, input);
    const fields = await this.candidateFields(input.fieldIds ?? [], t.organizerId, session);
    if (!input.fixtures.length) return { matches: [], unscheduled: [], metrics: emptyMetrics(), search: { ...search, fieldIds: fields.map((f) => f.id) }, teams: {} };

    const fieldIds = fields.map((f) => toObjectId(f.id));
    const exclude = input.exclude ?? [];
    const ctx = await this.loadContext(session, tid, {
      from: search.from,
      to: search.to,
      fieldIds,
      teamIds: input.fixtures.flatMap((f) => [f.homeTeamId, f.awayTeamId]),
      exclude,
      replaceAll: input.replaceAll,
    });
    // Ocupación de las canchas con su duración real (el margen de la sede se aplica al buscar).
    const fieldBookings = [
      ...ctx.otherFieldMatches,
      ...ctx.tournamentMatches.filter((b) => b.fieldId && fields.some((f) => f.id === b.fieldId)),
    ];
    const result = autoSchedule(input.fixtures, ctx, {
      ...search,
      parallel: search.parallel ?? Infinity,
      fields,
      fieldBookings,
      preferredTime: input.preferredTime,
    });
    const labels = new Map(fields.map((f) => [f.id, f.label]));
    return {
      matches: result.placements.map((p) => ({ ...p, field: p.fieldId ? (labels.get(p.fieldId) ?? null) : null })),
      unscheduled: result.unplaced,
      metrics: result.metrics,
      search: { ...search, fieldIds: fields.map((f) => f.id) },
      teams: Object.fromEntries(ctx.teamNames),
    };
  }

  /**
   * Confirmación: asigna la cancha de cada partido recién creado con la validación de siempre
   * (cerrojo de la sede, FIELD_CONFLICT con cualquier torneo). Dentro de la transacción de quien
   * crea los partidos: si una falla, no se guarda ninguno.
   */
  async assignFields(session: ClientSession, tournamentId: Types.ObjectId, docs: { _id: Types.ObjectId; date: string; time: string; fieldId: Types.ObjectId | null }[]) {
    const warnings: string[] = [];
    for (const d of docs) {
      if (!d.fieldId) continue;
      const field = await this.venuesService.assign(session, { matchId: d._id, tournamentId, date: d.date, time: d.time, status: MatchStatus.SCHEDULED, fieldId: d.fieldId, changed: true });
      await this.matches.updateOne({ _id: d._id }, { $set: { fieldId: field.fieldId, venueId: field.venueId, venue: field.venue } }, { session });
      warnings.push(...field.warnings);
    }
    return [...new Set(warnings)];
  }

  /**
   * Partido que el sistema crea solo (siguiente ronda de una eliminatoria): conserva su horario
   * previsto si cumple; si no, busca otro desde `floor` durante `spanDays`. null = no hay horario
   * válido (quien llama lo deja pendiente de programar, sin inventar uno).
   */
  async placeAutomatic(
    session: ClientSession,
    tournamentId: Types.ObjectId,
    m: { key: string; round: number; homeTeamId: string; awayTeamId: string; date: string; time: string },
    opts: { floor: string; spanDays: number; step: number; daysBetweenRounds: number },
  ): Promise<{ date: string; time: string } | { reasons: Reason[] }> {
    if (m.date >= opts.floor) {
      const [issues] = await this.evaluateAll(session, tournamentId, [{ ...m, matchId: null, fieldId: null }]);
      if (!issues.errors.length) return { date: m.date, time: m.time };
    }
    const from = m.date > opts.floor ? m.date : opts.floor;
    const t = await this.tournament(tournamentId, session);
    const rules = rulesOf(t);
    const duration = durationOf(t);
    const start = rules.startTime && !rules.softRules.includes('HOURS') ? rules.startTime : earlier(m.time, '08:00');
    // La grilla de inicios pasa por la hora prevista (si cabe, se conserva la hora).
    const offset = (((toMinutes(m.time) - toMinutes(start)) % opts.step) + opts.step) % opts.step;
    const first = clockOf(toMinutes(start) + offset);
    const last = rules.endTime && !rules.softRules.includes('HOURS') ? clockOf(toMinutes(rules.endTime) - duration) : later(m.time, '22:00');
    const view = await this.propose(session, tournamentId, {
      fixtures: [{ key: m.key, round: m.round, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId }],
      from,
      to: addDays(from, opts.spanDays - 1),
      firstKickoff: first > last ? last : first,
      lastKickoff: last,
      step: opts.step,
      // Ventana = las rondas de la fase; después, día por día hasta `spanDays`.
      daysBetweenRounds: opts.daysBetweenRounds,
      preferredTime: m.time,
    });
    const placed = view.matches[0];
    return placed ? { date: placed.date, time: placed.time } : { reasons: view.unscheduled[0]?.reasons ?? [] };
  }

  /**
   * 6C: horario para los partidos elegidos, con el resto del calendario fijo (contexto). No escribe.
   * Por defecto busca desde hoy (zona del torneo) durante 6 semanas, en las canchas que ya usan.
   */
  async proposeReschedule(session: ClientSession | null, tournamentId: Types.ObjectId, items: RescheduleItem[], input: RescheduleSearchInput, originFieldIds: string[]): Promise<RescheduleView> {
    const t = await this.tournament(tournamentId, session);
    const rules = rulesOf(t);
    const duration = durationOf(t);
    const today = todayISODate(new Date(), timeZoneOf(rules));
    const from = input.from ?? today;
    const base = this.searchOf(rules, duration, { fixtures: [], from, to: input.to ?? addDays(from, 41), days: input.days, firstKickoff: input.firstKickoff ?? null, lastKickoff: input.lastKickoff ?? null, step: input.step ?? null, daysBetweenRounds: 7 });
    // Pedidas: deben ser del propietario y estar activas. Por defecto, las que ya usan los partidos
    // (una desactivada no es candidata: sus partidos se mueven).
    const fields = input.fieldIds ? await this.candidateFields(input.fieldIds, t.organizerId, session) : await this.activeFields(originFieldIds, t.organizerId, session);
    const avoidFieldIds = input.avoidFieldIds ?? [];
    const keepValid = input.keepValid ?? true;
    const avoidDates = [...new Set(input.avoidDates ?? [])].sort();
    const search = { from: base.from, to: base.to, days: base.days, firstKickoff: base.firstKickoff, lastKickoff: base.lastKickoff, step: base.step, fieldIds: fields.map((f) => f.id), keepValid, avoidDates, avoidFieldIds };
    const labels = Object.fromEntries(fields.map((f) => [f.id, f.label]));
    if (!items.length) return { placements: [], unscheduled: [], metrics: { kept: 0, moved: 0, unplaced: 0, dateChanges: 0, timeChanges: 0, fieldChanges: 0, withWarnings: 0, cost: 0, evaluations: 0, attempts: 0, elapsedMs: 0, truncated: false }, search, fields: labels };
    const origins = items.flatMap((i) => (i.origin ? [i.origin.date] : []));
    const ctx = await this.loadContext(session, tournamentId, {
      from: [base.from, ...origins].sort()[0],
      to: [base.to, ...origins].sort().pop()!,
      fieldIds: fields.map((f) => toObjectId(f.id)),
      teamIds: items.flatMap((i) => [i.homeTeamId, i.awayTeamId]),
      exclude: items.map((i) => toObjectId(i.matchId)),
    });
    const fieldBookings = [...ctx.otherFieldMatches, ...ctx.tournamentMatches.filter((b) => b.fieldId && fields.some((f) => f.id === b.fieldId))];
    const r = rescheduleSearch(items, ctx, { ...base, fields, parallel: Infinity, fieldBookings, keepValid, avoidDates, avoidFieldIds, restDays: 6 });
    return {
      placements: r.placements.map((p) => ({ matchId: p.matchId, date: p.date, time: p.time, fieldId: p.fieldId, field: p.fieldId ? (labels[p.fieldId] ?? null) : null, changed: p.changed, warnings: p.warnings })),
      unscheduled: r.unplaced.map((u) => ({ matchId: u.matchId, reasons: u.reasons })),
      metrics: r.metrics,
      search,
      fields: labels,
    };
  }

  /** Las canchas activas de una lista (las desactivadas se descartan en silencio). */
  private async activeFields(ids: string[], organizerId: Types.ObjectId, session: ClientSession | null): Promise<CandidateField[]> {
    const out: CandidateField[] = [];
    for (const id of new Set(ids)) {
      const [f] = await this.candidateFields([id], organizerId, session).catch(() => [] as CandidateField[]);
      if (f) out.push(f);
    }
    return out;
  }

  /** Periodo y horario efectivos de la búsqueda (400 si no dejan ningún inicio). */
  private searchOf(rules: TournamentRules, duration: number, input: ProposeInput) {
    const to = input.to ?? addDays(input.from, Math.min(MAX_PERIOD_DAYS - 1, Math.max(28, Math.ceil(new Set(input.fixtures.map((f) => f.round)).size * input.daysBetweenRounds * 1.5))));
    if (to < input.from) throw new BadRequestException('La fecha final debe ser igual o posterior a la inicial');
    if ((Date.parse(to) - Date.parse(input.from)) / 86_400_000 >= MAX_PERIOD_DAYS) throw new BadRequestException(`El periodo de búsqueda no puede pasar de ${MAX_PERIOD_DAYS} días`);
    const hardDays = rules.days.length && !rules.softRules.includes('DAYS') ? rules.days : null;
    let days = [...new Set(input.days ?? [])].sort((a, b) => a - b);
    if (hardDays) days = days.length ? days.filter((d) => hardDays.includes(d)) : [...hardDays];
    if ((input.days?.length || hardDays) && !days.length) throw new BadRequestException('Ninguno de los días elegidos está permitido por las restricciones del torneo');
    const hardHours = !rules.softRules.includes('HOURS');
    const ruleFirst = rules.startTime;
    const ruleLast = rules.endTime ? clockOf(toMinutes(rules.endTime) - duration) : null;
    let first = input.firstKickoff ?? ruleFirst ?? '18:00';
    let last = input.lastKickoff ?? ruleLast ?? '22:00';
    if (hardHours && ruleFirst && first < ruleFirst) first = ruleFirst;
    if (hardHours && ruleLast && last > ruleLast) last = ruleLast;
    if (first > last) throw new BadRequestException(`El horario de búsqueda (${first}–${last}) no deja ningún inicio posible con partidos de ${duration} min`);
    const step = input.step ?? Math.ceil((duration + Math.max(rules.fieldGapMinutes ?? 0, 15)) / 5) * 5;
    return { from: input.from, to, days, firstKickoff: first, lastKickoff: last, step, daysBetweenRounds: input.daysBetweenRounds, parallel: input.parallel ?? null };
  }

  /** Canchas del propietario del torneo, activas (404 si alguna no es suya; 409 si está desactivada). */
  private async candidateFields(ids: string[], organizerId: Types.ObjectId, session: ClientSession | null): Promise<CandidateField[]> {
    if (!ids.length) return [];
    const venues = await this.venues.find({ 'fields._id': { $in: ids.map(toObjectId) } }).select('name organizerId active archived bufferMinutes fields').session(session).lean();
    return [...new Set(ids)].map((id) => {
      const venue = venues.find((v) => v.fields.some((f) => sameId(f._id, id)));
      if (!venue || !sameId(venue.organizerId, organizerId)) throw new NotFoundException('Cancha no encontrada');
      const field = venue.fields.find((f) => sameId(f._id, id))!;
      if (!venue.active || venue.archived || !field.active || field.archived) throw new ConflictException(`${venueLabel(venue.name, field.name)} está desactivada: elige otra cancha`);
      return { id, label: venueLabel(venue.name, field.name), buffer: venue.bufferMinutes };
    });
  }

  // ─── Interno ────────────────────────────────────────────────────────────────

  private async tournament(tid: Types.ObjectId, session: ClientSession | null) {
    const t = await this.tournaments.findById(tid).select('+scheduling name status organizerId information.schedule.durationMinutes').session(session).lean<LeanTournament>();
    if (!t) throw new NotFoundException(`Torneo ${tid.toHexString()} no encontrado`);
    return t;
  }

  private merge(t: LeanTournament, dto: UpdateTournamentSchedulingDto) {
    const { durationMinutes, ...patch } = dto;
    const next: TournamentRules = { ...rulesOf(t), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    next.days = [...next.days].sort((a, b) => a - b);
    next.softRules = [...next.softRules].sort();
    const duration = durationMinutes !== undefined ? (durationMinutes ?? DEFAULT_MATCH_MINUTES) : durationOf(t);
    return { next, duration };
  }

  /** Las reglas del torneo y las de cada equipo, coherentes entre sí. */
  private async assertAll(tid: Types.ObjectId, next: TournamentRules, duration: number, session: ClientSession | null, teamRules?: Map<string, TeamRules>) {
    assertTournamentRules(next, duration);
    const rules = teamRules ?? (await this.teamRules(tid, session));
    const names = await this.names([...rules.keys()], session);
    for (const [teamId, r] of rules) assertTeamRules(r, next, names.get(teamId));
  }

  private async teamRules(tid: Types.ObjectId, session: ClientSession | null) {
    const rows = await this.enrollments.find({ tournamentId: tid, scheduling: { $ne: null } }).select('+scheduling teamId').session(session).lean();
    return new Map(rows.map((e) => [e.teamId.toHexString(), teamRulesOf(e)]));
  }

  private async names(ids: string[], session: ClientSession | null) {
    const rows = await this.teams.find({ _id: { $in: [...new Set(ids)].map(toObjectId) } }).select('name').session(session).lean();
    return new Map(rows.map((t) => [t._id.toHexString(), t.name]));
  }

  private async context(
    session: ClientSession | null,
    tid: Types.ObjectId,
    proposals: Proposal[],
    opts: EnforceOptions & { override?: { rules: TournamentRules; duration: number; teamRules: Map<string, TeamRules> } } = {},
  ): Promise<EvaluationContext> {
    const dates = proposals.map((p) => p.date).sort();
    return this.loadContext(session, tid, {
      from: dates[0],
      to: dates[dates.length - 1],
      fieldIds: [...new Set(proposals.map((p) => p.fieldId).filter((f): f is string => !!f))].map(toObjectId),
      teamIds: proposals.flatMap((p) => [p.homeTeamId, p.awayTeamId]),
      exclude: [...(opts.exclude ?? []), ...proposals.filter((p) => p.matchId).map((p) => toObjectId(p.matchId!))],
      replaceAll: opts.replaceAll,
      override: opts.override,
    });
  }

  /** Lo que puede influir en partidos entre `from` y `to`: los del torneo (±15 días) y los de otros torneos en esas canchas. */
  private async loadContext(
    session: ClientSession | null,
    tid: Types.ObjectId,
    q: { from: string; to: string; fieldIds: Types.ObjectId[]; teamIds: string[]; exclude: Types.ObjectId[]; replaceAll?: boolean; override?: { rules: TournamentRules; duration: number; teamRules: Map<string, TeamRules> } },
  ): Promise<EvaluationContext> {
    const t = await this.tournament(tid, session);
    const rules = q.override?.rules ?? rulesOf(t);
    const duration = q.override?.duration ?? durationOf(t);
    const range = { $gte: addDays(q.from, -WINDOW_DAYS), $lte: addDays(q.to, WINDOW_DAYS) };
    const exclude = q.exclude;
    const own = q.replaceAll
      ? []
      : await this.matches
          .find({ tournamentId: tid, status: { $in: RESERVING }, date: range, ...(exclude.length ? { _id: { $nin: exclude } } : {}) })
          .select('homeTeamId awayTeamId date time fieldId')
          .session(session)
          .lean();
    const fieldIds = q.fieldIds;
    const [foreign, venues, teamRules] = await Promise.all([
      fieldIds.length
        ? this.matches
            .find({ fieldId: { $in: fieldIds }, tournamentId: { $ne: tid }, status: { $in: RESERVING }, date: range })
            .select('tournamentId homeTeamId awayTeamId date time fieldId')
            .session(session)
            .lean()
        : [],
      fieldIds.length ? this.venues.find({ 'fields._id': { $in: fieldIds } }).select('name fields').session(session).lean() : [],
      q.override ? q.override.teamRules : this.teamRules(tid, session),
    ]);
    const others = foreign.length
      ? await this.tournaments.find({ _id: { $in: [...new Set(foreign.map((m) => m.tournamentId.toHexString()))].map(toObjectId) } }).select('information.schedule.durationMinutes').session(session).lean()
      : [];
    const durations = new Map(others.map((o) => [o._id.toHexString(), durationOf(o)]));
    const booked = (m: { _id: Types.ObjectId; homeTeamId: Types.ObjectId; awayTeamId: Types.ObjectId; date: string; time: string; fieldId: Types.ObjectId | null }, tournamentId: string, minutes: number): Booked => ({
      id: m._id.toHexString(),
      tournamentId,
      homeTeamId: m.homeTeamId.toHexString(),
      awayTeamId: m.awayTeamId.toHexString(),
      date: m.date,
      time: m.time,
      fieldId: m.fieldId?.toHexString() ?? null,
      duration: minutes,
    });
    const fields = new Map<string, { label: string; availability: { weekly: { day: number; from: string; to: string }[]; closedDates: string[] } | null }>();
    for (const v of venues) for (const f of v.fields) fields.set(f._id.toHexString(), { label: venueLabel(v.name, f.name), availability: f.availability ?? null });
    return {
      tournamentId: tid.toHexString(),
      duration,
      rules,
      teamRules,
      teamNames: await this.names(q.teamIds, session),
      tournamentMatches: own.map((m) => booked(m, tid.toHexString(), duration)),
      otherFieldMatches: foreign.map((m) => booked(m, m.tournamentId.toHexString(), durations.get(m.tournamentId.toHexString()) ?? DEFAULT_MATCH_MINUTES)),
      fields,
    };
  }

  /**
   * Lo ya programado frente a una configuración: partidos SCHEDULED desde hoy (en la zona del
   * torneo). Lo jugado no se revisa (no se invalidan calendarios históricos) y nada se modifica.
   */
  private async existingConflicts(tid: Types.ObjectId, session: ClientSession | null, override?: { rules: TournamentRules; duration: number; teamRules: Map<string, TeamRules> }) {
    const t = await this.tournament(tid, session);
    const rules = override?.rules ?? rulesOf(t);
    const today = todayISODate(new Date(), timeZoneOf(rules));
    const pending = await this.matches
      .find({ tournamentId: tid, status: MatchStatus.SCHEDULED, date: { $gte: today } })
      .select('round homeTeamId awayTeamId date time fieldId')
      .sort({ date: 1, time: 1, _id: 1 })
      .session(session)
      .lean();
    const proposals: Proposal[] = pending.map((m) => ({
      key: m._id.toHexString(),
      matchId: m._id.toHexString(),
      homeTeamId: m.homeTeamId.toHexString(),
      awayTeamId: m.awayTeamId.toHexString(),
      date: m.date,
      time: m.time,
      fieldId: m.fieldId?.toHexString() ?? null,
      round: m.round,
    }));
    if (!proposals.length) return { today, checked: 0, matches: [] as ProposalIssues[] };
    const ctx = await this.context(session, tid, proposals, { override: override ?? { rules, duration: durationOf(t), teamRules: await this.teamRules(tid, session) } });
    const result = evaluate(proposals, ctx);
    const matches = proposals.map((p) => issuesOf(p, result.get(p.key)!)).filter((i) => i.errors.length || i.warnings.length);
    return { today, checked: proposals.length, matches };
  }

  private async build(tid: Types.ObjectId, session: ClientSession | null) {
    const t = await this.tournament(tid, session);
    const rules = rulesOf(t);
    const enrolled = await this.enrollments.find({ tournamentId: tid }).select('+scheduling teamId withdrawnAt').session(session).lean();
    const names = await this.names(enrolled.map((e) => e.teamId.toHexString()), session);
    const updatedBy = t.scheduling?.updatedBy ? await this.users.findById(t.scheduling.updatedBy).select('firstName lastName').session(session).lean() : null;
    return {
      rules,
      durationMinutes: durationOf(t),
      durationConfigured: t.information?.schedule?.durationMinutes != null,
      effectiveTimeZone: timeZoneOf(rules),
      updatedAt: t.scheduling?.updatedAt ?? null,
      updatedBy: updatedBy ? `${updatedBy.firstName} ${updatedBy.lastName}`.trim() : null,
      teams: enrolled
        .map((e) => ({ teamId: e.teamId.toHexString(), name: names.get(e.teamId.toHexString()) ?? 'Equipo', withdrawn: !!e.withdrawnAt, configured: !!e.scheduling, rules: e.scheduling ? teamRulesOf(e) : { ...DEFAULT_TEAM_RULES } }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      conflicts: await this.existingConflicts(tid, session),
    };
  }
}

function normalizeTeam(dto: TeamSchedulingDto): TeamRules {
  return {
    unavailableDays: [...(dto.unavailableDays ?? [])].sort((a, b) => a - b),
    unavailableDates: [...(dto.unavailableDates ?? [])].sort(),
    unavailableTimes: (dto.unavailableTimes ?? []).map((t) => ({ day: t.day ?? null, from: t.from, to: t.to })),
    minRestHours: dto.minRestHours ?? null,
    maxMatchesPerDay: dto.maxMatchesPerDay ?? null,
    strict: dto.strict ?? true,
    notes: dto.notes ?? null,
  };
}

const emptyMetrics = (): AutoMetrics => ({ placed: 0, unplaced: 0, withWarnings: 0, lateRounds: 0, lateDays: 0, shortestRestHours: null, longestGapDays: null, firstDate: null, lastDate: null, cost: 0, evaluations: 0, attempts: 0, elapsedMs: 0, truncated: false });
const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

const issuesOf = (p: Proposal, e: Evaluation): ProposalIssues => ({
  key: p.key,
  matchId: p.matchId,
  round: p.round ?? null,
  date: p.date,
  time: p.time,
  homeTeamId: p.homeTeamId,
  awayTeamId: p.awayTeamId,
  errors: e.errors,
  warnings: e.warnings,
});
