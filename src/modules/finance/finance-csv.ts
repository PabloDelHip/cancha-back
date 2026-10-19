/**
 * 4D — CSV para Excel: UTF-8 con BOM (acentos), separador coma, CRLF, comillas escapadas y
 * protección contra inyección de fórmulas en los textos (OWASP: =, +, -, @, tab, CR al inicio se
 * anteponen con '). Los importes que genera el servidor van como número sin protección: un saldo
 * negativo debe seguir siendo un número en Excel.
 */
const FORMULA = /^[=+\-@\t\r]/;

/** Texto libre (concepto, motivo, referencia, nombres): neutraliza fórmulas y escapa. */
export function csvText(value: string | null | undefined): string {
  const s = value ?? '';
  return quote(FORMULA.test(s) ? `'${s}` : s);
}

/** Valor generado por el servidor (número, fecha, enum): solo se escapa. */
export function csvRaw(value: string | number | null | undefined): string {
  return quote(value == null ? '' : String(value));
}

const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Centavos → "1500.50" (punto decimal, sin separador de miles). */
export const csvMoney = (cents: number) => (cents / 100).toFixed(2);

export function toCsv(header: string[], rows: string[][]): string {
  return '﻿' + [header.map(csvRaw), ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}
