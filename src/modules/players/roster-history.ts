import { todayISODate } from '../../common/utils/dates.js';
import { MembershipAuditAction } from './schemas/team-membership.schema.js';

/**
 * 3E — historial de plantillas de un torneo, DERIVADO al leer de lo que ya se guarda (no hay una
 * colección propia): auditoría de las participaciones (`TeamMembership.audit`, también la copia de
 * una transferencia anulada y la de un equipo quitado), bloqueos (`player_blocks`), retiros de
 * equipos (`TournamentTeam.audit`), equipos quitados (`removed_enrollments`) y las excepciones de
 * misma fecha deportiva (`match_logs`). Funciones puras: el servicio carga los datos.
 *
 * Sin duplicados: un cambio de equipo deja `MOVED` en la participación que se cierra y `REGISTERED`
 * (con `fromTeamId`) en la nueva; el evento sale una sola vez, de la nueva (o de su copia, si se
 * anuló). Lo anterior a 3A (sin auditoría) sale de las fechas, marcado `legacy` y sin autor.
 */
export enum RosterEventAction {
  REGISTERED = 'REGISTERED',
  /** Vuelve al torneo tras una baja (mismo equipo; con otro es TRANSFER desde 3D). */
  REJOINED = 'REJOINED',
  TRANSFER = 'TRANSFER',
  TRANSFER_ANNULLED = 'TRANSFER_ANNULLED',
  UNREGISTERED = 'UNREGISTERED',
  EXCEPTION = 'EXCEPTION',
  JERSEY_CHANGED = 'JERSEY_CHANGED',
  BLOCKED = 'BLOCKED',
  UNBLOCKED = 'UNBLOCKED',
  TEAM_WITHDRAWN = 'TEAM_WITHDRAWN',
  TEAM_REINSTATED = 'TEAM_REINSTATED',
  TEAM_REMOVED = 'TEAM_REMOVED',
}

export type ExceptionKind = 'RETROACTIVE' | 'OVER_LIMIT' | 'KNOCKOUT' | 'SAME_DATE';

export interface RosterEvent {
  id: string;
  action: RosterEventAction;
  /** Cuándo se registró (ISO). null = registro anterior a 3A: solo se conoce `date`. */
  at: string | null;
  /** `YYYY-MM-DD` efectivo: inicio o fin de la participación, desde o hasta del bloqueo… */
  date: string;
  playerId: string | null;
  teamId: string | null;
  fromTeamId: string | null;
  reason: string | null;
  /** null = sin registro de autor (nunca se inventa). */
  by: { userId: string; role: string | null } | null;
  legacy: boolean;
  details: Record<string, unknown>;
}

type Id = { toHexString(): string } | string;
const hex = (v: Id | null | undefined) => (v == null ? null : typeof v === 'string' ? v : v.toHexString());
const iso = (d: Date | string) => new Date(d).toISOString();

export interface AuditEntry {
  action: string;
  reason: string | null;
  by: Id;
  role: string | null;
  at: Date | string;
  details: Record<string, unknown> | null;
}
export interface MembershipRecord {
  _id: Id;
  playerId: Id;
  teamId: Id;
  startDate: string;
  endDate: string | null;
  active: boolean;
  endReason: string | null;
  audit?: AuditEntry[];
}
export interface BlockRecord {
  _id: Id;
  playerId: Id;
  since: string;
  until: string | null;
  reason: string;
  blockedBy: Id;
  blockedRole: string | null;
  liftReason: string | null;
  liftedBy: Id | null;
  liftedRole: string | null;
  liftedAt: Date | string | null;
  createdAt: Date | string;
}
export interface EnrollmentRecord {
  _id: Id;
  teamId: Id;
  audit?: AuditEntry[];
}
export interface RemovedRecord {
  _id: Id;
  teamId: Id;
  removedBy: Id;
  removedRole: string | null;
  removedAt: Date | string;
  memberships: MembershipRecord[];
}
export interface OverrideRecord {
  _id: Id;
  matchId: Id | null;
  actorId: Id;
  actorRole: string | null;
  reason: string | null;
  createdAt: Date | string;
  changes: { sameDate?: { to?: { playerId: string; teamId: string; matchId: string }[] } } | null;
}

export interface HistorySources {
  memberships: MembershipRecord[];
  blocks: BlockRecord[];
  enrollments: EnrollmentRecord[];
  removed: RemovedRecord[];
  overrides: OverrideRecord[];
}

const EXCEPTION_KIND: Record<string, ExceptionKind> = {
  [MembershipAuditAction.RETROACTIVE]: 'RETROACTIVE',
  [MembershipAuditAction.OVER_LIMIT]: 'OVER_LIMIT',
  [MembershipAuditAction.KNOCKOUT_EXCEPTION]: 'KNOCKOUT',
};

/** Día (fecha local del servidor, como `todayISODate`) en que se registró. */
const dayOf = (at: Date | string) => todayISODate(new Date(at));

export function deriveHistory(src: HistorySources): RosterEvent[] {
  const events: RosterEvent[] = [];
  const all = [
    ...src.memberships.map((m) => ({ m, removedTeam: false })),
    ...src.removed.flatMap((r) => r.memberships.map((m) => ({ m, removedTeam: true }))),
  ];
  // Orden de alta (ObjectId crece con el tiempo): para distinguir una reincorporación.
  const firstOf = new Map<string, string>();
  for (const { m } of [...all].sort((a, b) => hex(a.m._id)!.localeCompare(hex(b.m._id)!))) {
    const p = hex(m.playerId)!;
    if (!firstOf.has(p)) firstOf.set(p, hex(m._id)!);
  }

  const fromAudit = (m: MembershipRecord, key: string, extra: Record<string, unknown>, rejoined: boolean) => {
    const playerId = hex(m.playerId)!;
    const teamId = hex(m.teamId)!;
    const audit = m.audit ?? [];
    audit.forEach((e, k) => {
      const base = {
        id: `${key}:${k}`,
        at: iso(e.at),
        playerId,
        teamId,
        fromTeamId: null as string | null,
        reason: e.reason ?? null,
        by: { userId: hex(e.by)!, role: e.role ?? null },
        legacy: false,
      };
      const details = { ...extra };
      switch (e.action) {
        case MembershipAuditAction.REGISTERED: {
          const from = (e.details?.fromTeamId ?? e.details?.previousTeamId ?? null) as string | null;
          if (e.details?.previousTeamId) details.afterUnregister = true;
          if (e.details?.requestId) details.viaRequest = true;
          const action = from ? RosterEventAction.TRANSFER : rejoined ? RosterEventAction.REJOINED : RosterEventAction.REGISTERED;
          events.push({ ...base, action, date: m.startDate, fromTeamId: from, details });
          break;
        }
        case MembershipAuditAction.RETROACTIVE:
        case MembershipAuditAction.OVER_LIMIT:
        case MembershipAuditAction.KNOCKOUT_EXCEPTION:
          events.push({ ...base, action: RosterEventAction.EXCEPTION, date: dayOf(e.at), details: { ...details, ...e.details, kind: EXCEPTION_KIND[e.action] } });
          break;
        case MembershipAuditAction.UNREGISTERED:
          if (e.details?.teamWithdrawn) details.teamWithdrawn = true;
          events.push({ ...base, action: RosterEventAction.UNREGISTERED, date: m.endDate ?? dayOf(e.at), details });
          break;
        case MembershipAuditAction.JERSEY_CHANGED:
          events.push({ ...base, action: RosterEventAction.JERSEY_CHANGED, date: dayOf(e.at), details: { ...details, from: e.details?.from ?? null, to: e.details?.to ?? null } });
          break;
        case MembershipAuditAction.TRANSFER_ANNULLED: {
          const annulled = (e.details?.annulled ?? {}) as { membershipId?: string; teamId?: string; jerseyNumber?: number | null; startDate?: string; audit?: AuditEntry[] };
          events.push({
            ...base,
            action: RosterEventAction.TRANSFER_ANNULLED,
            date: dayOf(e.at),
            fromTeamId: annulled.teamId ?? null,
            details: { ...details, ...(e.details && 'jerseyCleared' in e.details ? { jerseyCleared: e.details.jerseyCleared } : {}) },
          });
          // La transferencia anulada sigue en el historial (con sus excepciones), marcada.
          if (annulled.teamId && annulled.audit) {
            const copy: MembershipRecord = { _id: annulled.membershipId ?? `${key}a`, playerId, teamId: annulled.teamId, startDate: annulled.startDate ?? m.startDate, endDate: null, active: false, endReason: null, audit: annulled.audit };
            fromAudit(copy, `${key}:${k}:a`, { ...extra, annulled: true }, false);
          }
          break;
        }
        // MOVED: el cambio sale de la participación nueva (sin duplicar).
      }
    });
  };

  for (const { m, removedTeam } of all) {
    const key = `${removedTeam ? 'r' : 'm'}:${hex(m._id)}`;
    const extra = removedTeam ? { removedTeam: true } : {};
    const audit = m.audit ?? [];
    const rejoined = firstOf.get(hex(m.playerId)!) !== hex(m._id);
    if (!audit.some((e) => e.action === MembershipAuditAction.REGISTERED)) {
      // Anterior a 3A: el alta y el cierre salen de sus fechas, sin autor ni hora.
      events.push({ id: `${key}:start`, action: RosterEventAction.REGISTERED, at: null, date: m.startDate, playerId: hex(m.playerId), teamId: hex(m.teamId), fromTeamId: null, reason: null, by: null, legacy: true, details: { ...extra } });
    }
    fromAudit(m, key, extra, rejoined);
    if (!m.active && m.endDate && !audit.some((e) => e.action === MembershipAuditAction.UNREGISTERED || e.action === MembershipAuditAction.MOVED)) {
      events.push({ id: `${key}:end`, action: RosterEventAction.UNREGISTERED, at: null, date: m.endDate, playerId: hex(m.playerId), teamId: hex(m.teamId), fromTeamId: null, reason: m.endReason ?? null, by: null, legacy: true, details: { ...extra } });
    }
  }

  for (const b of src.blocks) {
    const playerId = hex(b.playerId);
    events.push({
      id: `b:${hex(b._id)}:on`,
      action: RosterEventAction.BLOCKED,
      at: iso(b.createdAt),
      date: b.since,
      playerId,
      teamId: null,
      fromTeamId: null,
      reason: b.reason,
      by: { userId: hex(b.blockedBy)!, role: b.blockedRole ?? null },
      legacy: false,
      details: b.since < dayOf(b.createdAt) ? { retroactive: true } : {},
    });
    if (b.until) {
      const at = b.liftedAt ?? b.createdAt;
      events.push({
        id: `b:${hex(b._id)}:off`,
        action: RosterEventAction.UNBLOCKED,
        at: iso(at),
        date: b.until,
        playerId,
        teamId: null,
        fromTeamId: null,
        reason: b.liftReason ?? null,
        by: b.liftedBy ? { userId: hex(b.liftedBy)!, role: b.liftedRole ?? null } : null,
        legacy: false,
        details: b.until < dayOf(at) ? { retroactive: true } : {},
      });
    }
  }

  for (const enrollment of src.enrollments) {
    (enrollment.audit ?? []).forEach((e, k) => {
      const withdrawn = e.action === 'WITHDRAWN';
      const d = e.details ?? {};
      events.push({
        id: `e:${hex(enrollment._id)}:${k}`,
        action: withdrawn ? RosterEventAction.TEAM_WITHDRAWN : RosterEventAction.TEAM_REINSTATED,
        at: iso(e.at),
        date: dayOf(e.at),
        playerId: null,
        teamId: hex(enrollment.teamId),
        fromTeamId: null,
        reason: e.reason ?? null,
        by: { userId: hex(e.by)!, role: e.role ?? null },
        legacy: false,
        details: withdrawn
          ? { cancelledMatches: ((d.cancelledMatchIds as string[] | undefined) ?? []).length, closedMemberships: ((d.closedMemberships as string[] | undefined) ?? []).length }
          : { withdrawnAt: d.withdrawnAt ?? null },
      });
    });
  }

  for (const r of src.removed) {
    events.push({
      id: `r:${hex(r._id)}`,
      action: RosterEventAction.TEAM_REMOVED,
      at: iso(r.removedAt),
      date: dayOf(r.removedAt),
      playerId: null,
      teamId: hex(r.teamId),
      fromTeamId: null,
      reason: null,
      by: { userId: hex(r.removedBy)!, role: r.removedRole ?? null },
      legacy: false,
      details: { memberships: r.memberships.length },
    });
  }

  for (const o of src.overrides) {
    for (const c of o.changes?.sameDate?.to ?? []) {
      events.push({
        id: `o:${hex(o._id)}:${c.playerId}`,
        action: RosterEventAction.EXCEPTION,
        at: iso(o.createdAt),
        date: dayOf(o.createdAt),
        playerId: c.playerId,
        teamId: c.teamId,
        fromTeamId: null,
        reason: o.reason ?? null,
        by: { userId: hex(o.actorId)!, role: o.actorRole ?? null },
        legacy: false,
        details: { kind: 'SAME_DATE', matchId: hex(o.matchId), otherMatchId: c.matchId },
      });
    }
  }
  return events;
}

/**
 * Equipo de cada bloqueo y desbloqueo (para mostrarlos y filtrarlos por equipo): el de la
 * participación del jugador que cubre la fecha o, si no hay, la última que empezó antes. null si
 * nunca jugó el torneo. Las participaciones se agrupan por jugador una sola vez.
 */
export function assignBlockTeams(events: RosterEvent[], memberships: MembershipRecord[]) {
  const byPlayer = new Map<string, MembershipRecord[]>();
  for (const m of memberships) {
    const p = hex(m.playerId)!;
    byPlayer.set(p, [...(byPlayer.get(p) ?? []), m]);
  }
  for (const e of events) {
    if ((e.action === RosterEventAction.BLOCKED || e.action === RosterEventAction.UNBLOCKED) && e.playerId) e.teamId = teamOn(byPlayer.get(e.playerId) ?? [], e.date);
  }
}

/** `own`: participaciones de UN jugador en el torneo. */
export function teamOn(own: MembershipRecord[], date: string): string | null {
  const before = own.filter((m) => m.startDate <= date).sort((a, b) => b.startDate.localeCompare(a.startDate));
  const covering = before.find((m) => !m.endDate || m.endDate > date);
  return hex((covering ?? before[0])?.teamId);
}

export interface HistoryFilter {
  playerId?: string;
  teamId?: string;
  actions?: string[];
  /** `YYYY-MM-DD` inclusivos, sobre el día en que se registró (o la fecha, si es anterior a 3A). */
  from?: string;
  to?: string;
}

/** Día del evento para el filtro de periodo. */
export const eventDay = (e: RosterEvent) => (e.at ? dayOf(e.at) : e.date);

export function filterHistory(events: RosterEvent[], f: HistoryFilter): RosterEvent[] {
  return events.filter(
    (e) =>
      (!f.playerId || e.playerId === f.playerId) &&
      (!f.teamId || e.teamId === f.teamId || e.fromTeamId === f.teamId) &&
      (!f.actions?.length || f.actions.includes(e.action)) &&
      (!f.from || eventDay(e) >= f.from) &&
      (!f.to || eventDay(e) <= f.to),
  );
}

/** Lo más reciente primero; lo anterior a 3A, por su fecha. Desempate estable por id. */
export function sortHistory(events: RosterEvent[]): RosterEvent[] {
  const key = (e: RosterEvent) => e.at ?? `${e.date}T00:00:00.000Z`;
  return [...events].sort((a, b) => key(b).localeCompare(key(a)) || b.id.localeCompare(a.id));
}
