/**
 * 8A — constructores de reportes: funciones PURAS que pasan datos ya calculados por los servicios
 * de cada módulo (estructura de competición, disciplina, finanzas…) al modelo del reporte. No
 * consultan la base ni recalculan reglas: la carga está en reports.service.ts.
 */
import { MatchStatus, PhaseType, SanctionCause, SanctionKind, SanctionStatus } from '../../common/enums/index.js';
import type { StructureView } from '../competition/structure.js';
import type { PointsRule, StandingRow } from '../statistics/calculations.js';
import { humanDate, humanMoney, type Cell, type ReportSection, type TableSection } from './report-model.js';

// ─── Etiquetas ────────────────────────────────────────────────────────────────

export const MATCH_STATUS_LABEL: Record<string, string> = {
  [MatchStatus.SCHEDULED]: 'Programado',
  [MatchStatus.LIVE]: 'En juego',
  [MatchStatus.FINISHED]: 'Finalizado',
  [MatchStatus.POSTPONED]: 'Pospuesto',
  [MatchStatus.CANCELLED]: 'Cancelado',
  [MatchStatus.SUSPENDED]: 'Suspendido',
};
/** Filtro de estado: los del partido más «por programar» (pospuesto que nunca tuvo horario, 6C). */
export const STATUS_FILTERS = ['SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED', 'SUSPENDED', 'PENDING_SCHEDULE'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

const CAUSE_LABEL: Record<SanctionCause, string> = {
  [SanctionCause.ACCUMULATION]: 'Acumulación de amarillas',
  [SanctionCause.DIRECT_RED]: 'Roja directa',
  [SanctionCause.SECOND_YELLOW]: 'Doble amarilla',
  [SanctionCause.MANUAL]: 'Sanción del organizador',
};
const SANCTION_STATUS_LABEL: Record<SanctionStatus, string> = {
  [SanctionStatus.ACTIVE]: 'Vigente',
  [SanctionStatus.PENDING]: 'Pendiente (sin partidos programados)',
  [SanctionStatus.SERVED]: 'Cumplida',
  [SanctionStatus.ANNULLED]: 'Anulada',
};
const POSITION_LABEL: Record<string, string> = { GOALKEEPER: 'Portero', DEFENDER: 'Defensa', MIDFIELDER: 'Medio', FORWARD: 'Delantero' };
const CATEGORY_LABEL: Record<string, string> = { ENROLLMENT: 'Inscripción', PLAYER_FEE: 'Cuota por jugador', REFEREE: 'Arbitraje', FINE: 'Multas', OTHER: 'Otros' };
const METHOD_LABEL: Record<string, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', CARD: 'Tarjeta', OTHER: 'Otro' };
const KIND_LABEL: Record<string, string> = { CHARGE: 'Cargo', PAYMENT: 'Pago', DISCOUNT: 'Descuento', REFUND: 'Devolución' };
const ENROLLMENT_LABEL: Record<string, string> = { ENROLLED: 'Inscrito', WITHDRAWN: 'Retirado', NOT_ENROLLED: 'Ya no inscrito' };

// ─── 1. Tabla de posiciones ──────────────────────────────────────────────────

const STANDING_COLUMNS = [
  { label: 'Pos.', type: 'int' as const, weight: 0.6 },
  { label: 'Equipo', type: 'text' as const, weight: 4 },
  { label: 'PJ', type: 'int' as const },
  { label: 'G', type: 'int' as const },
  { label: 'E', type: 'int' as const },
  { label: 'P', type: 'int' as const },
  { label: 'GF', type: 'int' as const },
  { label: 'GC', type: 'int' as const },
  { label: 'DIF', type: 'diff' as const, weight: 0.9 },
  { label: 'Pts', type: 'int' as const },
];

function standingSection(title: string, rows: StandingRow[], nameOf: (id: string) => string, withdrawn: Set<string>, qualify: number | null, note: string): TableSection {
  return {
    kind: 'table',
    title,
    columns: STANDING_COLUMNS,
    rows: rows.map((r) => [r.position, `${nameOf(r.teamId)}${withdrawn.has(r.teamId) ? ' (retirado)' : ''}`, r.played, r.wins, r.draws, r.losses, r.goalsFor, r.goalsAgainst, r.goalDifference, r.points]),
    empty: 'Sin equipos en esta tabla.',
    note: [note, qualify ? `Clasifican los primeros ${qualify}.` : null].filter(Boolean).join(' '),
  };
}

export function pointsNote(p: PointsRule): string {
  return `Solo partidos finalizados. Puntos: victoria ${p.win}, empate ${p.draw}, derrota ${p.loss}${p.shootoutWin ? `, +${p.shootoutWin} al ganador de penales tras empate` : ''}. Orden: puntos, diferencia de goles, goles a favor y desempates del torneo.`;
}

const TIE_DECIDED: Record<string, string> = { BYE: 'Pase directo', SCORE: 'Marcador', PENALTIES: 'Penales', POSITION: 'Mejor posición' };

export function standingsSections(view: StructureView, nameOf: (id: string) => string, withdrawnIds: string[], points: PointsRule, filter: { phase?: number; group?: string }): ReportSection[] {
  const withdrawn = new Set(withdrawnIds);
  const note = pointsNote(points);
  const many = view.phases.length > 1;
  const sections: ReportSection[] = [];
  for (const p of view.phases) {
    if (filter.phase !== undefined && p.index !== filter.phase) continue;
    if (p.type === PhaseType.LEAGUE) {
      if (filter.group) continue;
      sections.push(standingSection(many ? 'Fase regular' : 'Tabla general', p.table, nameOf, withdrawn, p.qualification?.count ?? null, note));
    } else if (p.type === PhaseType.GROUPS) {
      for (const g of p.groups) if (!filter.group || g.key === filter.group) sections.push(standingSection(`Grupo ${g.key}`, g.table, nameOf, withdrawn, g.qualification.count, note));
    } else if (!filter.group && p.generated) {
      const rows: Cell[][] = p.rounds.flatMap((r) =>
        r.ties.map((t) => [
          r.name,
          t.homeTeamId ? nameOf(t.homeTeamId) : 'Por definir',
          t.bye ? 'Pase directo' : t.aggregate ? `${t.aggregate.home}-${t.aggregate.away}` : '',
          t.awayTeamId ? nameOf(t.awayTeamId) : t.bye ? '—' : 'Por definir',
          t.winnerTeamId ? nameOf(t.winnerTeamId) : '',
          t.decidedBy ? TIE_DECIDED[t.decidedBy] : '',
        ]),
      );
      sections.push({
        kind: 'table',
        title: 'Eliminatoria',
        columns: [
          { label: 'Ronda', type: 'text', weight: 1.6 },
          { label: 'Local', type: 'text' },
          { label: 'Global', type: 'text', weight: 1 },
          { label: 'Visita', type: 'text' },
          { label: 'Avanza', type: 'text' },
          { label: 'Definido por', type: 'text', weight: 1.4 },
        ],
        rows,
        empty: 'La eliminatoria aún no tiene llaves.',
        note: 'Marcador global de cada llave (ida y vuelta sumadas). Los resultados de cada partido están en «Resultados y calendario».',
      });
    }
  }
  return sections;
}

// ─── 2. Resultados y calendario ──────────────────────────────────────────────

export interface MatchRowInput {
  round: number;
  roundLabel: string;
  date: string;
  time: string;
  status: string;
  pendingSchedule: boolean;
  postponedFrom: { date: string; time: string } | null;
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  penalties: { home: number; away: number } | null;
  extraTime: boolean;
  stage: string | null;
  venue: string | null;
  referee: string | null;
}

/** Estado tal como se muestra: un pospuesto que nunca tuvo horario es «Por programar». */
export function statusOf(m: Pick<MatchRowInput, 'status' | 'pendingSchedule'>): string {
  if (m.status === MatchStatus.POSTPONED && m.pendingSchedule) return 'Por programar';
  return MATCH_STATUS_LABEL[m.status] ?? m.status;
}

/** Fecha y hora mostrables: un pospuesto o «por programar» no tiene horario vigente (su fecha es solo referencia). */
export function scheduleOf(m: Pick<MatchRowInput, 'status' | 'date' | 'time'>): { date: string | null; time: string | null } {
  if (m.status === MatchStatus.POSTPONED) return { date: null, time: null };
  return { date: m.date || null, time: /^\d{2}:\d{2}$/.test(m.time) ? m.time : null };
}

export function matchesSection(rows: MatchRowInput[]): TableSection {
  return {
    kind: 'table',
    title: 'Resultados y calendario',
    columns: [
      { label: 'Jornada', type: 'text', weight: 1.4 },
      { label: 'Fecha', type: 'date' },
      { label: 'Hora', type: 'time' },
      { label: 'Local', type: 'text', weight: 2.6 },
      { label: 'Marcador', type: 'text', weight: 1.1 },
      { label: 'Visita', type: 'text', weight: 2.6 },
      { label: 'Estado', type: 'text', weight: 1.5 },
      { label: 'Fase', type: 'text', weight: 1.4 },
      { label: 'Cancha', type: 'text', weight: 2.2 },
      { label: 'Árbitro', type: 'text', weight: 1.8 },
      { label: 'Observaciones', type: 'text', weight: 2.4 },
    ],
    rows: rows.map((m) => {
      const when = scheduleOf(m);
      const played = m.status === MatchStatus.FINISHED && m.homeScore !== null && m.awayScore !== null;
      const notes = [
        m.penalties ? `Penales ${m.penalties.home}-${m.penalties.away}` : null,
        m.extraTime ? 'Tiempo extra' : null,
        m.status === MatchStatus.POSTPONED ? (m.pendingSchedule ? 'Sin horario asignado' : 'Fecha por confirmar') : null,
        m.postponedFrom && m.status !== MatchStatus.POSTPONED ? `Reprogramado (antes ${humanDate(m.postponedFrom.date)} ${m.postponedFrom.time})` : null,
      ].filter(Boolean);
      return [m.roundLabel, when.date, when.time, m.home, played ? `${m.homeScore}-${m.awayScore}` : '', m.away, statusOf(m), m.stage, m.venue, m.referee, notes.join(' · ')];
    }),
    empty: 'No hay partidos con estos filtros.',
    note: 'Pospuestos y partidos por programar no muestran fecha ni hora: la que guardan es solo la referencia de su jornada.',
  };
}

// ─── 3. Goleadores y estadísticas de jugadores ───────────────────────────────

export interface PlayerTotalsRow {
  player: string;
  team: string;
  played: number;
  goals: number;
  assists: number;
  ownGoals: number;
  yellows: number;
  reds: number;
}

/** Orden de goleo: goles, menos partidos, asistencias, nombre; misma posición con mismos goles y partidos. */
export function rankPlayers(rows: PlayerTotalsRow[]): (PlayerTotalsRow & { position: number })[] {
  const sorted = [...rows].sort((a, b) => b.goals - a.goals || a.played - b.played || b.assists - a.assists || a.player.localeCompare(b.player, 'es'));
  return sorted.map((r, i) => {
    let j = i;
    while (j > 0 && sorted[j - 1].goals === r.goals && sorted[j - 1].played === r.played) j--;
    return { ...r, position: j + 1 };
  });
}

export function playersSection(rows: PlayerTotalsRow[], title = 'Goleadores y estadísticas'): TableSection {
  return {
    kind: 'table',
    title,
    columns: [
      { label: 'Pos.', type: 'int', weight: 0.6 },
      { label: 'Jugador', type: 'text', weight: 3.4 },
      { label: 'Equipo', type: 'text', weight: 3 },
      { label: 'PJ', type: 'int' },
      { label: 'Goles', type: 'int' },
      { label: 'Prom.', type: 'decimal' },
      { label: 'Asist.', type: 'int' },
      { label: 'Autogoles', type: 'int', weight: 1.1 },
      { label: 'Amarillas', type: 'int', weight: 1.1 },
      { label: 'Rojas', type: 'int' },
    ],
    rows: rankPlayers(rows).map((r) => [r.position, r.player, r.team, r.played, r.goals, r.played ? Math.round((r.goals / r.played) * 10) / 10 : 0, r.assists, r.ownGoals, r.yellows, r.reds]),
    empty: 'Aún no hay estadísticas de jugadores en partidos finalizados.',
    note: 'Solo partidos finalizados y jugadores que participaron. El equipo es el de su partido más reciente en el torneo. Los autogoles nunca cuentan como goles del jugador.',
  };
}

// ─── 4. Plantillas y jugadores ───────────────────────────────────────────────

export interface RosterTeamRow {
  team: string;
  status: 'ENROLLED' | 'WITHDRAWN';
  active: number;
  inactive: number;
}
export interface RosterPlayerRow {
  team: string;
  jersey: number | null;
  player: string;
  position: string;
  registeredAt: string | null;
  eligibleFrom: string;
  active: boolean;
  endDate: string | null;
  endReason: string | null;
  blocked: { since: string; until: string | null } | null;
}

export function rosterSections(teams: RosterTeamRow[], players: RosterPlayerRow[]): ReportSection[] {
  return [
    {
      kind: 'table',
      title: 'Equipos inscritos',
      columns: [
        { label: 'Equipo', type: 'text', weight: 4 },
        { label: 'Inscripción', type: 'text', weight: 1.5 },
        { label: 'Jugadores activos', type: 'int', weight: 1.4 },
        { label: 'Bajas', type: 'int' },
      ],
      rows: teams.map((t) => [t.team, ENROLLMENT_LABEL[t.status], t.active, t.inactive]),
      totals: teams.length ? ['Total', '', teams.reduce((n, t) => n + t.active, 0), teams.reduce((n, t) => n + t.inactive, 0)] : null,
      empty: 'No hay equipos inscritos.',
    },
    {
      kind: 'table',
      title: 'Jugadores',
      columns: [
        { label: 'Equipo', type: 'text', weight: 2.6 },
        { label: 'Dorsal', type: 'int', weight: 0.8 },
        { label: 'Jugador', type: 'text', weight: 3 },
        { label: 'Posición', type: 'text', weight: 1.2 },
        { label: 'Registrado el', type: 'date' },
        { label: 'Elegible desde', type: 'date' },
        { label: 'Estado', type: 'text', weight: 1.3 },
        { label: 'Observaciones', type: 'text', weight: 2.8 },
      ],
      rows: players.map((p) => [
        p.team,
        p.jersey,
        p.player,
        POSITION_LABEL[p.position] ?? p.position,
        p.registeredAt,
        p.eligibleFrom,
        !p.active ? 'Baja' : p.blocked ? 'Bloqueado' : 'Activo',
        [
          !p.active ? `Baja ${humanDate(p.endDate)}${p.endReason ? `: ${p.endReason}` : ''}` : null,
          p.blocked ? `Bloqueo administrativo desde ${humanDate(p.blocked.since)}${p.blocked.until ? ` hasta ${humanDate(p.blocked.until)}` : ''}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      ]),
      empty: 'No hay jugadores registrados.',
      note: 'Sin datos personales sensibles (fecha de nacimiento, contacto o fotografías). «Elegible desde» es la fecha efectiva de la inscripción; la elegibilidad de cada partido se valida al capturarlo (sanciones y fechas).',
    },
  ];
}

// ─── 5. Disciplina y sanciones ───────────────────────────────────────────────

export interface SanctionRowInput {
  player: string;
  team: string;
  kind: SanctionKind;
  cause: SanctionCause;
  origin: string;
  matches: number;
  served: number;
  remaining: number;
  status: SanctionStatus;
  reason: string | null;
  adjusted: boolean;
}
export interface CardRowInput {
  player: string;
  team: string;
  yellows: number;
  secondYellows: number;
  directReds: number;
  unclassified: number;
  towardNext: number;
  suspended: boolean;
}

export function disciplineSections(sanctions: SanctionRowInput[], cards: CardRowInput[]): ReportSection[] {
  return [
    {
      kind: 'table',
      title: 'Sanciones',
      columns: [
        { label: 'Jugador', type: 'text', weight: 2.6 },
        { label: 'Equipo', type: 'text', weight: 2.4 },
        { label: 'Causa', type: 'text', weight: 2.2 },
        { label: 'Partido de origen', type: 'text', weight: 3 },
        { label: 'Partidos', type: 'int' },
        { label: 'Cumplidos', type: 'int', weight: 1.1 },
        { label: 'Restantes', type: 'int', weight: 1.1 },
        { label: 'Estado', type: 'text', weight: 1.8 },
        { label: 'Motivo', type: 'text', weight: 2.4 },
      ],
      rows: sanctions.map((s) => [
        s.player,
        s.team,
        `${CAUSE_LABEL[s.cause]}${s.kind === SanctionKind.AUTO ? (s.adjusted ? ' (ajustada)' : '') : ''}`,
        s.origin,
        s.matches,
        s.served,
        s.remaining,
        SANCTION_STATUS_LABEL[s.status],
        s.reason ?? '',
      ]),
      totals: sanctions.length ? ['Total', '', '', '', sanctions.reduce((n, s) => n + s.matches, 0), sanctions.reduce((n, s) => n + s.served, 0), sanctions.reduce((n, s) => n + s.remaining, 0), '', ''] : null,
      empty: 'No hay sanciones registradas.',
      note: 'Calculado con el reglamento del torneo (módulo de disciplina): automáticas por tarjetas y manuales del organizador.',
    },
    {
      kind: 'table',
      title: 'Tarjetas por jugador',
      columns: [
        { label: 'Jugador', type: 'text', weight: 2.8 },
        { label: 'Equipo', type: 'text', weight: 2.6 },
        { label: 'Amarillas', type: 'int', weight: 1.1 },
        { label: 'Dobles amarillas', type: 'int', weight: 1.4 },
        { label: 'Rojas directas', type: 'int', weight: 1.3 },
        { label: 'Sin clasificar', type: 'int', weight: 1.2 },
        { label: 'Hacia la siguiente', type: 'int', weight: 1.4 },
        { label: 'Suspendido', type: 'text', weight: 1.1 },
      ],
      rows: cards.map((c) => [c.player, c.team, c.yellows, c.secondYellows, c.directReds, c.unclassified, c.towardNext, c.suspended ? 'Sí' : 'No']),
      totals: cards.length ? ['Total', '', ...(['yellows', 'secondYellows', 'directReds', 'unclassified'] as const).map((k) => cards.reduce((n, c) => n + c[k], 0)), '', ''] : null,
      empty: 'No hay tarjetas registradas.',
      note: '«Amarillas» son las que cuentan para acumular (sin las de una doble amarilla). «Sin clasificar»: expulsiones de capturas anteriores que no generan sanción automática.',
    },
  ];
}

// ─── 6. Finanzas ─────────────────────────────────────────────────────────────

interface Money {
  charged: number;
  paid: number;
  discounted: number;
  refunded: number;
  balance: number;
  due: number;
  credit: number;
}
export interface FinanceInput {
  accounts: (Money & { teamName: string | null; status: string; entries: number })[];
  totals: Money;
  byCategory: { category: string; amount: number; entries: number }[];
  byMethod: { kind: string; method: string | null; amount: number }[];
  entries: { date: string; team: string; kind: string; category: string | null; concept: string; method: string | null; reference: string | null; amount: number; voided: boolean; voidReason: string | null }[];
}

export function financeSections(f: FinanceInput, currency: string): ReportSection[] {
  const money = (label: string) => ({ label, type: 'money' as const });
  return [
    {
      kind: 'kv',
      title: 'Resumen financiero',
      items: [
        ['Cargado', f.totals.charged],
        ['Pagado', f.totals.paid],
        ['Descuentos', f.totals.discounted],
        ['Devoluciones', f.totals.refunded],
        ['Saldo neto', f.totals.balance],
        ['Adeudo total', f.totals.due],
        ['Saldo a favor', f.totals.credit],
      ].map(([k, v]) => [k as string, `${humanMoney(v as number)} ${currency}`]),
    },
    {
      kind: 'table',
      title: 'Saldos por equipo',
      columns: [{ label: 'Equipo', type: 'text', weight: 3.2 }, { label: 'Inscripción', type: 'text', weight: 1.4 }, money('Cargado'), money('Pagado'), money('Descuentos'), money('Devoluciones'), money('Adeudo'), money('Saldo a favor'), { label: 'Movs.', type: 'int', weight: 0.8 }],
      rows: f.accounts.map((a) => [a.teamName ?? '', ENROLLMENT_LABEL[a.status] ?? a.status, a.charged, a.paid, a.discounted, a.refunded, a.due, a.credit, a.entries]),
      totals: ['TOTAL', '', f.totals.charged, f.totals.paid, f.totals.discounted, f.totals.refunded, f.totals.due, f.totals.credit, f.accounts.reduce((n, a) => n + a.entries, 0)],
      empty: 'No hay cuentas.',
      note: 'Mismos cálculos que la pestaña Finanzas: solo movimientos vigentes (los anulados no cuentan).',
    },
    {
      kind: 'table',
      title: 'Cargos por concepto',
      columns: [{ label: 'Concepto', type: 'text', weight: 3 }, { label: 'Movimientos', type: 'int' }, money('Importe')],
      rows: f.byCategory.map((c) => [CATEGORY_LABEL[c.category] ?? c.category, c.entries, c.amount]),
      totals: f.byCategory.length ? ['Total', f.byCategory.reduce((n, c) => n + c.entries, 0), f.byCategory.reduce((n, c) => n + c.amount, 0)] : null,
      empty: 'Sin cargos registrados.',
    },
    {
      kind: 'table',
      title: 'Pagos y devoluciones por método',
      columns: [{ label: 'Movimiento', type: 'text' }, { label: 'Método', type: 'text' }, money('Importe')],
      rows: f.byMethod.map((m) => [KIND_LABEL[m.kind] ?? m.kind, m.method ? (METHOD_LABEL[m.method] ?? m.method) : 'Sin método', m.amount]),
      empty: 'Sin pagos registrados.',
    },
    {
      kind: 'table',
      title: 'Movimientos',
      columns: [
        { label: 'Fecha', type: 'date' },
        { label: 'Equipo', type: 'text', weight: 2.4 },
        { label: 'Movimiento', type: 'text', weight: 1.2 },
        { label: 'Concepto', type: 'text', weight: 3 },
        { label: 'Método', type: 'text', weight: 1.2 },
        { label: 'Referencia', type: 'text', weight: 1.4 },
        money('Cargo'),
        money('Abono'),
        { label: 'Estado', type: 'text', weight: 1.8 },
      ],
      rows: f.entries.map((e) => {
        const up = e.kind === 'CHARGE' || e.kind === 'REFUND';
        const label = e.kind === 'CHARGE' && e.category ? `${KIND_LABEL[e.kind]} · ${CATEGORY_LABEL[e.category] ?? e.category}` : (KIND_LABEL[e.kind] ?? e.kind);
        return [e.date, e.team, label, e.concept, e.method ? (METHOD_LABEL[e.method] ?? e.method) : '', e.reference ?? '', up ? e.amount : null, up ? null : e.amount, e.voided ? `Anulado${e.voidReason ? `: ${e.voidReason}` : ''}` : 'Vigente'];
      }),
      empty: 'No hay movimientos con estos filtros.',
      note: 'En orden cronológico. Los anulados se listan para el control, pero no suman en los saldos.',
    },
  ];
}
