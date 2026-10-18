import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { FinanceEntry } from './schemas/finance-entry.schema.js';
import { randomUUID } from 'node:crypto';
import { FinanceCategory, FinanceEntryKind, enrollmentFeeCents, entryShapeError, totals, withBalance } from './finance.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { RemovedEnrollment } from '../tournaments/schemas/removed-enrollment.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import { todayISODate } from '../../common/utils/dates.js';
import type { CreateFinanceEntryDto, GenerateEnrollmentChargesDto } from './dto/finance.dto.js';
import type { AuthUser } from '../auth/auth.types.js';

/** Moneda del torneo (F8): la de su información; MXN si nunca se configuró. */
const currencyOf = (t: { information?: { costs?: { currency?: string | null } | null } | null } | null) => t?.information?.costs?.currency || 'MXN';
const PAYLOAD = ['teamId', 'kind', 'amount', 'category', 'method', 'reference', 'date', 'concept', 'notes', 'reason', 'matchId', 'playerId'] as const;
const sumOf = (kind: FinanceEntryKind) => ({ $sum: { $cond: [{ $eq: ['$kind', kind] }, '$amount', 0] } });
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
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
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
    const [enrolled, sums] = await Promise.all([
      this.enrollments.find({ tournamentId: tid }).select('teamId withdrawnAt').lean(),
      this.entries.aggregate<{ _id: Types.ObjectId; charged: number; paid: number; discounted: number; refunded: number; entries: number }>([
        { $match: { tournamentId: tid, voidedAt: null } },
        {
          $group: {
            _id: '$teamId',
            charged: sumOf(FinanceEntryKind.CHARGE),
            paid: sumOf(FinanceEntryKind.PAYMENT),
            discounted: sumOf(FinanceEntryKind.DISCOUNT),
            refunded: sumOf(FinanceEntryKind.REFUND),
            entries: { $sum: 1 },
          },
        },
      ]),
    ]);
    const byTeam = new Map(sums.map((s) => [s._id.toHexString(), s]));
    const ids = [...new Set([...enrolled.map((e) => e.teamId.toHexString()), ...byTeam.keys()])];
    const names = new Map((await this.teams.find({ _id: { $in: ids.map(toObjectId) } }).select('name').lean()).map((t) => [t._id.toHexString(), t.name]));
    const accounts = ids
      .map((id) => {
        const e = enrolled.find((x) => x.teamId.toHexString() === id);
        const s = byTeam.get(id) ?? { charged: 0, paid: 0, discounted: 0, refunded: 0, entries: 0 };
        return {
          teamId: id,
          teamName: names.get(id) ?? null,
          status: !e ? 'NOT_ENROLLED' : e.withdrawnAt ? 'WITHDRAWN' : 'ENROLLED',
          withdrawnAt: e?.withdrawnAt ?? null,
          ...withBalance(s),
        };
      })
      .sort((a, b) => (a.teamName ?? '').localeCompare(b.teamName ?? ''));
    const sum = (k: 'charged' | 'paid' | 'discounted' | 'refunded' | 'balance' | 'due' | 'credit') => accounts.reduce((n, a) => n + a[k], 0);
    const totalsOfTournament = { charged: sum('charged'), paid: sum('paid'), discounted: sum('discounted'), refunded: sum('refunded'), balance: sum('balance'), due: sum('due'), credit: sum('credit') };
    return { tournamentId, currency: currencyOf(tournament), totals: totalsOfTournament, accounts };
  }

  /** Movimientos de una cuenta (también los anulados, marcados) con sus totales y autores. */
  async account(tournamentId: string, teamId: string, user: AuthUser) {
    const { tournament } = await this.access.require(tournamentId, user.id, Permission.FINANCE_VIEW);
    const [tid, team] = [toObjectId(tournamentId), toObjectId(teamId)];
    await this.assertAccount(tid, team, null);
    const rows = await this.entries.find({ tournamentId: tid, teamId: team }).sort({ date: 1, createdAt: 1, _id: 1 }).lean();
    const users = await this.users.find({ _id: { $in: [...new Set(rows.flatMap((r) => [r.recordedBy, r.voidedBy]).filter(Boolean).map(String))].map(toObjectId) } }).select('firstName lastName').lean();
    return {
      tournamentId,
      teamId,
      currency: currencyOf(tournament),
      totals: totals(rows),
      entries: serialize(rows),
      refs: { users: Object.fromEntries(users.map((u) => [u._id.toHexString(), `${u.firstName} ${u.lastName}`.trim()])) },
    };
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
