/**
 * 8A — Excel (.xlsx) de un reporte, escrito directamente (SpreadsheetML + ZIP con fflate, que ya
 * trae pdfkit): sin librerías de hojas de cálculo. Una hoja por tabla (encabezado fijo, filtro,
 * anchos ajustados, totales en negritas), una por cada sección de datos sueltos y al final
 * «Información» (reporte, torneo, filtros, fecha de generación).
 *
 * Tipos reales para analizar después: enteros y decimales como número, importes como número con
 * formato #,##0.00 (en unidades, no centavos), fechas como fecha de Excel (dd/mm/yyyy). Los textos
 * van como cadena en línea (nunca como fórmula): no hay inyección posible en el .xlsx.
 */
import { zipSync, strToU8 } from 'fflate';
import { humanStamp, type Cell, type ColumnType, type ReportDoc, type TableSection } from '../report-model.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Estilos (índices de cellXfs en styles.xml). */
const ST = { text: 0, header: 1, date: 2, money: 3, int: 4, decimal: 5, bold: 6, boldMoney: 7, boldInt: 8, boldDecimal: 9, boldDate: 10, diff: 11, boldDiff: 12, label: 6 } as const;
const STYLE_OF: Record<ColumnType, [number, number]> = {
  text: [ST.text, ST.bold],
  time: [ST.text, ST.bold],
  int: [ST.int, ST.boldInt],
  diff: [ST.diff, ST.boldDiff],
  decimal: [ST.decimal, ST.boldDecimal],
  money: [ST.money, ST.boldMoney],
  date: [ST.date, ST.boldDate],
};

/** Quita caracteres no válidos en XML 1.0 y escapa. */
function xml(s: string): string {
  return (
    s
      // Intencional: los caracteres de control no son válidos en XML 1.0.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

export function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 'YYYY-MM-DD' → número de serie de Excel (null si no es fecha). */
function excelDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 + 25_569 : null;
}

function cellXml(ref: string, value: Cell, type: ColumnType, bold: boolean): string {
  const [normal, strong] = STYLE_OF[type];
  const s = bold ? strong : normal;
  if (value == null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const v = type === 'money' ? value / 100 : value;
    return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
  }
  const text = String(value);
  if (type === 'date') {
    const serial = excelDate(text);
    if (serial !== null) return `<c r="${ref}" s="${s}"><v>${serial}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr" s="${bold ? ST.bold : ST.text}"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

/** Ancho visible de una celda (para ajustar columnas). */
function shown(value: Cell, type: ColumnType): number {
  if (value == null) return 0;
  if (typeof value === 'number') return type === 'money' ? (value / 100).toFixed(2).length + 3 : String(value).length;
  return type === 'date' ? 10 : String(value).length;
}

interface Sheet {
  name: string;
  xml: string;
  /** Rango del filtro (para el nombre definido _FilterDatabase). */
  filter: string | null;
}

function tableSheet(name: string, s: TableSection): Sheet {
  const cols = s.columns.length;
  const widths = s.columns.map((c, i) => Math.min(60, Math.max(6, c.label.length + 2, ...[...s.rows, ...(s.totals ? [s.totals] : [])].map((r) => shown(r[i], c.type) + 2))));
  const header = `<row r="1">${s.columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="${ST.header}"><is><t xml:space="preserve">${xml(c.label)}</t></is></c>`).join('')}</row>`;
  const body = s.rows.map((r, ri) => `<row r="${ri + 2}">${r.map((v, i) => cellXml(`${colName(i)}${ri + 2}`, v, s.columns[i].type, false)).join('')}</row>`);
  const totalsRow = s.totals ? `<row r="${s.rows.length + 2}">${s.totals.map((v, i) => cellXml(`${colName(i)}${s.rows.length + 2}`, v, s.columns[i].type, true)).join('')}</row>` : '';
  const last = colName(cols - 1);
  const filter = s.rows.length ? `A1:${last}${s.rows.length + 1}` : null;
  return {
    name,
    filter,
    xml:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${NS_R}">` +
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
      `<sheetData>${header}${body.join('')}${totalsRow}</sheetData>` +
      (filter ? `<autoFilter ref="${filter}"/>` : '') +
      `</worksheet>`,
  };
}

function pairsSheet(name: string, items: [string, string][]): Sheet {
  const w0 = Math.min(40, Math.max(8, ...items.map(([k]) => k.length + 2)));
  const w1 = Math.min(90, Math.max(10, ...items.map(([, v]) => v.length + 2)));
  const rows = items.map(([k, v], i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr" s="${ST.label}"><is><t xml:space="preserve">${xml(k)}</t></is></c><c r="B${i + 1}" t="inlineStr" s="${ST.text}"><is><t xml:space="preserve">${xml(v)}</t></is></c></row>`);
  return {
    name,
    filter: null,
    xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${NS_R}"><cols><col min="1" max="1" width="${w0}" customWidth="1"/><col min="2" max="2" width="${w1}" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData></worksheet>`,
  };
}

/** Nombre de hoja válido y único (≤ 31, sin []:*?/\). */
function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Hoja';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS}">
<numFmts count="4"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/><numFmt numFmtId="166" formatCode="0.0"/><numFmt numFmtId="167" formatCode="+0;-0;0"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0E2C1F"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function renderXlsx(doc: ReportDoc, timeZone: string): Buffer {
  const used = new Set<string>();
  // «Información» se reserva primero (va al final, pero ninguna sección puede tomar su nombre).
  const infoName = sheetName('Información', used);
  const sheets: Sheet[] = doc.sections.map((s) => (s.kind === 'table' ? tableSheet(sheetName(s.title, used), s) : pairsSheet(sheetName(s.title, used), s.items)));
  const info: [string, string][] = [
    ['Reporte', doc.title],
    ['Torneo', doc.tournament.name],
    ...(doc.tournament.league ? [['Liga', doc.tournament.league] as [string, string]] : []),
    ['Estado del torneo', doc.tournament.statusLabel],
    ['Fechas', doc.tournament.dates],
    ...(doc.currency ? [['Moneda', doc.currency] as [string, string]] : []),
    ['Filtros', doc.filters.length ? doc.filters.join(' · ') : 'Ninguno'],
    ...(doc.namesNote ? [['Nombres', doc.namesNote] as [string, string]] : []),
    ['Generado', `${humanStamp(doc.generatedAt, timeZone)} (${timeZone})`],
    ['Generado por', 'Kisokar'],
  ];
  sheets.push(pairsSheet(infoName, info));

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets>` +
    sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets>` +
    (sheets.some((s) => s.filter)
      ? `<definedNames>${sheets
          .map((s, i) => (s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(s.name.replace(/'/g, "''"))}'!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : ''))
          .join('')}</definedNames>`
      : '') +
    `</workbook>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="${NS_R}/styles" Target="styles.xml"/></Relationships>`;
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xml(`${doc.title} · ${doc.tournament.name}`)}</dc:title><dc:creator>Kisokar</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${doc.generatedAt.toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(types),
    '_rels/.rels': strToU8(rootRels),
    'docProps/core.xml': strToU8(core),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(s.xml)));
  return Buffer.from(zipSync(files, { level: 6 }));
}
