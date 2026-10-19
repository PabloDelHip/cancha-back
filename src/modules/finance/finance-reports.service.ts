import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FinanceEntry } from './schemas/finance-entry.schema.js';
import { FinanceService } from './finance.service.js';
import { entriesFilter, ENTRY_ORDER } from './finance-queries.js';
import { csvMoney, csvRaw, csvText, toCsv } from './finance-csv.js';
import { FinanceCategory, FinanceEntryKind, SIGN } from './finance.js';
import { Team } from '../teams/schemas/team.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { serialize, toObjectId } from '../../common/utils/serialize.js';
import type { FinanceEntriesQueryDto } from './dto/finance.dto.js';
import type { AuthUser } from '../auth/auth.types.js';

/** Tope de filas de una exportación (con el volumen del dominio no se alcanza; protege al servidor). */
export const EXPORT_MAX_ROWS = 50_000;

const KIND_LABEL: Record<FinanceEntryKind, string> = { CHARGE: 'Cargo', PAYMENT: 'Pago', DISCOUNT: 'Descuento', REFUND: 'Devolución' };
const CATEGORY_LABEL: Record<FinanceCategory, string> = { ENROLLMENT: 'Inscripción', PLAYER_FEE: 'Cuota por jugador', REFEREE: 'Arbitraje', FINE: 'Multa', OTHER: 'Otro' };
const METHOD_LABEL: Record<string, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', CARD: 'Tarjeta', OTHER: 'Otro' };
const ROLE_LABEL: Record<string, string> = { OWNER: 'Propietario', ADMIN: 'Administrador', COORDINATOR: 'Coordinador', SCORER: 'Anotador' };
const STATUS_LABEL: Record<string, string> = { ENROLLED: 'Inscrito', WITHDRAWN: 'Retirado', NOT_ENROLLED: 'Ya no inscrito' };

/**
 * 4D (F10) — reportes del torneo: listado de movimientos con filtros (paginado) y exportaciones CSV
 * de movimientos y de saldos. Solo FINANCE_VIEW. Los saldos salen de la MISMA agregación que la
 * pantalla (FinanceService.accounts) y los movimientos del mismo filtro que el listado: lo que se
 * ve y lo que se exporta cuadra. Sin facturas ni comprobantes fiscales.
 */
@Injectable()
export class FinanceReportsService {
  constructor(
    @InjectModel(FinanceEntry.name) private readonly entries: Model<FinanceEntry>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly finance: FinanceService,
    private readonly access: TournamentAccessService,
  ) {}

  /** Movimientos del torneo con filtros, del más reciente al más antiguo. */
  async list(tournamentId: string, q: FinanceEntriesQueryDto, user: AuthUser) {
    await this.access.require(tournamentId, user.id, Permission.FINANCE_VIEW);
    this.assertPeriod(q);
    const filter = entriesFilter(toObjectId(tournamentId), q);
    const limit = q.limit ?? 50;
    const total = await this.entries.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(q.page ?? 1, pages);
    const rows = await this.entries.find(filter).sort({ date: -1, createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean();
    // Suma de lo filtrado (vigentes): cuadra con el CSV de los mismos filtros.
    const [sums] = await this.entries.aggregate<{ charges: number; credits: number }>([
      { $match: { ...filter, voidedAt: null } },
      { $group: { _id: null, charges: { $sum: { $cond: [{ $in: ['$kind', [FinanceEntryKind.CHARGE, FinanceEntryKind.REFUND]] }, '$amount', 0] } }, credits: { $sum: { $cond: [{ $in: ['$kind', [FinanceEntryKind.PAYMENT, FinanceEntryKind.DISCOUNT]] }, '$amount', 0] } } } },
    ]);
    const refs = await this.refs(rows);
    return { data: serialize(rows), page, pages, limit, total, sums: { charges: sums?.charges ?? 0, credits: sums?.credits ?? 0 }, refs };
  }

  /** CSV de movimientos con los mismos filtros que el listado, en orden cronológico. */
  async entriesCsv(tournamentId: string, q: FinanceEntriesQueryDto, user: AuthUser) {
    const { tournament } = await this.access.require(tournamentId, user.id, Permission.FINANCE_VIEW);
    this.assertPeriod(q);
    const filter = entriesFilter(toObjectId(tournamentId), q);
    const total = await this.entries.countDocuments(filter);
    if (total > EXPORT_MAX_ROWS) throw new BadRequestException(`La exportación tiene ${total} movimientos; filtra por periodo o equipo (máximo ${EXPORT_MAX_ROWS})`);
    const rows = await this.entries.find(filter).sort(ENTRY_ORDER).lean();
    const { teams, users } = await this.refs(rows);
    const header = ['Fecha', 'Equipo', 'Movimiento', 'Categoría', 'Concepto', 'Motivo', 'Método', 'Referencia', 'Cargo', 'Abono', 'Moneda', 'Estado', 'Anulado el', 'Motivo de anulación', 'Corrección', 'Registró', 'Rol', 'Registrado el', 'Nota interna', 'ID'];
    const body = rows.map((e) => {
      const up = SIGN[e.kind] > 0;
      return [
        csvRaw(e.date),
        csvText(teams[e.teamId.toHexString()] ?? ''),
        csvRaw(e.kind === FinanceEntryKind.CHARGE && e.category === FinanceCategory.FINE ? 'Multa' : KIND_LABEL[e.kind]),
        csvRaw(e.category ? CATEGORY_LABEL[e.category] : ''),
        csvText(e.concept),
        csvText(e.reason),
        csvRaw(e.method ? METHOD_LABEL[e.method] : ''),
        csvText(e.reference),
        csvRaw(up ? csvMoney(e.amount) : ''),
        csvRaw(up ? '' : csvMoney(e.amount)),
        csvRaw(e.currency),
        csvRaw(e.voidedAt ? 'Anulado' : 'Vigente'),
        csvRaw(e.voidedAt ? e.voidedAt.toISOString() : ''),
        csvText(e.voidReason),
        csvRaw(e.replacedBy ? `Reemplazado por ${e.replacedBy.toHexString()}` : e.replaces ? `Corrige a ${e.replaces.toHexString()}` : ''),
        csvText(users[e.recordedBy.toHexString()] ?? ''),
        csvRaw(e.recordedRole ? (ROLE_LABEL[e.recordedRole] ?? e.recordedRole) : ''),
        csvRaw(e.createdAt?.toISOString() ?? ''),
        csvText(e.notes),
        csvRaw(e._id.toHexString()),
      ];
    });
    return { filename: `movimientos-${slug(tournament.name)}.csv`, content: toCsv(header, body) };
  }

  /** CSV de saldos por equipo: exactamente las cuentas y totales de la pantalla, más una fila TOTAL. */
  async balancesCsv(tournamentId: string, user: AuthUser) {
    const data = await this.finance.accounts(tournamentId, user);
    const header = ['Equipo', 'Inscripción', 'Cargado', 'Pagado', 'Descuentos', 'Devoluciones', 'Saldo', 'Adeudo', 'Saldo a favor', 'Movimientos vigentes', 'Moneda'];
    const row = (name: string, status: string, a: { charged: number; paid: number; discounted: number; refunded: number; balance: number; due: number; credit: number }, entries: number | string) =>
      [csvText(name), csvRaw(status), ...[a.charged, a.paid, a.discounted, a.refunded, a.balance, a.due, a.credit].map((n) => csvRaw(csvMoney(n))), csvRaw(entries), csvRaw(data.currency)];
    const body = data.accounts.map((a) => row(a.teamName ?? '', STATUS_LABEL[a.status] ?? a.status, a, a.entries));
    body.push(row('TOTAL', '', data.totals, data.accounts.reduce((n, a) => n + a.entries, 0)));
    const t = await this.access.require(tournamentId, user.id, Permission.FINANCE_VIEW);
    return { filename: `saldos-${slug(t.tournament.name)}.csv`, content: toCsv(header, body) };
  }

  private assertPeriod(q: FinanceEntriesQueryDto) {
    if (q.from && q.to && q.from > q.to) throw new BadRequestException('El periodo es inválido: «desde» es posterior a «hasta»');
  }

  /** Nombres de equipos y autores de las filas. */
  private async refs(rows: { teamId: Types.ObjectId; recordedBy: Types.ObjectId; voidedBy?: Types.ObjectId | null }[]) {
    const teamIds = [...new Set(rows.map((r) => r.teamId.toHexString()))];
    const userIds = [...new Set(rows.flatMap((r) => [r.recordedBy, r.voidedBy]).filter(Boolean).map(String))];
    const [teams, users] = await Promise.all([
      this.teams.find({ _id: { $in: teamIds.map(toObjectId) } }).select('name').lean(),
      this.users.find({ _id: { $in: userIds.map(toObjectId) } }).select('firstName lastName').lean(),
    ]);
    return {
      teams: Object.fromEntries(teams.map((t) => [t._id.toHexString(), t.name])),
      users: Object.fromEntries(users.map((u) => [u._id.toHexString(), `${u.firstName} ${u.lastName}`.trim()])),
    };
  }
}

/** Nombre de archivo ASCII seguro. */
const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'torneo';
