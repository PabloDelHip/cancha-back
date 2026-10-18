/**
 * Permisos por torneo (RBAC, R1). Los servicios piden un PERMISO, nunca un rol: cambiar quién
 * puede qué es cambiar esta matriz. El propietario (Tournament.organizerId) tiene todos.
 */
import { TournamentRole } from '../enums/index.js';

export enum Permission {
  /** Panel del torneo (lecturas administrativas). */
  VIEW = 'VIEW',
  /** Información, configuración, formato, logo. */
  SETTINGS = 'SETTINGS',
  /** Iniciar / finalizar el torneo. */
  LIFECYCLE = 'LIFECYCLE',
  /** Eliminar el torneo y cambiarlo de liga. */
  DELETE = 'DELETE',
  /** Administrar colaboradores. */
  MEMBERS = 'MEMBERS',
  /** Equipos inscritos, plantillas e inscripciones por enlace. */
  TEAMS = 'TEAMS',
  /** Calendario: jornadas, partidos, reprogramar/posponer/cancelar, cruces, avanzar de fase. */
  SCHEDULE = 'SCHEDULE',
  /** Cancha y árbitros de los partidos (asignaciones, ausencias). */
  ASSIGNMENTS = 'ASSIGNMENTS',
  /** Capturar o corregir resultado y estadísticas. */
  RESULTS = 'RESULTS',
  /** Reglamento y sanciones. */
  DISCIPLINE_MANAGE = 'DISCIPLINE_MANAGE',
  /** Consultar disciplina y la elegibilidad al capturar. */
  DISCIPLINE_VIEW = 'DISCIPLINE_VIEW',
  /** Historial de partidos. */
  LOGS_VIEW = 'LOGS_VIEW',
  /** Registrar, resolver y anular incidencias; suspender y reanudar partidos (2C-2). */
  INCIDENTS = 'INCIDENTS',
  /** Corregir (anular, VOID) ausencias y sustituciones arbitrales con motivo (2C-2). */
  REFEREE_CORRECTIONS = 'REFEREE_CORRECTIONS',
  /** Cerrar la ficha técnica de un partido (2D): congela la información deportiva. */
  SHEET_CLOSE = 'SHEET_CLOSE',
  /** Reabrir una ficha cerrada, con motivo (2D). */
  SHEET_REOPEN = 'SHEET_REOPEN',
  /** Subir fotografías de evidencia (2D). */
  EVIDENCE_UPLOAD = 'EVIDENCE_UPLOAD',
  /** Retirar una fotografía de evidencia, con motivo (2D). */
  EVIDENCE_REMOVE = 'EVIDENCE_REMOVE',
  /** Teléfono y correo de los árbitros del propietario (dentro del torneo). */
  REFEREE_CONTACT = 'REFEREE_CONTACT',
  /**
   * Excepciones de inscripción (3A), siempre con motivo y auditadas: superar el máximo de
   * jugadores por equipo, elegibilidad con fecha retroactiva y permitir que un jugador figure con
   * dos equipos en la misma fecha deportiva. Solo propietario y administradores.
   */
  REGISTRATION_EXCEPTIONS = 'REGISTRATION_EXCEPTIONS',
  /** Módulo 4: consultar cuentas y movimientos financieros del torneo (propietario y administradores). */
  FINANCE_VIEW = 'FINANCE_VIEW',
  /** Módulo 4: registrar cargos y pagos (propietario y administradores). */
  FINANCE_MANAGE = 'FINANCE_MANAGE',
}

export type AccessRole = 'OWNER' | TournamentRole;

const ALL = Object.values(Permission);

export const ROLE_PERMISSIONS: Record<AccessRole, ReadonlySet<Permission>> = {
  OWNER: new Set(ALL),
  [TournamentRole.ADMIN]: new Set(ALL.filter((p) => p !== Permission.DELETE && p !== Permission.MEMBERS)),
  [TournamentRole.COORDINATOR]: new Set([
    Permission.VIEW,
    Permission.SCHEDULE,
    Permission.ASSIGNMENTS,
    Permission.INCIDENTS,
    Permission.REFEREE_CORRECTIONS,
    Permission.EVIDENCE_UPLOAD,
    Permission.DISCIPLINE_VIEW,
    Permission.LOGS_VIEW,
    Permission.REFEREE_CONTACT,
  ]),
  [TournamentRole.SCORER]: new Set([Permission.VIEW, Permission.RESULTS, Permission.EVIDENCE_UPLOAD, Permission.DISCIPLINE_VIEW, Permission.LOGS_VIEW]),
};

export const can = (role: AccessRole | null, permission: Permission) => !!role && ROLE_PERMISSIONS[role].has(permission);
export const permissionsOf = (role: AccessRole | null) => (role ? [...ROLE_PERMISSIONS[role]] : []);

/** Máximo de colaboradores ACTIVOS por torneo (decisión del organizador). */
export const MAX_TOURNAMENT_MEMBERS = 20;
