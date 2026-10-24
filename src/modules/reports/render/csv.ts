/**
 * 8A — CSV de un reporte. Reutiliza el CSV de 4D (finance-csv.ts): UTF-8 con BOM, CRLF, comillas
 * escapadas y textos protegidos contra inyección de fórmulas. Los números y fechas que genera el
 * servidor van sin protección (un saldo negativo sigue siendo número en Excel).
 *
 * Un reporte de UNA tabla da un CSV de datos puro (encabezado + filas + totales). Con varias
 * secciones (resumen, finanzas), cada una va como bloque: título, encabezado, filas y una línea en
 * blanco; las secciones de datos sueltos van como «Dato,Valor».
 */
import { csvMoney, csvRaw, csvText } from '../../finance/finance-csv.js';
import type { Cell, ReportColumn, ReportDoc, TableSection } from '../report-model.js';

function cell(value: Cell, col: ReportColumn): string {
  if (value == null || value === '') return '';
  if (typeof value === 'number') return csvRaw(col.type === 'money' ? csvMoney(value) : col.type === 'decimal' ? value.toFixed(1) : value);
  // Fechas y horas que genera el servidor: sin protección (no empiezan con =,+,-,@).
  if (col.type === 'date' || col.type === 'time') return csvRaw(value);
  return csvText(value);
}

const tableLines = (s: TableSection) => [
  s.columns.map((c) => csvRaw(c.label)).join(','),
  ...s.rows.map((r) => r.map((v, i) => cell(v, s.columns[i])).join(',')),
  ...(s.totals ? [s.totals.map((v, i) => cell(v, s.columns[i])).join(',')] : []),
];

export function renderCsv(doc: ReportDoc): Buffer {
  const tables = doc.sections.filter((s): s is TableSection => s.kind === 'table');
  let lines: string[];
  if (doc.sections.length === 1 && tables.length === 1) {
    lines = tableLines(tables[0]);
  } else {
    lines = doc.sections.flatMap((s) => [
      csvText(s.title),
      ...(s.kind === 'table' ? tableLines(s) : ['Dato,Valor', ...s.items.map(([k, v]) => `${csvText(k)},${csvText(v)}`)]),
      '',
    ]);
  }
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}
