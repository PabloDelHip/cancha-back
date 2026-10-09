export enum PlayerPosition {
  GOALKEEPER = 'GOALKEEPER',
  DEFENDER = 'DEFENDER',
  MIDFIELDER = 'MIDFIELDER',
  FORWARD = 'FORWARD',
}

export enum TournamentFormat {
  FOOTBALL_7 = 'FOOTBALL_7',
  FOOTBALL_11 = 'FOOTBALL_11',
}

/** Campo de compatibilidad: todos los torneos tienen cobertura completa. */
export enum DataCoverage {
  FULL = 'FULL',
}

/** Ciclo de vida: DRAFT → ACTIVE → FINISHED (terminal: historial inmutable). */
export enum TournamentStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  FINISHED = 'FINISHED',
}

/**
 * Formato de competición (Tournament.settings.system). Cada formato es una secuencia de fases
 * (ver modules/competition/formats.ts): añadir uno es declarar sus fases, no tocar la app.
 */
/**
 * Cómo se decide una llave de eliminatoria igualada en el marcador (global).
 * - PENALTIES: tanda de penales.
 * - EXTRA_TIME: tiempos extra (el marcador final los incluye) y, si sigue igualada, penales.
 * - BETTER_POSITION: pasa el mejor posicionado de la fase regular (solo LEAGUE_PLAYOFFS).
 */
export enum KnockoutTiebreak {
  PENALTIES = 'PENALTIES',
  EXTRA_TIME = 'EXTRA_TIME',
  BETTER_POSITION = 'BETTER_POSITION',
}

export enum CompetitionSystem {
  /** Todos contra todos; campeón = líder verificable de la tabla final. */
  LEAGUE = 'LEAGUE',
  /** Eliminación directa (con BYEs si no es potencia de 2). */
  KNOCKOUT = 'KNOCKOUT',
  /** Fase de grupos (liga dentro de cada grupo) + eliminación directa. */
  GROUPS_KNOCKOUT = 'GROUPS_KNOCKOUT',
  /** Fase regular de liga + playoffs con los mejores de la tabla. */
  LEAGUE_PLAYOFFS = 'LEAGUE_PLAYOFFS',
}

/** Tipo de fase de un torneo. */
export enum PhaseType {
  LEAGUE = 'LEAGUE',
  GROUPS = 'GROUPS',
  KNOCKOUT = 'KNOCKOUT',
}

/**
 * - SCHEDULED: programado. LIVE: en juego. FINISHED: con resultado (único que cuenta en la tabla).
 * - POSTPONED: sigue pendiente de jugarse; conserva jornada y equipos y se reprograma.
 * - CANCELLED: no se jugará. Ni POSTPONED ni CANCELLED suman en la tabla.
 */
export enum MatchStatus {
  SCHEDULED = 'SCHEDULED',
  LIVE = 'LIVE',
  FINISHED = 'FINISHED',
  POSTPONED = 'POSTPONED',
  CANCELLED = 'CANCELLED',
}

/**
 * Rol de una cuenta. Por ahora solo existe el organizador de torneos; el enum deja
 * espacio para otros roles sin construir un RBAC. La autorización real se basa en
 * la propiedad del torneo (organizerId), no en el rol.
 */
export enum UserRole {
  ORGANIZER = 'ORGANIZER',
}

/**
 * Rol de un User sobre un Team (global, fuera de cualquier torneo). Un mismo User puede tener
 * roles en varios equipos y además organizar torneos: los roles salen de relaciones, no del User.
 */
export enum TeamAdminRole {
  OWNER = 'OWNER',
  MANAGER = 'MANAGER',
}

/** INACTIVE = acceso retirado; el registro se conserva como auditoría. */
export enum TeamAdminStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

/** Cómo se obtuvo el rol. CLAIM y TRANSFER quedan reservados para etapas futuras. */
export enum TeamAdminSource {
  /** Asignación interna (script administrativo / pruebas). */
  INTERNAL = 'INTERNAL',
  /** Un OWNER agregó al MANAGER. */
  OWNER = 'OWNER',
  /** Creó un equipo NUEVO para sí mismo (inscripción por link, Etapa 7). No es un claim. */
  CREATOR = 'CREATOR',
}

/** Pertenencia GLOBAL de un Player a un Team (TeamRoster), independiente de torneos. */
export enum TeamRosterStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

/** Enlace privado de inscripción de un torneo (Etapa 7). Máximo uno ACTIVE por torneo. */
export enum RegistrationLinkStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

/** Solicitud de inscripción de un equipo a un torneo. Nunca se borra: es historial administrativo. */
export enum RegistrationRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

/**
 * Expulsión registrada en la captura (PlayerMatchStats.sendOff). Capturas anteriores al módulo
 * disciplinario no tienen el campo: si tienen roja o dos amarillas quedan "por clasificar".
 */
export enum SendOff {
  DIRECT = 'DIRECT',
  SECOND_YELLOW = 'SECOND_YELLOW',
}

/** Qué hacer si se captura como jugado a un suspendido: avisar (y registrar) o rechazar. */
export enum EligibilityMode {
  WARN = 'WARN',
  BLOCK = 'BLOCK',
}

export enum SanctionKind {
  /** Derivada del reglamento y las tarjetas; solo se persiste si el organizador la ajusta. */
  AUTO = 'AUTO',
  MANUAL = 'MANUAL',
}

export enum SanctionCause {
  ACCUMULATION = 'ACCUMULATION',
  DIRECT_RED = 'DIRECT_RED',
  SECOND_YELLOW = 'SECOND_YELLOW',
  MANUAL = 'MANUAL',
}

/**
 * - ACTIVE: faltan partidos y el equipo tiene partidos programados para cumplirla.
 * - PENDING: faltan partidos pero no hay ninguno programado (eliminado, calendario sin generar o
 *   torneo finalizado). No se transfiere a otro torneo.
 * - SERVED: cumplida. ANNULLED: anulada por el organizador.
 */
export enum SanctionStatus {
  ACTIVE = 'ACTIVE',
  PENDING = 'PENDING',
  SERVED = 'SERVED',
  ANNULLED = 'ANNULLED',
}

/** Entradas del historial disciplinario (solo se agregan, nunca se borran). */
export enum DisciplineAction {
  RULES_UPDATED = 'RULES_UPDATED',
  SANCTION_CREATED = 'SANCTION_CREATED',
  SANCTION_UPDATED = 'SANCTION_UPDATED',
  SANCTION_ANNULLED = 'SANCTION_ANNULLED',
  SANCTION_RESTORED = 'SANCTION_RESTORED',
  PLAYED_WHILE_SUSPENDED = 'PLAYED_WHILE_SUSPENDED',
}

/** Rol de un árbitro en un partido (Módulo 2B). Un rol activo por partido. */
export enum RefereeRole {
  CENTRAL = 'CENTRAL',
  ASSISTANT_1 = 'ASSISTANT_1',
  ASSISTANT_2 = 'ASSISTANT_2',
  FOURTH = 'FOURTH',
  SCOREKEEPER = 'SCOREKEEPER',
}

/** ABSENT = no se presentó: la asignación se conserva y el sustituto se agrega aparte. */
export enum RefereeAssignmentStatus {
  ASSIGNED = 'ASSIGNED',
  ABSENT = 'ABSENT',
}

/** Historial de partidos (Módulo 2C). Solo se agregan entradas. */
export enum MatchLogAction {
  CREATED = 'CREATED',
  RESCHEDULED = 'RESCHEDULED',
  STATUS_CHANGED = 'STATUS_CHANGED',
  FIELD_CHANGED = 'FIELD_CHANGED',
  TEAMS_CHANGED = 'TEAMS_CHANGED',
  UPDATED = 'UPDATED',
  RESULT_CAPTURED = 'RESULT_CAPTURED',
  RESULT_CORRECTED = 'RESULT_CORRECTED',
  REFEREE_ASSIGNED = 'REFEREE_ASSIGNED',
  REFEREE_REMOVED = 'REFEREE_REMOVED',
  REFEREE_ABSENT = 'REFEREE_ABSENT',
  /** Un partido eliminado (copia y recursos liberados). */
  DELETED = 'DELETED',
  /** Calendario reemplazado: una entrada con todos los partidos eliminados. */
  SCHEDULE_REPLACED = 'SCHEDULE_REPLACED',
}

/** Quién originó el cambio: el organizador o el sistema (p. ej. el cuadro de eliminatoria). */
export enum MatchLogSource {
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}

/** Por qué se eliminó un partido. */
export enum MatchLogCause {
  MANUAL = 'MANUAL',
  SCHEDULE_REGENERATED = 'SCHEDULE_REGENERATED',
  FORMAT_CHANGED = 'FORMAT_CHANGED',
  TIE_REMOVED = 'TIE_REMOVED',
  BRACKET_SYNC = 'BRACKET_SYNC',
}

/** Rol de un colaborador en un torneo (RBAC). El propietario es implícito (Tournament.organizerId). */
export enum TournamentRole {
  ADMIN = 'ADMIN',
  COORDINATOR = 'COORDINATOR',
  SCORER = 'SCORER',
}

/** REVOKED = acceso retirado; la fila se conserva como auditoría. */
export enum TournamentMemberStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

/** Invitación a colaborar (RBAC R2): por enlace de un solo uso o a la cuenta de un correo. */
export enum InvitationKind {
  LINK = 'LINK',
  ACCOUNT = 'ACCOUNT',
}

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
  REVOKED = 'REVOKED',
}
