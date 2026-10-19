import type { QueryFilter, Model, Types } from 'mongoose';
import type { FinanceEntry } from './schemas/finance-entry.schema.js';
import { FinanceCategory, FinanceEntryKind, withBalance, type AccountTotals, type PaymentMethod } from './finance.js';
import { toObjectId } from '../../common/utils/serialize.js';

/**
 * 4D — consultas del libro que comparten pantalla, estado de cuenta, vista del equipo y CSV. Todo
 * se agrega en Mongo (nunca se carga el historial completo para sumar), con los índices
 * `{tournamentId, teamId, date, createdAt, _id}` y `{tournamentId, date, createdAt, _id}`.
 */

/** Orden cronológico estable del libro (el mismo en pantalla, impresión y CSV). */
export const ENTRY_ORDER = { date: 1, createdAt: 1, _id: 1 } as const;

const sumOf = (kind: FinanceEntryKind) => ({ $sum: { $cond: [{ $eq: ['$kind', kind] }, '$amount', 0] } });
/** Sumas por tipo de los movimientos NO anulados (para un `$group`). */
export const SUMS = {
  charged: sumOf(FinanceEntryKind.CHARGE),
  paid: sumOf(FinanceEntryKind.PAYMENT),
  discounted: sumOf(FinanceEntryKind.DISCOUNT),
  refunded: sumOf(FinanceEntryKind.REFUND),
  entries: { $sum: 1 },
};
type Sums = { charged: number; paid: number; discounted: number; refunded: number; entries: number };
const ZERO: Sums = { charged: 0, paid: 0, discounted: 0, refunded: 0, entries: 0 };

/** Efecto con signo en el saldo; 0 si está anulado. */
const SIGNED = {
  $cond: [
    { $ne: [{ $ifNull: ['$voidedAt', null] }, null] }, // un campo ausente cuenta como no anulado
    0,
    { $multiply: ['$amount', { $cond: [{ $in: ['$kind', [FinanceEntryKind.CHARGE, FinanceEntryKind.REFUND]] }, 1, -1] }] },
  ],
};

export async function accountTotals(model: Model<FinanceEntry>, filter: QueryFilter<FinanceEntry>): Promise<AccountTotals> {
  const [row] = await model.aggregate<Sums>([{ $match: { ...filter, voidedAt: null } }, { $group: { _id: null, ...SUMS } }]);
  return withBalance(row ?? ZERO);
}

/** Totales por grupo (equipo o torneo) en una sola agregación. */
export async function totalsBy(model: Model<FinanceEntry>, filter: QueryFilter<FinanceEntry>, key: '$teamId' | '$tournamentId') {
  const rows = await model.aggregate<Sums & { _id: Types.ObjectId }>([{ $match: { ...filter, voidedAt: null } }, { $group: { _id: key, ...SUMS } }]);
  return new Map(rows.map((r) => [r._id.toHexString(), withBalance(r)]));
}

export interface StatementPage {
  rows: (FinanceEntry & { _id: Types.ObjectId })[];
  page: number;
  pages: number;
  limit: number;
  total: number;
  /** Saldo acumulado ANTES del primer movimiento de la página: así el saldo por renglón cuadra en cualquier página. */
  openingBalance: number;
}

/**
 * Una página del estado de cuenta en orden cronológico. Sin `page`, la última (lo más reciente).
 * El saldo inicial se agrega en Mongo sobre los movimientos anteriores a la página.
 */
export async function statementPage(model: Model<FinanceEntry>, filter: QueryFilter<FinanceEntry>, page: number | undefined, limit: number): Promise<StatementPage> {
  const total = await model.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / limit));
  const current = Math.min(Math.max(1, page ?? pages), pages);
  const skip = (current - 1) * limit;
  const [rows, opening] = await Promise.all([
    model.find(filter).sort(ENTRY_ORDER).skip(skip).limit(limit).lean(),
    skip
      ? model.aggregate<{ balance: number }>([{ $match: filter }, { $sort: ENTRY_ORDER }, { $limit: skip }, { $group: { _id: null, balance: { $sum: SIGNED } } }])
      : Promise.resolve([]),
  ]);
  return { rows: rows as StatementPage['rows'], page: current, pages, limit, total, openingBalance: opening[0]?.balance ?? 0 };
}

export interface EntriesFilter {
  teamId?: string;
  kind?: FinanceEntryKind | 'FINE';
  method?: PaymentMethod;
  from?: string;
  to?: string;
  status?: 'active' | 'voided' | 'all';
}

/** Filtros del listado y de la exportación. `FINE` = cargos de categoría multa. */
export function entriesFilter(tournamentId: Types.ObjectId, q: EntriesFilter): QueryFilter<FinanceEntry> {
  const filter: QueryFilter<FinanceEntry> = { tournamentId };
  if (q.teamId) filter.teamId = toObjectId(q.teamId);
  if (q.kind === 'FINE') Object.assign(filter, { kind: FinanceEntryKind.CHARGE, category: FinanceCategory.FINE });
  else if (q.kind) filter.kind = q.kind;
  if (q.method) filter.method = q.method;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.status === 'active') filter.voidedAt = null;
  if (q.status === 'voided') filter.voidedAt = { $ne: null };
  return filter;
}
