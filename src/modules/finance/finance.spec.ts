import { describe, expect, it } from 'vitest';
import { FinanceCategory as C, FinanceEntryKind as K, PaymentMethod as M, enrollmentFeeCents, entryShapeError, ledgerRewriteError, totals } from './finance.js';
import { csvMoney, csvRaw, csvText, toCsv } from './finance-csv.js';

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

describe('4D: anulación y corrección (ledgerRewriteError)', () => {
  const L = (...e: [K, number][]) => e.map(([kind, amount], i) => ({ _id: `e${i}`, kind, amount }));

  it('anular un pago con su devolución ya hecha deja dinero devuelto que no se pagó → 409', () => {
    const ledger = L([K.CHARGE, 1_000], [K.PAYMENT, 1_500], [K.REFUND, 500]);
    expect(ledgerRewriteError(ledger, 'e1', null, true)?.code).toBe('VOID_BREAKS_LEDGER');
    // Anular la devolución devuelve el saldo a favor: se confirma igual que un pago excedente.
    expect(ledgerRewriteError(ledger, 'e2', null, false)?.code).toBe('CREDIT_CONFIRMATION_REQUIRED');
    expect(ledgerRewriteError(ledger, 'e2', null, true)).toBeNull();
  });

  it('anular el cargo de un descuento deja un descuento sin cargo → 409', () => {
    const ledger = L([K.CHARGE, 1_000], [K.DISCOUNT, 200]);
    expect(ledgerRewriteError(ledger, 'e0', null, true)?.code).toBe('VOID_BREAKS_LEDGER');
  });

  it('si el saldo a favor crece, exige la misma confirmación que un pago excedente', () => {
    const ledger = L([K.CHARGE, 1_000], [K.CHARGE, 300], [K.PAYMENT, 1_000]);
    const e = ledgerRewriteError(ledger, 'e0', null, false);
    expect(e).toMatchObject({ code: 'CREDIT_CONFIRMATION_REQUIRED', extra: { credit: 0, creditWouldBe: 700 } });
    expect(ledgerRewriteError(ledger, 'e0', null, true)).toBeNull();
    // Anular un pago o un descuento sube el adeudo: siempre válido.
    expect(ledgerRewriteError(ledger, 'e2', null, false)).toBeNull();
  });

  it('corrección: el reemplazo respeta los topes contra la cuenta sin el original', () => {
    const ledger = L([K.CHARGE, 1_000], [K.DISCOUNT, 100]);
    expect(ledgerRewriteError(ledger, 'e1', { kind: K.DISCOUNT, amount: 1_000 }, false)).toBeNull();
    expect(ledgerRewriteError(ledger, 'e1', { kind: K.DISCOUNT, amount: 1_001 }, false)?.code).toBe('DISCOUNT_EXCEEDS_BALANCE');
    const paid = L([K.CHARGE, 1_000], [K.PAYMENT, 1_200], [K.REFUND, 200]);
    expect(ledgerRewriteError(paid, 'e2', { kind: K.REFUND, amount: 201 }, false)?.code).toBe('REFUND_EXCEEDS_CREDIT');
    // Corregir un cargo de 1000 a 800 con 1000 pagado deja 200 a favor: requiere confirmación.
    expect(ledgerRewriteError(L([K.CHARGE, 1_000], [K.PAYMENT, 1_000]), 'e0', { kind: K.CHARGE, amount: 800 }, false)?.code).toBe('CREDIT_CONFIRMATION_REQUIRED');
  });

  it('los ya anulados no cuentan', () => {
    const ledger = [{ _id: 'a', kind: K.CHARGE, amount: 1_000 }, { _id: 'b', kind: K.REFUND, amount: 500, voidedAt: new Date() }];
    expect(ledgerRewriteError(ledger, 'a', null, false)).toBeNull();
  });
});

describe('4D: CSV para Excel', () => {
  it('BOM UTF-8, CRLF, comillas y acentos', () => {
    const csv = toCsv(['Equipo', 'Concepto'], [[csvText('Águilas, "B"'), csvText('Inscripción\nanual')]]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toBe('﻿Equipo,Concepto\r\n"Águilas, ""B""","Inscripción\nanual"\r\n');
  });

  it('neutraliza fórmulas en textos; los importes del servidor siguen siendo números', () => {
    for (const evil of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) expect(csvText(evil).replace(/^"/, '')).toMatch(/^'/);
    expect(csvText('Normal')).toBe('Normal');
    expect(csvRaw(csvMoney(-50_050))).toBe('-500.50');
    expect(csvMoney(1)).toBe('0.01');
  });
});
