/**
 * Módulo 4 — reglas puras del libro financiero (sin base de datos).
 * Saldo = cargos − pagos − descuentos + devoluciones de los movimientos NO anulados.
 * Positivo = adeudo; negativo = saldo a favor (F4); 0 = al corriente. Todo en centavos enteros.
 */
export enum FinanceEntryKind {
  CHARGE = 'CHARGE',
  PAYMENT = 'PAYMENT',
  /** 4B: descuento o bonificación (reduce el adeudo; nunca crea saldo a favor). */
  DISCOUNT = 'DISCOUNT',
  /** 4B: dinero devuelto al equipo (reduce el saldo a favor; nunca lo supera). */
  REFUND = 'REFUND',
}

export enum FinanceCategory {
  ENROLLMENT = 'ENROLLMENT',
  PLAYER_FEE = 'PLAYER_FEE',
  REFEREE = 'REFEREE',
  /** 4B: multa manual (F2), con motivo y vínculo opcional a partido o jugador. */
  FINE = 'FINE',
  OTHER = 'OTHER',
}

export enum PaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  CARD = 'CARD',
  OTHER = 'OTHER',
}

/** Tope por movimiento: 1 000 000 000 en unidades de la moneda (el mismo de la información del torneo). */
export const MAX_AMOUNT_CENTS = 100_000_000_000;

export interface LedgerEntry {
  kind: FinanceEntryKind | string;
  amount: number;
  voidedAt?: Date | string | null;
}

export interface AccountTotals {
  charged: number;
  paid: number;
  discounted: number;
  refunded: number;
  /** charged − paid − discounted + refunded: positivo = adeudo, negativo = saldo a favor. */
  balance: number;
  /** Adeudo pendiente (≥ 0). */
  due: number;
  /** Saldo a favor disponible (≥ 0). */
  credit: number;
  entries: number;
}

const FIELD = { CHARGE: 'charged', PAYMENT: 'paid', DISCOUNT: 'discounted', REFUND: 'refunded' } as const;

/** Totales a partir de las sumas por tipo (también las de una agregación). */
export function withBalance(s: Pick<AccountTotals, 'charged' | 'paid' | 'discounted' | 'refunded' | 'entries'>): AccountTotals {
  const balance = s.charged - s.paid - s.discounted + s.refunded;
  return { charged: s.charged, paid: s.paid, discounted: s.discounted, refunded: s.refunded, entries: s.entries, balance, due: Math.max(balance, 0), credit: Math.max(-balance, 0) };
}

export function totals(entries: LedgerEntry[]): AccountTotals {
  const sums = { charged: 0, paid: 0, discounted: 0, refunded: 0, entries: 0 };
  for (const e of entries) {
    if (e.voidedAt) continue;
    const field = FIELD[e.kind as FinanceEntryKind];
    if (!field) continue;
    sums.entries++;
    sums[field] += e.amount;
  }
  return withBalance(sums);
}

/** Cuota de inscripción del torneo (unidades con hasta 2 decimales) en centavos; null si no hay cuota. */
export function enrollmentFeeCents(enrollment: { teamFee?: number | null; paymentMode?: string | null } | null | undefined): number | null {
  if (!enrollment || enrollment.paymentMode === 'free' || !enrollment.teamFee || enrollment.teamFee <= 0) return null;
  return Math.round(enrollment.teamFee * 100);
}

export interface EntryInput {
  kind: FinanceEntryKind;
  category?: FinanceCategory | null;
  method?: PaymentMethod | null;
  reason?: string | null;
  matchId?: string | null;
  playerId?: string | null;
  allowCredit?: boolean;
}

/** Coherencia de los campos según el tipo de movimiento: el mensaje del 400, o null si es válido. */
export function entryShapeError(e: EntryInput): string | null {
  const isCharge = e.kind === FinanceEntryKind.CHARGE;
  const movesMoney = e.kind === FinanceEntryKind.PAYMENT || e.kind === FinanceEntryKind.REFUND;
  if (e.category && !isCharge) return 'La categoría solo aplica a cargos';
  if (e.method && !movesMoney) return 'El método de pago solo aplica a pagos y devoluciones';
  if (!e.method && movesMoney) return e.kind === FinanceEntryKind.PAYMENT ? 'Indica el método de pago' : 'Indica cómo se devolvió el dinero';
  if ((e.matchId || e.playerId) && !(isCharge && e.category === FinanceCategory.FINE)) return 'Solo una multa se vincula a un partido o jugador';
  if (!e.reason && ((isCharge && e.category === FinanceCategory.FINE) || e.kind === FinanceEntryKind.DISCOUNT)) return 'Indica el motivo de la multa o del descuento';
  if (e.allowCredit && e.kind !== FinanceEntryKind.PAYMENT) return 'El saldo a favor solo se genera con un pago';
  return null;
}
