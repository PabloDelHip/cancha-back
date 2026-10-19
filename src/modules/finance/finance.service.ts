import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { FinanceEntry } from './schemas/finance-entry.schema.js';
import { randomUUID } from 'node:crypto';
import { FinanceCategory, FinanceEntryKind, enrollmentFeeCents, entryShapeError, ledgerRewriteError, totals, withBalance } from './finance.js';
import { accountTotals, statementPage, totalsBy } from './finance-queries.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { RemovedEnrollment } from '../tournaments/schemas/removed-enrollment.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { TeamAccessService } from '../../common/authorization/team-access.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { sameId, serialize, toObjectId } from '../../common/utils/serialize.js';
import { todayISODate } from '../../common/utils/dates.js';
import type { CorrectFinanceEntryDto, CreateFinanceEntryDto, GenerateEnrollmentChargesDto, StatementQueryDto, VoidFinanceEntryDto } from './dto/finance.dto.js';
import type { AuthUser } from '../auth/auth.types.js';

/** Moneda del torneo (F8): la de su información; MXN si nunca se configuró. */
const currencyOf = (t: { information?: { costs?: { currency?: string | null } | null } | null } | null) => t?.information?.costs?.currency || 'MXN';
const PAYLOAD = ['teamId', 'kind', 'amount', 'category', 'method', 'reference', 'date', 'concept', 'notes', 'reason', 'matchId', 'playerId'] as const;
/** Lo que el equipo ve de cada movimiento (F3b): sin `notes`, autor, rol, `requestId` ni vínculos internos. */
const TEAM_VISIBLE = (e: FinanceEntry & { _id: Types.ObjectId }) => ({
  id: e._id.toHexString(),
  kind: e.kind,
  category: e.category ?? null,
  amount: e.amount,
  currency: e.currency,
  method: e.method ?? null,
  reference: e.reference ?? null,
  date: e.date,
  concept: e.concept,
  reason: e.reason ?? null,
  voided: Boolean(e.voidedAt),
  voidedAt: e.voidedAt ?? null,
  /** Corrección: `REPLACED` = anulado y reemplazado; `REPLACEMENT` = corrige a otro. Sin el motivo interno. */
  correction: e.replacedBy ? 'REPLACED' : e.replaces ? 'REPLACEMENT' : null,
  createdAt: e.createdAt,
});
const STATEMENT_LIMIT = 50;
const conflict = (error: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ statusCode: 409, error, message, ...extra });

/**
 * Módulo 4A/4B — cuentas por equipo y torneo: cargos (también multas y la cuota de inscripción
 * generada), pagos/abonos, descuentos y devoluciones.
 * - Permisos (F3): FINANCE_VIEW para consultar y FINANCE_MANAGE para registrar (propietario y
 *   administradores). Los equipos no escriben aquí.
 * - Cada escritura va en una transacción con el cerrojo del torneo — también finalizado (F11) — y
 *   el permiso comprobado dentro. El saldo se calcula dentro de esa transacción: dos pagos
 *   simultáneos no pueden dejar la cuenta por debajo de cero.
 * - Idempotencia: el mismo `requestId` devuelve el movimiento ya creado (o 409 si el contenido es
 *   otro); un índice único lo respalda.
 * - Reglas de saldo (dentro del cerrojo): un pago que supera el adeudo solo con `allowCredit`
 *   (F5: queda saldo a favor); un descuento no supera el adeudo; una devolución no supera el
 *   saldo a favor.
 */
@Injectable()
export class FinanceService {
  constructor(
    @InjectModel(FinanceEntry.name) private readonly entries: Model<FinanceEntry>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(RemovedEnrollment.name) private readonly removed: Model<RemovedEnrollment>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
    private readonly teamAccess: TeamAccessService,
  ) {}

  async create(tournamentId: string, dto: CreateFinanceEntryDto, user: AuthUser) {
    await this.ownership.ownedTournament(tournamentId, user, Permission.FINANCE_MANAGE);
    const today = todayISODate();
    const isCharge = dto.kind === FinanceEntryKind.CHARGE;
    const shapeError = entryShapeError(dto);
    if (shapeError) throw new BadRequestException(shapeError);
    const payload = {
      teamId: dto.teamId,
      kind: dto.kind,
      amount: dto.amount,
      category: isCharge ? (dto.category ?? FinanceCategory.OTHER) : null,
      method: dto.method ?? null,
      reference: dto.reference || null,
      date: dto.date ?? today,
      concept: dto.concept,
      notes: dto.notes || null,
      reason: dto.reason || null,
      matchId: dto.matchId ?? null,
      playerId: dto.playerId ?? null,
    };
    if (payload.date > today) throw new BadRequestException('La fecha del movimiento no puede ser futura');
    const [tid, team] = [toObjectId(tournamentId), toObjectId(dto.teamId)];

    const run = () =>
      this.ownership.inAnyTournament(tournamentId, { user, permission: Permission.FINANCE_MANAGE }, async (session) => {
        const existing = await this.entries.findOne({ tournamentId: tid, requestId: dto.requestId }).session(session).lean();
        if (existing) return this.replay(existing, payload);
        await this.assertAccount(tid, team, session);
        await this.assertFineLinks(tid, team, payload.matchId, payload.playerId, session);
        const ledger = await this.entries.find({ tournamentId: tid, teamId: team }).select('kind amount voidedAt').session(session).lean();
        const before = totals(ledger);
        this.assertBalanceRules(dto, before);
        const t = await this.tournaments.findById(tid).select('information.costs.currency').session(session).lean();
        const [created] = await this.entries.create(
          [
            {
              ...payload,
              matchId: payload.matchId ? toObjectId(payload.matchId) : null,
              playerId: payload.playerId ? toObjectId(payload.playerId) : null,
              tournamentId: tid,
              teamId: team,
              currency: currencyOf(t),
              recordedBy: toObjectId(user.id),
              recordedRole: await this.access.roleOf(tid, user.id, session),
              requestId: dto.requestId,
            },
          ],
          { session },
        );
        return { entry: serialize(created.toObject()), account: totals([...ledger, created]), replayed: false };
      });
    try {
      return await run();
    } catch (e) {
      // Respaldo del índice único: otra petición con la misma clave ganó; se responde con la suya.
      if ((e as { code?: number }).code === 11000) return run();
      throw e;
    }
  }

  /** Cuentas del torneo: inscritos (también sin movimientos) y quien tenga movimientos aunque ya no esté inscrito (F7). */
  async accounts(tournamentId: string, user: AuthUser) {
    const { tournament } = await this.access.require(tournamentId, user.id, Permission.FINANCE_VIEW);
    const tid = toObjectId(tournamentId);
    const [enrolled, byTeam, breakdown] = await Promise.all([
      this.enrollments.find({ tournamentId: tid }).select('teamId withdrawnAt').lean(),
      totalsBy(this.entries, { tournamentId: tid }, '$teamId'),
      this.entries.aggregate<{ _id: { kind: string; category: string | null; method: string | null }; amount: number; entries: number }>([
        { $match: { tournamentId: tid, voidedAt: null } },
        { $group: { _id: { kind: '$kind', category: '$category', method: '$method' }, amount: { $sum: '$amount' }, entries: { $sum: 1 } } },
      ]),
    ]);
    const ids = [...new Set([...enrolled.map((e) => e.teamId.toHexString()), ...byTeam.keys()])];
    const names = new Map((await this.teams.find({ _id: { $in: ids.map(toObjectId) } }).select('name').lean()).map((t) => [t._id.toHexString(), t.name]));
    const accounts = ids
      .map((id) => {
        const e = enrolled.find((x) => x.teamId.toHexString() === id);
        return {
          teamId: id,
          teamName: names.get(id) ?? null,
          status: !e ? 'NOT_ENROLLED' : e.withdrawnAt ? 'WITHDRAWN' : 'ENROLLED',
          withdrawnAt: e?.withdrawnAt ?? null,
          ...(byTeam.get(id) ?? withBalance({ charged: 0, paid: 0, discounted: 0, refunded: 0, entries: 0 })),
        };
      })
      .sort((a, b) => (a.teamName ?? '').localeCompare(b.teamName ?? ''));
    const sum = (k: 'charged' | 'paid' | 'discounted' | 'refunded' | 'balance' | 'due' | 'credit') => accounts.reduce((n, a) => n + a[k], 0);
    const totalsOfTournament = { charged: sum('charged'), paid: sum('paid'), discounted: sum('discounted'), refunded: sum('refunded'), balance: sum('balance'), due: sum('due'), credit: sum('credit') };
    // F10: cargos por categoría y dinero recibido/devuelto por método (solo vigentes).
    const charges = breakdown.filter((b) => b._id.kind === FinanceEntryKind.CHARGE);
    const byCategory = Object.values(FinanceCategory)
      .map((category) => ({ category, amount: charges.filter((b) => b._id.category === category).reduce((n, b) => n + b.amount, 0), entries: charges.filter((b) => b._id.category === category).reduce((n, b) => n + b.entries, 0) }))
      .filter((x) => x.entries);
    const byMethod = (['PAYMENT', 'REFUND'] as const).flatMap((kind) =>
      [...new Set(breakdown.filter((b) => b._id.kind === kind).map((b) => b._id.method))].map((method) => ({
        kind,
        method,
        amount: breakdown.filter((b) => b._id.kind === kind && b._id.method === method).reduce((n, b) => n + b.amount, 0),
      })),
    );
    return { tournamentId, currency: currencyOf(tournament), totals: totalsOfTournament, byCategory, byMethod, accounts };
  }

  /**
   * Estado de cuenta (4D: paginado). Movimientos en orden cronológico (también los anulados y las
   * correcciones, marcados), totales de toda la cuenta y el saldo acumulado antes de la página.
   * Sin `page`, la última página (lo más reciente).
   */
  async account(tournamentId: string, teamId: string, query: StatementQueryDto, user: AuthUser) {
    const { tournament } = await this.access.require(tournamentId, user.id, Permission.FINANCE_VIEW);
    const [tid, team] = [toObjectId(tournamentId), toObjectId(teamId)];
    await this.assertAccount(tid, team, null);
    const filter = { tournamentId: tid, teamId: team };
    const [pageData, accountSums] = await Promise.all([statementPage(this.entries, filter, query.page, query.limit ?? STATEMENT_LIMIT), accountTotals(this.entries, filter)]);
    const { rows, ...pagination } = pageData;
    const users = await this.users.find({ _id: { $in: [...new Set(rows.flatMap((r) => [r.recordedBy, r.voidedBy]).filter(Boolean).map(String))].map(toObjectId) } }).select('firstName lastName').lean();
    return {
      tournamentId,
      teamId,
      currency: currencyOf(tournament),
      totals: accountSums,
      entries: serialize(rows),
      ...pagination,
      refs: { users: Object.fromEntries(users.map((u) => [u._id.toHexString(), `${u.firstName} ${u.lastName}`.trim()])) },
    };
  }

  /**
   * 4D — jugadores que se pueden vincular a una multa: quien está o estuvo en la plantilla del
   * equipo en el torneo, también si el equipo ya fue quitado (copia de 3E). La misma regla que
   * valida el alta (assertFineLinks).
   */
  async finePlayers(tournamentId: string, teamId: string, user: AuthUser) {
    await this.access.require(tournamentId, user.id, Permission.FINANCE_MANAGE);
    const [tid, team] = [toObjectId(tournamentId), toObjectId(teamId)];
    await this.assertAccount(tid, team, null);
    const [current, removed] = await Promise.all([
      this.memberships.distinct('playerId', { tournamentId: tid, teamId: team }),
      this.removed.find({ tournamentId: tid, teamId: team }).select('memberships.playerId').lean(),
    ]);
    const ids = new Set([...current.map(String), ...removed.flatMap((r) => r.memberships.map((m) => String(m.playerId)))]);
    const players = await this.players.find({ _id: { $in: [...ids].map(toObjectId) } }).select('firstName lastName').lean();
    return {
      players: players
        .map((p) => ({ id: p._id.toHexString(), name: `${p.firstName} ${p.lastName}`.trim(), current: current.some((c) => String(c) === p._id.toHexString()) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /**
   * 4D (F6) — anular: el movimiento queda en el libro con autor, rol, fecha y motivo, y deja de
   * contar en el saldo. Atómico y dentro del cerrojo: dos anulaciones simultáneas producen una sola
   * (la otra: 409 ENTRY_ALREADY_VOIDED); la misma clave repetida devuelve la misma anulación. Se
   * rechaza si deja la cuenta inválida (descuentos sin cargo, devoluciones sin pago) o si crea
   * saldo a favor sin confirmarlo (ledgerRewriteError).
   */
  async voidEntry(tournamentId: string, entryId: string, dto: VoidFinanceEntryDto, user: AuthUser) {
    await this.ownership.ownedTournament(tournamentId, user, Permission.FINANCE_MANAGE);
    const tid = toObjectId(tournamentId);
    return this.ownership.inAnyTournament(tournamentId, { user, permission: Permission.FINANCE_MANAGE }, async (session) => {
      const original = await this.liveEntry(tid, entryId, dto.requestId, session);
      if ('replayed' in original) return original;
      const ledger = await this.entries.find({ tournamentId: tid, teamId: original.teamId }).select('kind amount voidedAt').session(session).lean();
      this.assertRewrite(ledgerRewriteError(ledger, entryId, null, Boolean(dto.allowCredit)));
      const voided = await this.markVoided(original._id, dto.requestId, dto.reason, null, tid, user, session);
      return { entry: serialize(voided), account: totals(ledger.map((e) => (String(e._id) === entryId ? { ...e, voidedAt: new Date() } : e))), replayed: false };
    });
  }

  /**
   * 4D (F6) — corregir = anular el original y registrar el reemplazo, enlazados (`replaces` /
   * `replacedBy`), en UNA transacción: o pasan las dos cosas o ninguna. Mismo equipo y moneda.
   * Idempotente por `requestId` (la clave del reemplazo; el índice único lo respalda).
   */
  async correct(tournamentId: string, entryId: string, dto: CorrectFinanceEntryDto, user: AuthUser) {
    await this.ownership.ownedTournament(tournamentId, user, Permission.FINANCE_MANAGE);
    const r = dto.entry;
    const shapeError = entryShapeError(r);
    if (shapeError) throw new BadRequestException(shapeError);
    const today = todayISODate();
    if (r.date && r.date > today) throw new BadRequestException('La fecha del movimiento no puede ser futura');
    const tid = toObjectId(tournamentId);
    const run = () =>
      this.ownership.inAnyTournament(tournamentId, { user, permission: Permission.FINANCE_MANAGE }, async (session) => {
        const done = await this.entries.findOne({ tournamentId: tid, requestId: dto.requestId }).session(session).lean();
        if (done) {
          if (String(done.replaces) !== entryId) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Esta clave de solicitud ya se usó para otro movimiento');
          return { voided: serialize(await this.entries.findById(done.replaces).session(session).lean()), entry: serialize(done), account: null, replayed: true };
        }
        const original = await this.liveEntry(tid, entryId, null, session);
        if ('replayed' in original) return original;
        // 5B: un vínculo que conserva el del original ya se validó al registrarlo; se respeta aunque
        // hoy ya no exista (jugador o partido borrados antes de 5B). Solo se valida lo que cambia.
        const kept = (next: string | null | undefined, before: Types.ObjectId | null | undefined) => !!next && sameId(next, before);
        await this.assertFineLinks(
          tid,
          original.teamId,
          kept(r.matchId, original.matchId) ? null : (r.matchId ?? null),
          kept(r.playerId, original.playerId) ? null : (r.playerId ?? null),
          session,
        );
        const ledger = await this.entries.find({ tournamentId: tid, teamId: original.teamId }).select('kind amount voidedAt').session(session).lean();
        this.assertRewrite(ledgerRewriteError(ledger, entryId, { kind: r.kind, amount: r.amount }, Boolean(dto.allowCredit)));
        const _id = new Types.ObjectId();
        const voided = await this.markVoided(original._id, dto.requestId, dto.reason, _id, tid, user, session);
        const [created] = await this.entries.create(
          [
            {
              _id,
              tournamentId: tid,
              teamId: original.teamId,
              kind: r.kind,
              amount: r.amount,
              category: r.kind === FinanceEntryKind.CHARGE ? (r.category ?? FinanceCategory.OTHER) : null,
              method: r.method ?? null,
              reference: r.reference || null,
              date: r.date ?? today,
              concept: r.concept,
              notes: r.notes || null,
              reason: r.reason || null,
              matchId: r.matchId ? toObjectId(r.matchId) : null,
              playerId: r.playerId ? toObjectId(r.playerId) : null,
              currency: original.currency,
              recordedBy: toObjectId(user.id),
              recordedRole: await this.access.roleOf(tid, user.id, session),
              requestId: dto.requestId,
              replaces: original._id,
            },
          ],
          { session },
        );
        const after = totals([...ledger.map((e) => (String(e._id) === entryId ? { ...e, voidedAt: new Date() } : e)), created]);
        return { voided: serialize(voided), entry: serialize(created.toObject()), account: after, replayed: false };
      });
    try {
      return await run();
    } catch (e) {
      if ((e as { code?: number }).code === 11000) return run();
      throw e;
    }
  }

  /**
   * 4C (F3b) — estados de cuenta del EQUIPO, en solo lectura: uno por torneo donde tenga movimientos.
   * Solo su propietario o sus delegados (OWNER/MANAGER; el custodio y el organizador no entran por
   * aquí). Nunca expone notas internas, autores, roles, claves de solicitud ni datos de otros equipos.
   */
  async teamStatements(teamId: string, user: AuthUser) {
    const { team } = await this.teamAccess.requireManager(teamId, user);
    const byTournament = await totalsBy(this.entries, { teamId: team._id }, '$tournamentId');
    // También torneos donde todo quedó anulado: la cuenta existe aunque sume cero.
    const ids = (await this.entries.distinct('tournamentId', { teamId: team._id })).map(String);
    const tournaments = await this.tournaments.find({ _id: { $in: ids.map(toObjectId) } }).select('name status startDate information.costs.currency').lean();
    return {
      teamId,
      accounts: tournaments
        .map((t) => ({
          tournament: { id: t._id.toHexString(), name: t.name, status: t.status, startDate: t.startDate ?? null },
          currency: currencyOf(t),
          totals: byTournament.get(t._id.toHexString()) ?? withBalance({ charged: 0, paid: 0, discounted: 0, refunded: 0, entries: 0 }),
        }))
        .sort((a, b) => String(b.tournament.startDate ?? '').localeCompare(String(a.tournament.startDate ?? ''))),
    };
  }

  /** 4D — una página del estado de cuenta del equipo en un torneo (solo lectura, sin datos internos). */
  async teamStatement(teamId: string, tournamentId: string, query: StatementQueryDto, user: AuthUser) {
    const { team } = await this.teamAccess.requireManager(teamId, user);
    const tid = toObjectId(tournamentId);
    const filter = { tournamentId: tid, teamId: team._id };
    const t = await this.tournaments.findById(tid).select('name status information.costs.currency').lean();
    if (!t || !(await this.entries.exists(filter))) throw new NotFoundException('El equipo no tiene movimientos en este torneo');
    const [pageData, accountSums] = await Promise.all([statementPage(this.entries, filter, query.page, query.limit ?? STATEMENT_LIMIT), accountTotals(this.entries, filter)]);
    const { rows, ...pagination } = pageData;
    return { team: { id: teamId, name: team.name }, tournament: { id: tournamentId, name: t.name, status: t.status }, currency: currencyOf(t), totals: accountSums, entries: rows.map(TEAM_VISIBLE), ...pagination };
  }

  /**
   * 4B (F1) — cargo de inscripción para cada equipo inscrito y no retirado que aún no tenga uno
   * vigente (cargo ENROLLMENT no anulado, generado o manual). Idempotente: repetirlo solo crea los
   * que faltan (equipos inscritos después). Dentro del cerrojo: dos generaciones simultáneas no
   * duplican. El importe se congela en el cargo: cambiar la cuota después no toca los existentes.
   */
  async generateEnrollmentCharges(tournamentId: string, dto: GenerateEnrollmentChargesDto, user: AuthUser) {
    await this.ownership.ownedTournament(tournamentId, user, Permission.FINANCE_MANAGE);
    const today = todayISODate();
    const date = dto.date ?? today;
    if (date > today) throw new BadRequestException('La fecha del movimiento no puede ser futura');
    const tid = toObjectId(tournamentId);
    return this.ownership.inAnyTournament(tournamentId, { user, permission: Permission.FINANCE_MANAGE }, async (session) => {
      const t = await this.tournaments.findById(tid).select('information.enrollment information.costs.currency').session(session).lean();
      const fee = enrollmentFeeCents(t?.information?.enrollment);
      if (!fee) throw conflict('NO_ENROLLMENT_FEE', 'El torneo no tiene una cuota de inscripción por equipo configurada');
      const enrolled = await this.enrollments.find({ tournamentId: tid, withdrawnAt: null }).select('teamId').session(session).lean();
      const charged = new Set(
        (await this.entries.distinct('teamId', { tournamentId: tid, kind: FinanceEntryKind.CHARGE, category: FinanceCategory.ENROLLMENT, voidedAt: null }).session(session)).map(String),
      );
      const pending = enrolled.filter((e) => !charged.has(e.teamId.toHexString()));
      const base = { tournamentId: tid, kind: FinanceEntryKind.CHARGE, category: FinanceCategory.ENROLLMENT, amount: fee, currency: currencyOf(t), date, concept: 'Inscripción' };
      const meta = { recordedBy: toObjectId(user.id), recordedRole: await this.access.roleOf(tid, user.id, session) };
      const created = pending.length ? await this.entries.create(pending.map((e) => ({ ...base, ...meta, teamId: e.teamId, requestId: randomUUID() })), { session, ordered: true }) : [];
      return {
        amount: fee,
        currency: currencyOf(t),
        created: serialize(created.map((c) => c.toObject())),
        alreadyCharged: enrolled.filter((e) => charged.has(e.teamId.toHexString())).map((e) => e.teamId.toHexString()),
      };
    });
  }

  /** Reglas de saldo (F4/F5), con el saldo leído dentro del cerrojo. */
  private assertBalanceRules(dto: CreateFinanceEntryDto, before: ReturnType<typeof totals>) {
    const amounts = { balance: before.balance, due: before.due, credit: before.credit };
    if (dto.kind === FinanceEntryKind.PAYMENT && dto.amount > before.due && !dto.allowCredit) {
      throw conflict('PAYMENT_EXCEEDS_BALANCE', before.due > 0 ? 'El pago supera el adeudo pendiente del equipo: confirma el saldo a favor' : 'El equipo no tiene adeudo pendiente: confirma el saldo a favor', {
        ...amounts,
        creditWouldBe: before.credit + dto.amount - before.due,
      });
    }
    if (dto.kind === FinanceEntryKind.DISCOUNT && dto.amount > before.due) {
      throw conflict('DISCOUNT_EXCEEDS_BALANCE', 'El descuento no puede superar el adeudo pendiente', amounts);
    }
    if (dto.kind === FinanceEntryKind.REFUND && dto.amount > before.credit) {
      throw conflict('REFUND_EXCEEDS_CREDIT', 'La devolución no puede superar el saldo a favor del equipo', amounts);
    }
  }

  /** Multa vinculada (F2): el partido es del torneo y lo jugó el equipo; el jugador está o estuvo en su plantilla aquí. */
  private async assertFineLinks(tournamentId: Types.ObjectId, teamId: Types.ObjectId, matchId: string | null, playerId: string | null, session: ClientSession) {
    if (matchId) {
      const played = await this.matches.exists({ _id: toObjectId(matchId), tournamentId, $or: [{ homeTeamId: teamId }, { awayTeamId: teamId }] }).session(session);
      if (!played) throw conflict('FINE_MATCH_INVALID', 'El partido no es de este torneo o el equipo no lo jugó');
    }
    if (playerId) {
      const pid = toObjectId(playerId);
      const inRoster =
        (await this.memberships.exists({ tournamentId, teamId, playerId: pid }).session(session)) ||
        (await this.removed.exists({ tournamentId, teamId, 'memberships.playerId': pid }).session(session));
      if (!inRoster) throw conflict('FINE_PLAYER_INVALID', 'El jugador no está ni estuvo en la plantilla del equipo en este torneo');
    }
  }

  /** Movimiento vigente del torneo; ya anulado con la misma clave → la anulación ya hecha (replay); si no, 409. */
  private async liveEntry(tid: Types.ObjectId, entryId: string, requestId: string | null, session: ClientSession) {
    const entry = await this.entries.findOne({ _id: toObjectId(entryId), tournamentId: tid }).session(session).lean();
    if (!entry) throw new NotFoundException('Movimiento no encontrado en este torneo');
    if (entry.voidedAt) {
      if (requestId && entry.voidRequestId === requestId) return { entry: serialize(entry), account: null, replayed: true as const };
      throw conflict('ENTRY_ALREADY_VOIDED', 'Este movimiento ya está anulado', { voidedAt: entry.voidedAt });
    }
    return entry;
  }

  /** Marca la anulación solo si sigue vigente (respaldo atómico además del cerrojo). */
  private async markVoided(id: Types.ObjectId, requestId: string, reason: string, replacedBy: Types.ObjectId | null, tid: Types.ObjectId, user: AuthUser, session: ClientSession) {
    const voided = await this.entries
      .findOneAndUpdate(
        { _id: id, voidedAt: null },
        { $set: { voidedAt: new Date(), voidedBy: toObjectId(user.id), voidedRole: await this.access.roleOf(tid, user.id, session), voidReason: reason, voidRequestId: requestId, replacedBy } },
        { returnDocument: 'after', session },
      )
      .lean();
    if (!voided) throw conflict('ENTRY_ALREADY_VOIDED', 'Este movimiento ya está anulado');
    return voided;
  }

  private assertRewrite(error: ReturnType<typeof ledgerRewriteError>) {
    if (error) throw conflict(error.code, error.message, error.extra);
  }

  /** Mismo `requestId`: el mismo contenido devuelve lo ya creado; otro contenido es un error del cliente. */
  private replay(existing: FinanceEntry & { _id: Types.ObjectId }, payload: Record<(typeof PAYLOAD)[number], unknown>) {
    const same = PAYLOAD.every((k) => String((existing as unknown as Record<string, unknown>)[k] ?? null) === String(payload[k] ?? null));
    if (!same) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', 'Esta clave de solicitud ya se usó para otro movimiento');
    }
    return { entry: serialize(existing), account: null, replayed: true };
  }

  /**
   * La cuenta existe si el equipo está inscrito (también retirado), fue quitado del torneo (3E) o ya
   * tiene movimientos aquí (F7). Si no: 404 (equipo inexistente) o 409 TEAM_NOT_IN_TOURNAMENT.
   */
  private async assertAccount(tournamentId: Types.ObjectId, teamId: Types.ObjectId, session: ClientSession | null) {
    const filter = { tournamentId, teamId };
    // En serie: dentro de una transacción no se lanzan operaciones en paralelo sobre la misma sesión.
    if (await this.enrollments.exists(filter).session(session)) return;
    if (await this.removed.exists(filter).session(session)) return;
    if (await this.entries.exists(filter).session(session)) return;
    if (!(await this.teams.exists({ _id: teamId }).session(session))) throw new NotFoundException(`Equipo ${teamId.toHexString()} no encontrado`);
    throw conflict('TEAM_NOT_IN_TOURNAMENT', 'El equipo no participa ni participó en este torneo');
  }
}
