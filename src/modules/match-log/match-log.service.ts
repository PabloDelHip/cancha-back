import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { MatchLog } from './schemas/match-log.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { Referee, refereeName } from '../referees/schemas/referee.schema.js';
import { MatchLogAction, MatchLogCause, MatchLogSource } from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import type { AuthUser } from '../auth/auth.types.js';
import { diff, editAction, releasedOf, resultAction, RESULT, snapshotOf, TRACKED } from './match-diff.js';

/** Un partido tal como sale de Mongoose (lean u objeto). */
type Doc = { _id: Types.ObjectId; tournamentId: Types.ObjectId };
const rec = (d: Doc) => d as unknown as Record<string, unknown>;
export interface Actor {
  userId: string;
  source?: MatchLogSource;
}

/**
 * Historial de partidos (Módulo 2C-1). Todas las escrituras reciben la `session` de la transacción
 * que hace el cambio: si el cambio no se confirma, su entrada tampoco (y en un reintento por
 * conflicto se vuelve a calcular desde cero). Sin cambios reales no se escribe nada.
 */
@Injectable()
export class MatchLogService {
  constructor(
    @InjectModel(MatchLog.name) private readonly logs: Model<MatchLog>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Referee.name) private readonly referees: Model<Referee>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
  ) {}

  // ─── Escritura ──────────────────────────────────────────────────────────────

  private async write(session: ClientSession, actor: Actor, entry: Partial<MatchLog> & { tournamentId: Types.ObjectId; action: MatchLogAction }) {
    const actorRole = await this.access.roleOf(entry.tournamentId, actor.userId, session);
    await this.logs.create([{ source: MatchLogSource.USER, ...entry, actorId: toObjectId(actor.userId), actorRole, ...(actor.source ? { source: actor.source } : {}) }], { session });
  }

  /** Partidos creados a mano (los de un calendario generado no se registran uno por uno). */
  async created(session: ClientSession, actor: Actor, docs: Doc[]) {
    for (const d of docs) await this.write(session, actor, { tournamentId: d.tournamentId, matchId: d._id, action: MatchLogAction.CREATED, snapshot: snapshotOf(rec(d)) });
  }

  /** Edición de programación (fecha, hora, estado, cancha, jornada, equipos, torneo). */
  async edited(session: ClientSession, actor: Actor, before: Doc, after: Doc, reason: string | null) {
    const changes = diff(rec(before), rec(after), TRACKED);
    if (!changes) return;
    await this.write(session, actor, { tournamentId: after.tournamentId, matchId: after._id, action: editAction(changes), changes, reason });
  }

  /** Marcador y estado (no las estadísticas individuales). */
  async result(session: ClientSession, actor: Actor, before: Doc, after: Doc) {
    const changes = diff(rec(before), rec(after), RESULT);
    if (!changes) return;
    await this.write(session, actor, {
      tournamentId: after.tournamentId,
      matchId: after._id,
      action: resultAction({ homeScore: rec(before).homeScore, status: String(rec(before).status) }, { status: String(rec(after).status) }),
      changes,
    });
  }

  /** Movimientos de árbitros (asignar, quitar, ausencia con o sin sustituto). */
  async referee(session: ClientSession, actor: Actor, match: Doc, action: MatchLogAction, changes: Record<string, { from: unknown; to: unknown }>, reason: string | null = null) {
    await this.write(session, actor, { tournamentId: match.tournamentId, matchId: match._id, action, changes, reason });
  }

  /** El cuadro reasignó equipos de un cruce (solo si cambiaron). */
  async teamsBySystem(session: ClientSession, actor: Actor, before: Doc, after: Doc) {
    const changes = diff(rec(before), rec(after), ['homeTeamId', 'awayTeamId']);
    if (!changes) return;
    await this.write(session, { ...actor, source: MatchLogSource.SYSTEM }, {
      tournamentId: after.tournamentId,
      matchId: after._id,
      action: MatchLogAction.TEAMS_CHANGED,
      cause: MatchLogCause.BRACKET_SYNC,
      changes,
    });
  }

  /**
   * Antes de eliminar partidos: una entrada por partido con su copia y lo que se libera. Con
   * `bulk` (calendario reemplazado) es una sola entrada con todos, consultable por partido.
   */
  async deleting(session: ClientSession, actor: Actor, filter: Record<string, unknown>, cause: MatchLogCause, opts: { bulk?: boolean; reason?: string | null } = {}) {
    const docs = (await this.matches.find(filter).session(session).lean()) as unknown as Doc[];
    if (!docs.length) return;
    const released = (d: Doc) => releasedOf(rec(d));
    if (opts.bulk) {
      await this.write(session, actor, {
        tournamentId: docs[0].tournamentId,
        matchId: null,
        affectedMatchIds: docs.map((d) => d._id),
        action: MatchLogAction.SCHEDULE_REPLACED,
        cause,
        reason: opts.reason ?? null,
        deleted: docs.map((d) => snapshotOf(rec(d))),
        released: docs.map(released).filter((r): r is NonNullable<typeof r> => !!r),
      });
      return;
    }
    for (const d of docs) {
      const r = released(d);
      await this.write(session, actor, {
        tournamentId: d.tournamentId,
        matchId: d._id,
        action: MatchLogAction.DELETED,
        cause,
        reason: opts.reason ?? null,
        snapshot: snapshotOf(rec(d)),
        released: r ? [r] : null,
      });
    }
  }

  // ─── Lectura (solo el organizador; también con el torneo finalizado) ────────

  /** Historial de un partido en orden cronológico (también si ya se eliminó). */
  async ofMatch(matchId: string, user: AuthUser) {
    const id = toObjectId(matchId);
    const match = await this.matches.findById(id).select('tournamentId').lean();
    const tournamentId = match?.tournamentId ?? (await this.logs.findOne({ $or: [{ matchId: id }, { affectedMatchIds: id }] }).select('tournamentId').lean())?.tournamentId;
    if (!tournamentId) throw new NotFoundException('Partido no encontrado');
    await this.ownership.ownedTournament(tournamentId, user, Permission.LOGS_VIEW);
    const entries = await this.logs.find({ tournamentId, $or: [{ matchId: id }, { affectedMatchIds: id }] }).sort({ createdAt: 1, _id: 1 }).lean();
    return this.view(entries);
  }

  /** Historial del torneo, lo más reciente primero (incluye partidos eliminados). */
  async ofTournament(tournamentId: string, user: AuthUser, query: { deleted?: boolean }) {
    await this.ownership.ownedTournament(tournamentId, user, Permission.LOGS_VIEW);
    const filter: Record<string, unknown> = { tournamentId: toObjectId(tournamentId) };
    if (query.deleted) filter.action = { $in: [MatchLogAction.DELETED, MatchLogAction.SCHEDULE_REPLACED] };
    const entries = await this.logs.find(filter).sort({ createdAt: -1, _id: -1 }).limit(500).lean();
    return this.view(entries);
  }

  /** Entradas con los nombres que citan (equipos, árbitros, responsable). */
  private async view(entries: (MatchLog & { _id: Types.ObjectId })[]) {
    const teamIds = new Set<string>();
    const refereeIds = new Set<string>();
    const scan = (v: unknown, key = '') => {
      if (typeof v === 'string' && /^[0-9a-f]{24}$/.test(v)) {
        if (key === 'homeTeamId' || key === 'awayTeamId') teamIds.add(v);
        if (key === 'refereeId' || key === 'substituteId') refereeIds.add(v);
      } else if (Array.isArray(v)) v.forEach((x) => scan(x, key));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, k === 'from' || k === 'to' ? key : k);
    };
    entries.forEach((e) => [e.changes, e.snapshot, e.deleted, e.released].forEach((x) => scan(x)));
    const [teams, refs, users] = await Promise.all([
      this.teams.find({ _id: { $in: [...teamIds].map(toObjectId) } }).select('name').lean(),
      this.referees.find({ _id: { $in: [...refereeIds].map(toObjectId) } }).select('firstName lastName').lean(),
      this.users.find({ _id: { $in: [...new Set(entries.map((e) => e.actorId.toHexString()))].map(toObjectId) } }).select('firstName lastName').lean(),
    ]);
    return {
      entries: serialize(entries),
      refs: {
        teams: Object.fromEntries(teams.map((t) => [t._id.toHexString(), t.name])),
        referees: Object.fromEntries(refs.map((r) => [r._id.toHexString(), refereeName(r)])),
        users: Object.fromEntries(users.map((u) => [u._id.toHexString(), `${u.firstName} ${u.lastName}`.trim()])),
      },
    };
  }
}
