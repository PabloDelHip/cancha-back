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

/**
 * Cobertura de datos de un torneo (6F), independiente de su estado:
 * - FULL: Cancha conoce la competición completa → tabla, goleadores y estructura globales.
 * - PARTIAL: solo se sigue a algunos equipos → sin rankings globales; los partidos registrados
 *   siguen alimentando equipos y jugadores.
 * Documentos anteriores sin el campo = FULL (ver coverageOf).
 */
export enum DataCoverage {
  FULL = 'FULL',
  PARTIAL = 'PARTIAL',
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
