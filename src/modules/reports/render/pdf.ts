/**
 * 8A — PDF de un reporte con pdfkit (fuentes estándar Helvetica: sin archivos de fuentes ni
 * imágenes externas). Encabezado con logo (o iniciales), liga, torneo, título, estado, fecha de
 * generación y filtros; tablas con encabezado repetido en cada página, filas alternadas, nombres
 * largos en hasta dos líneas (después «…»), totales en negritas; pie con «Página X de Y».
 *
 * Helvetica estándar cubre el español (WinAnsi: acentos, ñ, ü, ¿, ¡, €). Lo que no cabe en WinAnsi
 * (emojis, otros alfabetos) se sustituye por «?» para no imprimir basura (ver docs/reports-8.md).
 */
import PDFDocument from 'pdfkit';
import { humanDate, humanMoney, humanStamp, type Cell, type ColumnType, type KeyValueSection, type ReportColumn, type ReportDoc, type TableSection } from '../report-model.js';

const C = { ink: '#18181b', muted: '#52525b', soft: '#a1a1aa', line: '#e4e4e7', zebra: '#f4f5f2', brand: '#0e2c1f', brandSoft: '#d6ecdd', accent: '#a3e635', white: '#ffffff' };
const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' };
const SIZE = { body: 8.5, small: 7.5, section: 11.5 };
const MARGIN = 36;
const FOOT = 26;
const PAD_X = 4;
const PAD_Y = 4;
const LINE = SIZE.body * 1.22;

/** Caracteres de WinAnsi (CP1252) que no están en Latin-1. */
const CP1252 = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Texto imprimible con Helvetica estándar. */
export function pdfText(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (code === 9 || code === 10) out += ' ';
    else if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255) || CP1252.has(ch)) out += ch;
    else if (code > 31) out += '?';
  }
  return out;
}

const WEIGHT: Record<ColumnType, number> = { text: 3, int: 0.9, diff: 0.9, decimal: 1.1, money: 1.7, date: 1.6, time: 0.9 };
const RIGHT = new Set<ColumnType>(['int', 'diff', 'decimal', 'money']);

function format(value: Cell, type: ColumnType): string {
  if (value == null || value === '') return type === 'text' ? '' : '—';
  if (typeof value === 'number') return type === 'money' ? humanMoney(value) : type === 'decimal' ? value.toFixed(1) : type === 'diff' && value > 0 ? `+${value}` : String(value);
  return type === 'date' ? humanDate(value) || value : value;
}

type Doc = PDFKit.PDFDocument;

/** Parte el texto en líneas que caben en `width`; la última se corta con «…». */
function fit(doc: Doc, text: string, width: number, maxLines: number): string[] {
  const words = pdfText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (doc.widthOfString(next) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = words[i];
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const used = lines.join(' ').split(/\s+/).filter(Boolean).length;
  const truncated = used < words.length;
  // Una palabra más ancha que la columna, o texto que no cupo: «…» al final de la última línea.
  return lines.map((l, i) => {
    const last = i === lines.length - 1;
    if (doc.widthOfString(l) <= width && !(last && truncated)) return l;
    let s = l;
    while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1);
    return `${s.trimEnd()}…`;
  });
}

export function renderPdf(report: ReportDoc, timeZone: string): Doc {
  const doc = new PDFDocument({
    size: 'A4',
    layout: report.orientation,
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: pdfText(`${report.title} · ${report.tournament.name}`), Author: 'Kisokar', Creator: 'Kisokar', CreationDate: report.generatedAt },
  });
  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN - FOOT;

  /** Cabecera breve de las páginas siguientes. */
  const pageHead = () => {
    doc.font(FONT.bold).fontSize(SIZE.small).fillColor(C.brand).text(pdfText(`${report.title} · ${report.tournament.name}`), MARGIN, MARGIN, { width, lineBreak: false, ellipsis: true });
    doc.moveTo(MARGIN, MARGIN + 12).lineTo(MARGIN + width, MARGIN + 12).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.y = MARGIN + 20;
  };
  const newPage = () => {
    doc.addPage();
    pageHead();
  };
  const ensure = (h: number) => {
    if (doc.y + h > bottom()) newPage();
  };

  // ─── Encabezado de la primera página ─────────────────────────────────────
  const logoSize = 46;
  let drewLogo = false;
  if (report.logo) {
    try {
      doc.image(report.logo, MARGIN, MARGIN, { fit: [logoSize, logoSize], align: 'center', valign: 'center' });
      drewLogo = true;
    } catch {
      drewLogo = false;
    }
  }
  if (!drewLogo) {
    doc.circle(MARGIN + logoSize / 2, MARGIN + logoSize / 2, logoSize / 2).fill(C.brand);
    doc.font(FONT.bold).fontSize(report.logoInitials.length > 2 ? 13 : 16).fillColor(C.white);
    doc.text(pdfText(report.logoInitials), MARGIN, MARGIN + logoSize / 2 - 7, { width: logoSize, align: 'center', lineBreak: false });
  }
  const hx = MARGIN + logoSize + 12;
  const hw = width - logoSize - 12;
  doc.font(FONT.bold).fontSize(SIZE.small).fillColor(C.muted);
  doc.text(pdfText((report.tournament.league ?? 'Kisokar').toUpperCase()), hx, MARGIN + 1, { width: hw, characterSpacing: 0.8, lineBreak: false, ellipsis: true });
  doc.font(FONT.bold).fontSize(15).fillColor(C.ink).text(pdfText(report.tournament.name), hx, MARGIN + 12, { width: hw, lineBreak: false, ellipsis: true });
  doc.font(FONT.bold).fontSize(19).fillColor(C.brand).text(pdfText(report.title), hx, MARGIN + 29, { width: hw, lineBreak: false, ellipsis: true });
  doc.y = MARGIN + logoSize + 10;
  const meta = [
    `Estado: ${report.tournament.statusLabel}`,
    report.tournament.dates,
    `Generado: ${humanStamp(report.generatedAt, timeZone)}`,
    ...(report.currency ? [`Importes en ${report.currency}`] : []),
  ].filter(Boolean);
  doc.font(FONT.regular).fontSize(SIZE.small).fillColor(C.muted).text(pdfText(meta.join('   ·   ')), MARGIN, doc.y, { width });
  if (report.filters.length) doc.text(pdfText(`Filtros: ${report.filters.join(' · ')}`), MARGIN, doc.y + 2, { width });
  if (report.namesNote) doc.text(pdfText(report.namesNote), MARGIN, doc.y + 2, { width });
  doc.rect(MARGIN, doc.y + 6, width, 3).fill(C.accent);
  doc.y += 18;

  // ─── Secciones ──────────────────────────────────────────────────────────
  const sectionTitle = (title: string) => {
    ensure(40);
    doc.font(FONT.bold).fontSize(SIZE.section).fillColor(C.brand).text(pdfText(title), MARGIN, doc.y, { width });
    doc.y += 4;
  };

  const table = (s: TableSection) => {
    sectionTitle(s.title);
    const weights = s.columns.map((c) => c.weight ?? WEIGHT[c.type]);
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (width * w) / total);
    const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));

    const header = () => {
      doc.font(FONT.bold).fontSize(SIZE.small);
      const lines = s.columns.map((c, i) => fit(doc, c.label, widths[i] - PAD_X * 2, 2));
      const h = Math.max(...lines.map((l) => l.length)) * SIZE.small * 1.2 + PAD_Y * 2;
      ensure(h + LINE + PAD_Y * 2);
      const y = doc.y;
      doc.rect(MARGIN, y, width, h).fill(C.brand);
      doc.fillColor(C.white);
      s.columns.forEach((c, i) => lines[i].forEach((l, k) => doc.text(l, xs[i] + PAD_X, y + PAD_Y + k * SIZE.small * 1.2, { width: widths[i] - PAD_X * 2, align: RIGHT.has(c.type) ? 'right' : 'left', lineBreak: false })));
      doc.y = y + h;
    };

    const row = (cells: Cell[], index: number, bold: boolean) => {
      doc.font(bold ? FONT.bold : FONT.regular).fontSize(SIZE.body);
      const lines = cells.map((v, i) => {
        const col: ReportColumn = s.columns[i];
        const text = format(v, col.type);
        return col.type === 'text' ? fit(doc, text, widths[i] - PAD_X * 2, 2) : [pdfText(text)];
      });
      const h = Math.max(1, ...lines.map((l) => l.length)) * LINE + PAD_Y * 2;
      if (doc.y + h > bottom()) {
        newPage();
        header();
        doc.font(bold ? FONT.bold : FONT.regular).fontSize(SIZE.body);
      }
      const y = doc.y;
      if (bold) doc.rect(MARGIN, y, width, h).fill(C.brandSoft);
      else if (index % 2 === 1) doc.rect(MARGIN, y, width, h).fill(C.zebra);
      doc.fillColor(C.ink);
      s.columns.forEach((c, i) => lines[i].forEach((l, k) => doc.text(l, xs[i] + PAD_X, y + PAD_Y + k * LINE, { width: widths[i] - PAD_X * 2, align: RIGHT.has(c.type) ? 'right' : 'left', lineBreak: false })));
      doc.y = y + h;
    };

    if (!s.rows.length) {
      ensure(20);
      doc.font(FONT.italic).fontSize(SIZE.body).fillColor(C.muted).text(pdfText(s.empty), MARGIN, doc.y + 2, { width });
      doc.y += 10;
    } else {
      header();
      s.rows.forEach((r, i) => row(r, i, false));
      if (s.totals) row(s.totals, 0, true);
      doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.5).strokeColor(C.line).stroke();
    }
    if (s.note) {
      ensure(16);
      doc.font(FONT.italic).fontSize(SIZE.small).fillColor(C.muted).text(pdfText(s.note), MARGIN, doc.y + 4, { width });
    }
    doc.y += 14;
  };

  const pairs = (s: KeyValueSection) => {
    sectionTitle(s.title);
    const lw = Math.min(170, width * 0.32);
    s.items.forEach(([k, v], i) => {
      doc.font(FONT.regular).fontSize(SIZE.body);
      const lines = fit(doc, v, width - lw - PAD_X * 2, 3);
      const h = lines.length * LINE + PAD_Y * 2;
      ensure(h);
      const y = doc.y;
      if (i % 2 === 1) doc.rect(MARGIN, y, width, h).fill(C.zebra);
      doc.font(FONT.bold).fillColor(C.muted).text(pdfText(k), MARGIN + PAD_X, y + PAD_Y, { width: lw - PAD_X * 2, lineBreak: false, ellipsis: true });
      doc.font(FONT.regular).fillColor(C.ink);
      lines.forEach((l, j) => doc.text(l, MARGIN + lw + PAD_X, y + PAD_Y + j * LINE, { width: width - lw - PAD_X * 2, lineBreak: false }));
      doc.y = y + h;
    });
    doc.y += 14;
  };

  report.sections.forEach((s) => (s.kind === 'table' ? table(s) : pairs(s)));

  // ─── Pie con numeración (las páginas están en memoria: bufferPages) ──────
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - MARGIN - 10;
    // Escribir en el margen inferior sin que pdfkit agregue una página.
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(MARGIN, y - 6).lineTo(MARGIN + width, y - 6).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.font(FONT.regular).fontSize(SIZE.small).fillColor(C.soft);
    doc.text(pdfText(`Kisokar · ${report.title} · ${report.tournament.name}`), MARGIN, y, { width: width - 90, lineBreak: false, ellipsis: true });
    doc.text(`Página ${i - range.start + 1} de ${range.count}`, MARGIN + width - 90, y, { width: 90, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
  doc.end();
  return doc;
}
