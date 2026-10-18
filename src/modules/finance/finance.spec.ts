import { describe, expect, it } from 'vitest';
import { FinanceCategory as C, FinanceEntryKind as K, PaymentMethod as M, enrollmentFeeCents, entryShapeError, totals } from './finance.js';

const zero = { charged: 0, paid: 0, discounted: 0, refunded: 0, balance: 0, due: 0, credit: 0, entries: 0 };

describe('4A: totals (saldo derivado del libro)', () => {
  it('cargos − pagos, en centavos enteros (sin errores de punto flotante)', () => {
    // 0.1 + 0.2 en pesos daría 0.30000000000000004; en centavos es exacto.
    const t = totals([{ kind: K.CHARGE, amount: 10 }, { kind: K.CHARGE, amount: 20 }, { kind: K.PAYMENT, amount: 30 }]);
    expect(t).toEqual({ ...zero, charged: 30, paid: 30, entries: 3 });
  });

  it('los anulados quedan fuera del saldo y del conteo', () => {
    const t = totals([{ kind: K.CHARGE, amount: 150_000 }, { kind: K.PAYMENT, amount: 50_000 }, { kind: K.PAYMENT, amount: 50_000, voidedAt: new Date() }]);
    expect(t).toEqual({ ...zero, charged: 150_000, paid: 50_000, balance: 100_000, due: 100_000, entries: 2 });
  });

  it('cuenta vacía: todo en cero', () => {
    expect(totals([])).toEqual(zero);
  });
});

describe('4B: descuentos, saldo a favor y devoluciones', () => {
  it('saldo = cargos − pagos − descuentos + devoluciones; negativo es saldo a favor', () => {
    const t = totals([
      { kind: K.CHARGE, amount: 100_000 },
      { kind: K.DISCOUNT, amount: 20_000 },
      { kind: K.PAYMENT, amount: 110_000 }, // excedente de 30 000 → saldo a favor
      { kind: K.REFUND, amount: 10_000 },
    ]);
    expect(t).toEqual({ charged: 100_000, paid: 110_000, discounted: 20_000, refunded: 10_000, balance: -20_000, due: 0, credit: 20_000, entries: 4 });
  });

  it('un tipo desconocido no altera el saldo', () => {
    expect(totals([{ kind: 'OTRO', amount: 5 }])).toEqual(zero);
  });

  it('cuota de inscripción en centavos exactos; sin cuota o gratuita → null', () => {
    expect(enrollmentFeeCents({ teamFee: 19.99, paymentMode: 'paid' })).toBe(1999);
    expect(enrollmentFeeCents({ teamFee: 1500, paymentMode: null })).toBe(150_000);
    expect(enrollmentFeeCents({ teamFee: 1500, paymentMode: 'free' })).toBeNull();
    expect(enrollmentFeeCents({ teamFee: 0 })).toBeNull();
    expect(enrollmentFeeCents({ teamFee: null })).toBeNull();
    expect(enrollmentFeeCents(undefined)).toBeNull();
  });

  it('coherencia de campos por tipo de movimiento', () => {
    expect(entryShapeError({ kind: K.CHARGE, category: C.FINE, reason: 'Roja directa', matchId: 'x', playerId: 'y' })).toBeNull();
    expect(entryShapeError({ kind: K.CHARGE, category: C.FINE })).toMatch(/motivo/);
    expect(entryShapeError({ kind: K.CHARGE, category: C.OTHER, matchId: 'x' })).toMatch(/multa/);
    expect(entryShapeError({ kind: K.DISCOUNT })).toMatch(/motivo/);
    expect(entryShapeError({ kind: K.DISCOUNT, reason: 'Beca', method: M.CASH })).toMatch(/método/);
    expect(entryShapeError({ kind: K.REFUND })).toMatch(/devolvió/);
    expect(entryShapeError({ kind: K.REFUND, method: M.TRANSFER, allowCredit: true })).toMatch(/saldo a favor/);
    expect(entryShapeError({ kind: K.PAYMENT, method: M.CASH, allowCredit: true })).toBeNull();
    expect(entryShapeError({ kind: K.PAYMENT })).toMatch(/método/);
    expect(entryShapeError({ kind: K.PAYMENT, method: M.CASH, category: C.FINE })).toMatch(/categoría/);
  });
});
