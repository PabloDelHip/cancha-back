/**
 * 8A — pruebas unitarias del modelo y los renderizadores (sin base de datos).
 */
import { deflateSync } from 'node:zlib';
import { strFromU8, unzipSync } from 'fflate';
import { MatchStatus, SanctionCause, SanctionKind, SanctionStatus } from '../../common/enums/index.js';
import { financeSections, matchesSection, playersSection, rankPlayers, scheduleOf, statusOf, type MatchRowInput } from './report-builders.js';
import { humanDate, humanMoney, initialsOf, slug, type ReportDoc, type ReportSection } from './report-model.js';
import { renderCsv } from './render/csv.js';
import { pdfText, renderPdf } from './render/pdf.js';
import { fetchLogo } from './render/logo.js';
import { colName, renderXlsx } from './render/xlsx.js';

const doc = (sections: ReportSection[], extra: Partial<ReportDoc> = {}): ReportDoc => ({
  id: 'matches',
  title: 'Resultados y calendario',
  tournament: { name: 'Liga Ñandú «Águilas» 2026', league: 'Liga Peñasco', status: 'ACTIVE', statusLabel: 'En curso', dates: '1 ene 2026 – 30 jun 2026' },
  generatedAt: new Date('2026-10-23T23:05:00Z'),
  filters: ['Equipo: Águilas'],
  logo: null,
  logoInitials: 'LÑ',
  orientation: 'landscape',
  sections,
  fileBase: 'resultados-liga-nandu',
  ...extra,
});

const table = (rows: (string | number | null)[][], extra: Record<string, unknown> = {}): ReportSection => ({
  kind: 'table',
  title: 'Datos',
  columns: [
    { label: 'Equipo', type: 'text' },
    { label: 'Goles', type: 'int' },
    { label: 'Importe', type: 'money' },
    { label: 'Fecha', type: 'date' },
  ],
  rows,
  empty: 'Sin datos',
  ...extra,
});

/** Parser CSV mínimo (comillas, comas y saltos dentro de comillas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

describe('8A — CSV', () => {
  it('UTF-8 con BOM, CRLF, escape de comillas, comas y saltos; acentos intactos', () => {
    const text = renderCsv(doc([table([['Peñarol "Ñuu", Savi\nB', 3, 150_050, '2026-10-25']])])).toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(text.slice(1));
    expect(rows[0]).toEqual(['Equipo', 'Goles', 'Importe', 'Fecha']);
    expect(rows[1]).toEqual(['Peñarol "Ñuu", Savi\nB', '3', '1500.50', '2026-10-25']);
  });

  it('neutraliza fórmulas en textos (=, +, -, @, tab, CR) pero no en números negativos generados', () => {
    const rows = parseCsv(renderCsv(doc([table([['=HYPERLINK("x")', -2, -500, null], ['+1', 0, 0, null], ['-SUM(A1)', 0, 0, null], ['@cmd', 0, 0, null], ['\tTab', 0, 0, null]])])).toString('utf8').slice(1));
    expect(rows.slice(1).map((r) => r[0])).toEqual(["'=HYPERLINK(\"x\")", "'+1", "'-SUM(A1)", "'@cmd", "'\tTab"]);
    expect(rows[1][1]).toBe('-2');
    expect(rows[1][2]).toBe('-5.00');
  });

  it('varias secciones: bloques con título; datos sueltos como Dato,Valor; totales al final de su tabla', () => {
    const text = renderCsv(doc([{ kind: 'kv', title: 'Resumen', items: [['Goles', '12']] }, table([['A', 1, 100, null]], { totals: ['Total', 1, 100, null] })])).toString('utf8').slice(1);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(['Resumen']);
    expect(rows[1]).toEqual(['Dato', 'Valor']);
    expect(rows[2]).toEqual(['Goles', '12']);
    expect(rows[4]).toEqual(['Datos']);
    expect(rows.at(-2)).toEqual(['Total', '1', '1.00', '']);
  });
});

describe('8A — Excel', () => {
  const unzip = (b: Buffer) => Object.fromEntries(Object.entries(unzipSync(new Uint8Array(b))).map(([k, v]) => [k, strFromU8(v)]));

  it('es un .xlsx válido: hojas, encabezado fijo, filtro, tipos reales y totales en negritas', () => {
    const files = unzip(renderXlsx(doc([table([['Águilas <&>', 3, 150_050, '2026-10-25'], ['=1+1', 0, 0, null]], { totals: ['Total', 3, 150_050, null] })]), 'America/Cancun'));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']));
    const sheet = files['xl/worksheets/sheet1.xml'];
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:D3"/>');
    expect(sheet).toContain('Águilas &lt;&amp;&gt;');
    // Importe en unidades (no centavos) y fecha como número de serie de Excel (25-oct-2026 = 46320).
    expect(sheet).toContain('<c r="C2" s="3"><v>1500.5</v></c>');
    expect(sheet).toContain('<c r="D2" s="2"><v>46320</v></c>');
    // Un texto con «=» es cadena, nunca fórmula.
    expect(sheet).toContain('<t xml:space="preserve">=1+1</t>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('<c r="B4" s="8"><v>3</v></c>');
    expect(files['xl/workbook.xml']).toContain('<sheet name="Datos" sheetId="1" r:id="rId1"/>');
    expect(files['xl/workbook.xml']).toContain('<sheet name="Información" sheetId="2" r:id="rId2"/>');
    expect(files['xl/workbook.xml']).toContain(`localSheetId="0" hidden="1">'Datos'!$A$1:$D$3</definedName>`);
    expect(files['xl/worksheets/sheet2.xml']).toContain('Equipo: Águilas');
  });

  it('nombres de hoja válidos y únicos (≤ 31, sin caracteres prohibidos); tabla vacía sin filtro', () => {
    const long = 'Tabla: grupo [A] / fase *regular* con un nombre larguísimo';
    const files = unzip(renderXlsx(doc([table([], { title: long }), table([], { title: long })]), 'UTC'));
    const names = [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toHaveLength(3);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[[\]:*?/\\]/);
    }
    expect(files['xl/worksheets/sheet1.xml']).not.toContain('autoFilter');
  });

  it('quita caracteres de control no válidos en XML', () => {
    const files = unzip(renderXlsx(doc([table([['A\u0001B\u0007C', 0, 0, null]])]), 'UTC'));
    expect(files['xl/worksheets/sheet1.xml']).toContain('>ABC<');
  });

  it('columnas más allá de Z', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('8A — PDF', () => {
  const pdf = (d: ReportDoc) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const s = renderPdf(d, 'America/Cancun');
      s.on('data', (c: Buffer) => chunks.push(c));
      s.on('end', () => resolve(Buffer.concat(chunks)));
      s.on('error', reject);
    });
  const pages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;

  it('genera un PDF válido de una página con tabla vacía y datos sueltos', async () => {
    const b = await pdf(doc([table([]), { kind: 'kv', title: 'Resumen', items: [['Equipos', '0']] }]));
    expect(b.subarray(0, 5).toString()).toBe('%PDF-');
    expect(b.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pages(b)).toBe(1);
  });

  it('muchas filas: varias páginas (encabezado repetido), nombres larguísimos sin romper', async () => {
    const long = 'Club Deportivo Atlético Unión de Pescadores y Amigos del Puerto de Altata Sinaloa '.repeat(3);
    const rows = Array.from({ length: 900 }, (_, i) => [`${long}${i}`, i, i * 100, '2026-10-25']);
    const b = await pdf(doc([table(rows, { totals: ['Total', 0, 0, null] })]));
    expect(b.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(b)).toBeGreaterThan(10);
  });

  it('el texto se limita a lo que Helvetica estándar imprime (español completo; emojis → ?)', () => {
    expect(pdfText('Peñarol Ñuu Savi · ¿Ganó? ¡Sí! Güemes €')).toBe('Peñarol Ñuu Savi · ¿Ganó? ¡Sí! Güemes €');
    expect(pdfText('Los Tigres ⚽ 東京')).toBe('Los Tigres ? ??');
    expect(pdfText('a\nb\tc')).toBe('a b c');
  });
});

describe('8A — reglas de los reportes', () => {
  const m = (over: Partial<MatchRowInput>): MatchRowInput => ({
    round: 1,
    roundLabel: 'Jornada 1',
    date: '2026-10-25',
    time: '16:00',
    status: MatchStatus.SCHEDULED,
    pendingSchedule: false,
    postponedFrom: null,
    home: 'A',
    away: 'B',
    homeScore: null,
    awayScore: null,
    penalties: null,
    extraTime: false,
    stage: null,
    venue: null,
    referee: null,
    ...over,
  });

  it('estados: «Por programar» (6C) y pospuesto sin fecha vigente; reprogramado con su fecha anterior', () => {
    expect(statusOf(m({ status: MatchStatus.POSTPONED, pendingSchedule: true }))).toBe('Por programar');
    expect(statusOf(m({ status: MatchStatus.POSTPONED }))).toBe('Pospuesto');
    expect(scheduleOf(m({ status: MatchStatus.POSTPONED }))).toEqual({ date: null, time: null });
    expect(scheduleOf(m({ time: '' }))).toEqual({ date: '2026-10-25', time: null });
    const s = matchesSection([
      m({ status: MatchStatus.FINISHED, homeScore: 2, awayScore: 2, penalties: { home: 4, away: 3 } }),
      m({ status: MatchStatus.POSTPONED, pendingSchedule: true }),
      m({ status: MatchStatus.SCHEDULED, postponedFrom: { date: '2026-10-12', time: '10:00' } }),
      m({ status: MatchStatus.CANCELLED, homeScore: null }),
    ]);
    expect(s.rows[0].slice(4, 7)).toEqual(['2-2', 'B', 'Finalizado']);
    expect(s.rows[0][10]).toBe('Penales 4-3');
    expect(s.rows[1].slice(1, 3)).toEqual([null, null]);
    expect(s.rows[1][10]).toBe('Sin horario asignado');
    expect(s.rows[2][10]).toBe('Reprogramado (antes 12 oct 2026 10:00)');
    expect(s.rows[3][4]).toBe('');
  });

  it('goleo: goles, menos partidos, asistencias; misma posición con mismos goles y partidos; promedio', () => {
    const base = { team: 'A', ownGoals: 0, yellows: 0, reds: 0 };
    const ranked = rankPlayers([
      { ...base, player: 'Beto', played: 5, goals: 4, assists: 0 },
      { ...base, player: 'Ana', played: 4, goals: 4, assists: 0 },
      { ...base, player: 'Carla', played: 4, goals: 4, assists: 2 },
      { ...base, player: 'Dani', played: 3, goals: 0, assists: 0 },
    ]);
    expect(ranked.map((r) => [r.player, r.position])).toEqual([['Carla', 1], ['Ana', 1], ['Beto', 3], ['Dani', 4]]);
    expect(playersSection([{ ...base, player: 'Ana', played: 3, goals: 2, assists: 0 }]).rows[0][5]).toBe(0.7);
  });

  it('finanzas: totales de la tabla = totales recibidos; anulados listados pero marcados', () => {
    const acc = (teamName: string, charged: number, paid: number) => ({ teamName, status: 'ENROLLED', entries: 2, charged, paid, discounted: 0, refunded: 0, balance: charged - paid, due: Math.max(0, charged - paid), credit: Math.max(0, paid - charged) });
    const sections = financeSections(
      {
        accounts: [acc('A', 10_000, 4_000), acc('B', 5_000, 6_000)],
        totals: { charged: 15_000, paid: 10_000, discounted: 0, refunded: 0, balance: 5_000, due: 6_000, credit: 1_000 },
        byCategory: [{ category: 'ENROLLMENT', amount: 15_000, entries: 2 }],
        byMethod: [{ kind: 'PAYMENT', method: 'CASH', amount: 10_000 }],
        entries: [{ date: '2026-01-02', team: 'A', kind: 'PAYMENT', category: null, concept: 'Abono', method: 'CASH', reference: null, amount: 500, voided: true, voidReason: 'Duplicado' }],
      },
      'MXN',
    );
    const balances = sections.find((s) => s.title === 'Saldos por equipo');
    expect(balances?.kind === 'table' && balances.totals).toEqual(['TOTAL', '', 15_000, 10_000, 0, 0, 6_000, 1_000, 4]);
    const summary = sections[0];
    expect(summary.kind === 'kv' && summary.items[5]).toEqual(['Adeudo total', '60.00 MXN']);
    const moves = sections.at(-1);
    expect(moves?.kind === 'table' && moves.rows[0].slice(6)).toEqual([null, 500, 'Anulado: Duplicado']);
  });

  it('utilidades: nombre de archivo seguro, iniciales, fechas e importes', () => {
    expect(slug('  Liga «Ñandú» / Águilas 2026!! ')).toBe('liga-nandu-aguilas-2026');
    expect(slug('../../etc/passwd')).toBe('etc-passwd');
    expect(slug('😀')).toBe('torneo');
    expect(initialsOf('Liga Municipal de Fútbol 7')).toBe('LMF');
    expect(humanDate('2026-01-05')).toBe('5 ene 2026');
    expect(humanDate('x')).toBe('');
    expect(humanMoney(-123_456)).toBe('-1,234.56');
  });

  it('disciplina: etiquetas reales de causa y estado', async () => {
    const { disciplineSections } = await import('./report-builders.js');
    const [sanctions] = disciplineSections(
      [{ player: 'Ana', team: 'A', kind: SanctionKind.AUTO, cause: SanctionCause.SECOND_YELLOW, origin: 'J1 · A vs B', matches: 2, served: 1, remaining: 1, status: SanctionStatus.ACTIVE, reason: null, adjusted: true }],
      [],
    );
    expect(sanctions.kind === 'table' && sanctions.rows[0].slice(2, 8)).toEqual(['Doble amarilla (ajustada)', 'J1 · A vs B', 2, 1, 1, 'Vigente']);
  });
});

/** PNG real mínimo (escudo de 64×64 en dos colores) armado sin red ni archivos. */
function testPng(size = 64): Buffer {
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const o = y * (size * 3 + 1) + 1 + x * 3;
      const band = y > size / 3 && y < (size * 2) / 3;
      [rows[o], rows[o + 1], rows[o + 2]] = band ? [253, 224, 71] : [185, 28, 28];
    }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

describe('8C — logo del torneo en el PDF (sin red: descarga simulada)', () => {
  const CLOUD = 'https://res.cloudinary.com/kisokar/image/upload/v1/tournaments/logo.jpg';
  const png = testPng();
  const respond = (body: Buffer, type = 'image/png', status = 200) => new Response(new Uint8Array(body), { status, headers: { 'content-type': type } });
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.REPORTS_FETCH_LOGOS;
    delete process.env.REPORTS_FETCH_LOGOS;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved !== undefined) process.env.REPORTS_FETCH_LOGOS = saved;
  });

  it('Cloudinary: pide el logo como PNG pequeño, sin redirecciones y con tiempo máximo', async () => {
    const fetch = vi.fn(async (_url: URL, _init?: RequestInit) => respond(png));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchLogo(CLOUD)).toEqual(png);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://res.cloudinary.com/kisokar/image/upload/f_png,w_160,h_160,c_fit/v1/tournaments/logo.jpg');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('nunca pide URLs que no sean de Cloudinary (SSRF) ni sin HTTPS', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const url of [
      'http://res.cloudinary.com/kisokar/image/upload/x.png',
      'https://evil.example/image/upload/x.png',
      'https://res.cloudinary.com.evil.example/image/upload/x.png',
      'https://169.254.169.254/latest/meta-data',
      'https://res.cloudinary.com/kisokar/raw/upload/x.png',
      'file:///etc/passwd',
      'no es una url',
      '',
      null,
    ])
      expect(await fetchLogo(url)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('si falla (tipo, tamaño, error HTTP, red, tiempo) devuelve null: el PDF usa las iniciales', async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => respond(png, 'image/jpeg'),
      async () => respond(Buffer.alloc(1_000_001), 'image/png'),
      async () => respond(png, 'image/png', 404),
      async () => {
        throw new TypeError('fetch failed');
      },
      async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
    ];
    for (const impl of cases) {
      vi.stubGlobal('fetch', vi.fn(impl));
      expect(await fetchLogo(CLOUD)).toBeNull();
    }
  });

  it('REPORTS_FETCH_LOGOS=false lo desactiva (pruebas y entornos sin red)', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    process.env.REPORTS_FETCH_LOGOS = 'false';
    expect(await fetchLogo(CLOUD)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  const pdfOf = (d: ReportDoc) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      const s = renderPdf(d, 'UTC');
      s.on('data', (c: Buffer) => chunks.push(c));
      s.on('end', () => resolve(Buffer.concat(chunks)));
    });

  it('con logo: la imagen se incrusta en el PDF; con un logo dañado, iniciales y el PDF sigue siendo válido', async () => {
    const withLogo = await pdfOf(doc([table([['A', 1, 100, null]])], { logo: png }));
    expect(withLogo.toString('latin1')).toMatch(/\/Subtype \/Image/);
    const broken = await pdfOf(doc([table([['A', 1, 100, null]])], { logo: Buffer.from('no es una imagen') }));
    expect(broken.subarray(0, 5).toString()).toBe('%PDF-');
    expect(broken.toString('latin1')).not.toMatch(/\/Subtype \/Image/);
    const none = await pdfOf(doc([table([['A', 1, 100, null]])]));
    expect(none.toString('latin1')).not.toMatch(/\/Subtype \/Image/);
  });
});
