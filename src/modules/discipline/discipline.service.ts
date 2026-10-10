import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { Sanction } from './schemas/sanction.schema.js';
import { DisciplineLog } from './schemas/discipline-log.schema.js';
import { disciplineOf, type DisciplineRules } from './schemas/discipline-rules.schema.js';
import { DisciplineAction, EligibilityMode, SanctionCause, SanctionKind, TournamentStatus } from '../../common/enums/index.js';
import { assertStarted, OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { sameId, toObjectId } from '../../common/utils/serialize.js';
import { teamRef } from '../../common/utils/public.js';
import type { AuthUser } from '../auth/auth.types.js';
import { computeDiscipline, suspendedIn, type DisciplineResult, type DMatch, type DPosition, type DRecord, type DStat } from './discipline.js';
import type { CreateSanctionDto, HistoryQueryDto, UpdateDisciplineRulesDto, UpdateSanctionDto } from './dto/discipline.dto.js';
import type { PlayerStatInputDto } from '../matches/dto/match.dto.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const snapshot = (s: Pick<Sanction, 'matches' | 'annulled' | 'reason'> & { matchId?: Types.ObjectId | string | null }) => ({
  matches: s.matches,
  annulled: s.annulled,
  reason: s.reason,
  ...(s.matchId ? { matchId: String(s.matchId) } : {}),
});

/**
 * Control disciplinario del torneo (solo su organizador). Las sanciones automáticas se calculan
 * con `computeDiscipline` sobre UN torneo (sus partidos y estadísticas, con proyección): nunca se
 * recorre la temporada ni otros torneos. Lo persistido son decisiones humanas (Sanction) y el
 * historial (DisciplineLog). Toda escritura corre con el cerrojo del torneo, igual que los
 * resultados, así que una sanción nunca se calcula a medias de una captura.
 */
@Injectable()
export class DisciplineService {
  constructor(
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(Match.name) private readonly matchesModel: Model<Match>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Sanction.name) private readonly sanctions: Model<Sanction>,
    @InjectModel(DisciplineLog.name) private readonly log: Model<DisciplineLog>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
  ) {}

  // ─── Cálculo ────────────────────────────────────────────────────────────────

  private async compute(tournamentId: Types.ObjectId, session: ClientSession | null = null) {
    const tournament = await this.tournaments.findById(tournamentId).select('+discipline status').session(session).lean();
    if (!tournament) throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);
    const matchDocs = await this.matchesModel
      .find({ tournamentId })
      .select('homeTeamId awayTeamId status date time round stage postponedFrom')
      .session(session)
      .lean();
    const [statDocs, records, membershipDocs] = await Promise.all([
      this.stats
        .find({ matchId: { $in: matchDocs.map((m) => m._id) } })
        .select('matchId playerId teamId played yellowCards redCards sendOff')
        .session(session)
        .lean(),
      this.sanctions.find({ tournamentId }).session(session).lean(),
      this.memberships.find({ tournamentId }).select('playerId teamId startDate endDate active').session(session).lean(),
    ]);
    const matches: DMatch[] = matchDocs.map((m) => ({
      id: m._id.toHexString(),
      homeTeamId: m.homeTeamId.toHexString(),
      awayTeamId: m.awayTeamId.toHexString(),
      status: m.status,
      date: m.date,
      time: m.time,
      round: m.round,
      phase: m.stage?.phase ?? 0,
      stale: !!m.postponedFrom && m.postponedFrom.date === m.date && m.postponedFrom.time === m.time,
    }));
    const stats: DStat[] = statDocs.map((s) => ({
      matchId: s.matchId.toHexString(),
      playerId: s.playerId.toHexString(),
      teamId: s.teamId.toHexString(),
      played: s.played,
      yellowCards: s.yellowCards,
      redCards: s.redCards,
      sendOff: s.sendOff,
    }));
    const rules = disciplineOf(tournament);
    const memberships = membershipDocs.map((m) => ({
      playerId: m.playerId.toHexString(),
      teamId: m.teamId.toHexString(),
      startDate: m.startDate,
      endDate: m.endDate,
      active: m.active,
    }));
    const result = computeDiscipline({ rules, tournamentStatus: tournament.status, matches, stats, records: records.map(toRecord), memberships });
    return { tournament, rules, matches, result };
  }

  // ─── Lecturas ───────────────────────────────────────────────────────────────

  async overview(id: string, user: AuthUser) {
    await this.ownership.ownedTournament(id, user, Permission.DISCIPLINE_VIEW);
    return this.view(toObjectId(id));
  }

  private async view(tournamentId: Types.ObjectId) {
    const { tournament, rules, matches, result } = await this.compute(tournamentId);
    return {
      rules,
      readOnly: tournament.status === TournamentStatus.FINISHED,
      ...result,
      orphans: result.orphans.map((o) => ({ ...o, ref: o.key! })),
      refs: await this.refs(result, matches),
    };
  }

  /** Nombres de jugadores, equipos y partidos citados (para pintar sin más peticiones). */
  private async refs(result: DisciplineResult, matches: DMatch[]) {
    const playerIds = new Set<string>();
    const teamIds = new Set<string>();
    const matchIds = new Set<string>();
    const add = (x: { playerId: string; teamId: string; matchId?: string }) => {
      playerIds.add(x.playerId);
      teamIds.add(x.teamId);
      if (x.matchId) matchIds.add(x.matchId);
    };
    result.sanctions.forEach((s) => {
      add(s);
      s.coveredMatchIds.forEach((m) => matchIds.add(m));
    });
    [...result.players, ...result.orphans, ...result.unclassified, ...result.incidents].forEach(add);
    result.staleMatchIds.forEach((m) => matchIds.add(m));
    const refMatches = matches.filter((m) => matchIds.has(m.id));
    refMatches.forEach((m) => [m.homeTeamId, m.awayTeamId].forEach((t) => teamIds.add(t)));
    const [players, teams] = await Promise.all([
      this.players.find({ _id: { $in: [...playerIds].map(toObjectId) } }).select('firstName lastName photoUrl').lean(),
      this.teams.find({ _id: { $in: [...teamIds].map(toObjectId) } }).select('name shortName logoUrl colors').lean(),
    ]);
    return {
      players: Object.fromEntries(
        players.map((p) => [p._id.toHexString(), { id: p._id.toHexString(), firstName: p.firstName, lastName: p.lastName, photoUrl: p.photoUrl ?? null }]),
      ),
      teams: Object.fromEntries(teams.map((t) => [t._id.toHexString(), teamRef(t)])),
      matches: Object.fromEntries(refMatches.map((m) => [m.id, m])),
    };
  }

  async history(id: string, query: HistoryQueryDto, user: AuthUser) {
    await this.ownership.ownedTournament(id, user, Permission.DISCIPLINE_VIEW);
    const filter: Record<string, unknown> = { tournamentId: toObjectId(id) };
    if (query.ref) filter.ref = query.ref;
    if (query.playerId) filter.playerId = toObjectId(query.playerId);
    const entries = await this.log.find(filter).sort({ createdAt: -1, _id: -1 }).limit(500).lean();
    const users = await this.users
      .find({ _id: { $in: [...new Set(entries.map((e) => e.userId.toHexString()))].map(toObjectId) } })
      .select('firstName lastName')
      .lean();
    const nameOf = new Map(users.map((u) => [u._id.toHexString(), `${u.firstName} ${u.lastName}`.trim()]));
    return entries.map((e) => ({
      id: e._id.toHexString(),
      action: e.action,
      ref: e.ref,
      playerId: e.playerId?.toHexString() ?? null,
      matchId: e.matchId?.toHexString() ?? null,
      by: { id: e.userId.toHexString(), name: nameOf.get(e.userId.toHexString()) ?? null, role: e.actorRole ?? null },
      justification: e.justification,
      before: e.before,
      after: e.after,
      createdAt: e.createdAt,
    }));
  }

  /** Suspendidos para un partido (avisos al capturar la alineación). */
  async eligibility(matchId: string, user: AuthUser) {
    const match = await this.matchesModel.findById(matchId).select('tournamentId').lean();
    if (!match) throw new NotFoundException(`Partido ${matchId} no encontrado`);
    await this.ownership.ownedTournament(match.tournamentId, user, Permission.DISCIPLINE_VIEW);
    const { rules, matches, result } = await this.compute(match.tournamentId);
    return {
      mode: rules.eligibility,
      /** Pospuesto con su fecha original: no cuenta para las suspensiones hasta corregirla. */
      staleDate: !!matches.find((m) => m.id === matchId)?.stale,
      suspended: suspendedIn(result, matchId).map((s) => ({
        ref: s.ref,
        playerId: s.playerId,
        teamId: s.teamId,
        cause: s.cause,
        matches: s.matches,
        remaining: s.remaining,
        reason: s.reason,
      })),
    };
  }

  // ─── Reglamento ─────────────────────────────────────────────────────────────

  async updateRules(id: string, dto: UpdateDisciplineRulesDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.DISCIPLINE_MANAGE);
    const { justification, ...patch } = dto;
    await this.ownership.inTournament(id, { user, permission: Permission.DISCIPLINE_MANAGE }, async (session) => {
      const t = await this.tournaments.findById(id).select('+discipline').session(session).lean();
      const before = disciplineOf(t!);
      const next: DisciplineRules = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      await this.tournaments.updateOne({ _id: id }, { $set: { discipline: next } }, { session, runValidators: true });
      await this.record(session, {
        tournamentId: toObjectId(id),
        action: DisciplineAction.RULES_UPDATED,
        userId: user.id,
        justification: justification ?? null,
        before: { ...before },
        after: { ...next },
      });
    });
    return this.view(toObjectId(id));
  }

  // ─── Sanciones ──────────────────────────────────────────────────────────────

  async create(id: string, dto: CreateSanctionDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.DISCIPLINE_MANAGE);
    const tournamentId = toObjectId(id);
    await this.ownership.inTournament(id, { user, permission: Permission.DISCIPLINE_MANAGE }, async (session, status) => {
      // En DRAFT no se juega: todavía no hay nada que sancionar.
      assertStarted(status);
      const match = await this.matchesModel.findOne({ _id: toObjectId(dto.matchId), tournamentId }).select(START_FIELDS).session(session).lean();
      if (!match) throw new BadRequestException('El partido no pertenece a este torneo');
      if (!sameId(match.homeTeamId, dto.teamId) && !sameId(match.awayTeamId, dto.teamId)) {
        throw new BadRequestException('El equipo no juega el partido desde el que aplica la sanción');
      }
      const member = await this.memberships
        .exists({ tournamentId, playerId: toObjectId(dto.playerId), teamId: toObjectId(dto.teamId) })
        .session(session);
      if (!member) throw new BadRequestException('El jugador no está registrado con ese equipo en este torneo');
      const [created] = await this.sanctions.create(
        [
          {
            tournamentId,
            kind: SanctionKind.MANUAL,
            key: null,
            playerId: toObjectId(dto.playerId),
            teamId: toObjectId(dto.teamId),
            cause: SanctionCause.MANUAL,
            matchId: match._id,
            start: positionOf(match),
            matches: dto.matches,
            reason: dto.reason.trim(),
            annulled: false,
            createdBy: toObjectId(user.id),
          },
        ],
        { session },
      );
      await this.record(session, {
        tournamentId,
        action: DisciplineAction.SANCTION_CREATED,
        ref: created._id.toHexString(),
        playerId: created.playerId,
        matchId: match._id,
        userId: user.id,
        justification: dto.reason.trim(),
        after: snapshot(created),
      });
    });
    return this.view(tournamentId);
  }

  async update(id: string, ref: string, dto: UpdateSanctionDto, user: AuthUser) {
    return this.change(id, ref, user, dto.justification, DisciplineAction.SANCTION_UPDATED, async (current, session, tournamentId) => {
      if (current.kind === SanctionKind.AUTO) {
        if (dto.reason !== undefined || dto.matchId !== undefined) {
          throw new BadRequestException('En una sanción automática solo se ajusta la duración');
        }
        if (dto.matches === undefined) throw new BadRequestException('Indica la nueva duración');
        return { matches: dto.matches };
      }
      const set: Partial<Sanction> = {};
      if (dto.matches !== undefined) {
        if (dto.matches === null) throw new BadRequestException('Una sanción manual necesita duración');
        set.matches = dto.matches;
      }
      if (dto.reason !== undefined) set.reason = dto.reason.trim();
      if (dto.matchId !== undefined) {
        const match = await this.matchesModel.findOne({ _id: toObjectId(dto.matchId), tournamentId }).select(START_FIELDS).session(session).lean();
        if (!match) throw new BadRequestException('El partido no pertenece a este torneo');
        if (!(await this.playsFor(tournamentId, current.playerId, match, session))) {
          throw new BadRequestException('El jugador no juega ese partido con ninguno de sus equipos en este torneo');
        }
        set.matchId = match._id;
        set.start = positionOf(match);
      }
      if (!Object.keys(set).length) throw new BadRequestException('No hay cambios');
      return set;
    });
  }

  annul(id: string, ref: string, justification: string, user: AuthUser) {
    return this.change(id, ref, user, justification, DisciplineAction.SANCTION_ANNULLED, async (current) => {
      if (current.annulled) throw new ConflictException('La sanción ya está anulada');
      return { annulled: true };
    });
  }

  restore(id: string, ref: string, justification: string, user: AuthUser) {
    return this.change(id, ref, user, justification, DisciplineAction.SANCTION_RESTORED, async (current) => {
      if (!current.annulled) throw new ConflictException('La sanción no está anulada');
      return { annulled: false };
    });
  }

  /**
   * Cambio de una sanción con justificación e historial. Una automática se ajusta creando (una
   * sola vez: índice único + cerrojo) el documento de ajuste enlazado a su clave.
   */
  private async change(
    id: string,
    ref: string,
    user: AuthUser,
    justification: string,
    action: DisciplineAction,
    patch: (
      current: Pick<Sanction, 'kind' | 'matches' | 'annulled' | 'reason' | 'teamId' | 'playerId'> & { matchId: Types.ObjectId },
      session: ClientSession,
      tournamentId: Types.ObjectId,
    ) => Promise<Partial<Sanction>>,
  ) {
    await this.ownership.tournament(id, user, Permission.DISCIPLINE_MANAGE);
    const tournamentId = toObjectId(id);
    await this.ownership.inTournament(id, { user, permission: Permission.DISCIPLINE_MANAGE }, async (session, status) => {
      assertStarted(status);
      let filter: Record<string, unknown>;
      let current: Parameters<typeof patch>[0];
      let insert: Partial<Sanction> | null = null;
      if (OBJECT_ID.test(ref)) {
        filter = { _id: toObjectId(ref), tournamentId, kind: SanctionKind.MANUAL };
        const doc = await this.sanctions.findOne(filter).session(session).lean();
        if (!doc) throw new NotFoundException('Sanción no encontrada');
        current = doc;
      } else {
        filter = { tournamentId, key: ref };
        const { result } = await this.compute(tournamentId, session);
        const derived = result.sanctions.find((s) => s.ref === ref);
        if (!derived) {
          throw new ConflictException(
            result.orphans.some((o) => o.key === ref)
              ? 'Esa sanción automática ya no existe (cambiaron las tarjetas o el reglamento): su historial se conserva'
              : 'Sanción no encontrada',
          );
        }
        const doc = await this.sanctions.findOne(filter).session(session).lean();
        current = doc ?? {
          kind: SanctionKind.AUTO,
          matches: null,
          annulled: false,
          reason: null,
          playerId: toObjectId(derived.playerId),
          teamId: toObjectId(derived.teamId),
          matchId: toObjectId(derived.matchId),
        };
        if (!doc) {
          insert = {
            kind: SanctionKind.AUTO,
            playerId: toObjectId(derived.playerId),
            teamId: toObjectId(derived.teamId),
            cause: derived.cause,
            matchId: toObjectId(derived.matchId),
            createdBy: toObjectId(user.id),
          };
        }
      }
      const set = await patch(current, session, tournamentId);
      const updated = await this.sanctions
        .findOneAndUpdate(filter, { $set: set, ...(insert ? { $setOnInsert: insert } : {}) }, { upsert: !!insert, returnDocument: 'after', session, runValidators: true })
        .lean();
      await this.record(session, {
        tournamentId,
        action,
        ref,
        playerId: updated!.playerId,
        matchId: updated!.matchId,
        userId: user.id,
        justification: justification.trim(),
        before: snapshot(current),
        after: snapshot(updated!),
      });
    });
    return this.view(tournamentId);
  }

  // ─── Integración con la captura de resultados ───────────────────────────────

  /**
   * Antes de guardar un resultado (dentro de su transacción y cerrojo): si se marca como jugado a
   * un suspendido que antes no figuraba como jugado en ese partido, en modo BLOCK se rechaza y en
   * WARN se registra la incidencia. Volver a guardar sin cambios no repite el registro.
   */
  async checkLineup(
    match: { _id: Types.ObjectId; tournamentId: Types.ObjectId },
    playerStats: Pick<PlayerStatInputDto, 'playerId' | 'played'>[],
    session: ClientSession,
    user: AuthUser,
  ) {
    const { rules, result } = await this.compute(match.tournamentId, session);
    const suspended = new Map(suspendedIn(result, match._id.toHexString()).map((s) => [s.playerId, s]));
    if (!suspended.size) return;
    const before = await this.stats.find({ matchId: match._id, played: true }).select('playerId').session(session).lean();
    const wasPlaying = new Set(before.map((s) => s.playerId.toHexString()));
    const newly = playerStats.filter((s) => s.played && suspended.has(s.playerId) && !wasPlaying.has(s.playerId));
    if (!newly.length) return;
    if (rules.eligibility === EligibilityMode.BLOCK) {
      const players = await this.players.find({ _id: { $in: newly.map((s) => toObjectId(s.playerId)) } }).select('firstName lastName').session(session).lean();
      throw new ConflictException(
        `Jugadores suspendidos para este partido: ${players.map((p) => `${p.firstName} ${p.lastName}`).join(', ')}. Desmárcalos o revisa su sanción en Disciplina.`,
      );
    }
    for (const s of newly) {
      await this.record(session, {
        tournamentId: match.tournamentId,
        action: DisciplineAction.PLAYED_WHILE_SUSPENDED,
        ref: suspended.get(s.playerId)!.ref,
        playerId: toObjectId(s.playerId),
        matchId: match._id,
        userId: user.id,
        justification: null,
      });
    }
  }

  /**
   * Suspendidos para este partido entre estos jugadores, sin registrar nada (alineaciones de la
   * ficha técnica, 2D). `block`: el reglamento no permite alinearlos. La incidencia de "jugó estando
   * suspendido" la sigue registrando la captura de estadísticas (checkLineup), una sola vez.
   */
  async suspendedAmong(match: { _id: Types.ObjectId; tournamentId: Types.ObjectId }, playerIds: string[], session: ClientSession) {
    const { rules, result } = await this.compute(match.tournamentId, session);
    const suspended = new Set(suspendedIn(result, match._id.toHexString()).map((s) => s.playerId));
    return { block: rules.eligibility === EligibilityMode.BLOCK, playerIds: playerIds.filter((id) => suspended.has(id)) };
  }

  /** Tras un cambio de equipo, la sanción manual puede aplicar desde un partido del equipo nuevo. */
  private async playsFor(tournamentId: Types.ObjectId, playerId: Types.ObjectId, match: { homeTeamId: Types.ObjectId; awayTeamId: Types.ObjectId }, session: ClientSession) {
    return !!(await this.memberships
      .exists({ tournamentId, playerId, teamId: { $in: [match.homeTeamId, match.awayTeamId] } })
      .session(session));
  }

  /** Un partido desde el que aplica una sanción no se borra (perdería su referencia). */
  async assertMatchUnreferenced(matchId: Types.ObjectId, session: ClientSession) {
    if (await this.sanctions.exists({ matchId }).session(session)) {
      throw new ConflictException('El partido está referido por una sanción: cámbiala de partido o anúlala antes de eliminarlo; o márcalo como CANCELLED');
    }
  }

  private async record(
    session: ClientSession,
    entry: {
      tournamentId: Types.ObjectId;
      action: DisciplineAction;
      userId: string;
      ref?: string | null;
      playerId?: Types.ObjectId | null;
      matchId?: Types.ObjectId | null;
      justification?: string | null;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
    },
  ) {
    const actorRole = await this.access.roleOf(entry.tournamentId, entry.userId, session);
    await this.log.create([{ ...entry, userId: toObjectId(entry.userId), actorRole }], { session });
  }
}

const START_FIELDS = 'homeTeamId awayTeamId date time round stage';
const positionOf = (m: Pick<Match, 'date' | 'time' | 'round' | 'stage'>): DPosition => ({ phase: m.stage?.phase ?? 0, date: m.date, time: m.time, round: m.round });

function toRecord(r: Sanction & { _id: Types.ObjectId }): DRecord {
  return {
    id: r._id.toHexString(),
    kind: r.kind,
    key: r.key,
    playerId: r.playerId.toHexString(),
    teamId: r.teamId.toHexString(),
    cause: r.cause,
    matchId: r.matchId.toHexString(),
    matches: r.matches,
    reason: r.reason,
    annulled: r.annulled,
    start: r.start ?? null,
  };
}
