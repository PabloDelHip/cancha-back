import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { Tournament } from '../../modules/tournaments/schemas/tournament.schema.js';
import { Match } from '../../modules/matches/schemas/match.schema.js';
import { Player } from '../../modules/players/schemas/player.schema.js';
import { TeamRoster } from '../../modules/teams/schemas/team-roster.schema.js';
import { TeamAdmin } from '../../modules/teams/schemas/team-admin.schema.js';
import { Team } from '../../modules/teams/schemas/team.schema.js';
import { TeamMembership } from '../../modules/players/schemas/team-membership.schema.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';
import { TeamAdminRole, TeamAdminStatus, TeamRosterStatus, TournamentStatus } from '../enums/index.js';

export const TOURNAMENT_FINISHED_MESSAGE =
  'El torneo está finalizado y no puede modificarse (Tournament is finished and cannot be modified)';

export const TOURNAMENT_NOT_STARTED_MESSAGE =
  'El torneo no ha iniciado: inícialo antes de poner partidos en juego o capturar resultados (Tournament has not started)';

/**
 * Políticas de escritura (ver README → "Ownership"):
 *
 * - Torneo: solo su organizador (organizerId). Sus inscripciones, jornadas, partidos,
 *   resultados y estadísticas heredan esa propiedad: Match → Tournament → organizerId.
 * - Torneo FINISHED = historial inmutable: `tournament()` y `match()` (la puerta de TODAS las
 *   escrituras deportivas) responden 409. Solo `ownedTournament()` lo deja pasar, para las
 *   acciones de ciclo de vida que deciden por sí mismas qué transición es válida.
 *   Las participaciones Player ↔ Team (TeamMembership) viven dentro de un torneo y también
 *   heredan su propiedad: solo el organizador de ESE torneo las crea, mueve o cierra.
 * - Team y Player son globales: cualquiera puede usarlos en SU torneo. Organizar un torneo
 *   NO da ningún permiso sobre la identidad global del Team: eso es TeamAccessService
 *   (OWNER / MANAGER; `createdBy` solo como custodia provisional sin OWNER). Player sigue con
 *   `createdBy` como custodio de la ficha hasta que exista Player claim.
 *
 * - Actividad deportiva (partido LIVE/FINISHED, resultado, estadísticas) solo con el torneo
 *   ACTIVE: en DRAFT se configura y se programa, pero no se juega (`assertStarted`, 409).
 *
 * Cada método devuelve el recurso (404 si no existe, 403 si no es del usuario, 409 si el
 * torneo está finalizado), para que los services no repitan la comprobación ni una segunda lectura.
 *
 * Concurrencia: esas comprobaciones son lecturas previas. Lo que las hace valer bajo
 * concurrencia es `inTournament()`/`lock()`: toda escritura deportiva corre en una transacción
 * que primero escribe el documento del torneo (`writeSeq`) con la condición "no finalizado".
 * Dos transacciones que escriben el mismo documento no pueden confirmarse ambas: la segunda
 * recibe un WriteConflict y el driver la reintenta entera, ya viendo lo que hizo la primera.
 * Así "leer → validar → escribir" (equipo repetido en jornada, pendientes al finalizar,
 * calendario sin historia…) es atómico por torneo, sin locks en memoria ni índices nuevos.
 */
@Injectable()
export class OwnershipService {
  constructor(
    @InjectModel(Tournament.name)
    private readonly tournaments: Model<Tournament>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamRoster.name) private readonly rosters: Model<TeamRoster>,
    @InjectModel(TeamAdmin.name) private readonly teamAdmins: Model<TeamAdmin>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * Ejecuta `fn` en una transacción con el cerrojo del torneo tomado. `fn` puede ejecutarse
   * más de una vez (reintentos por conflicto): solo debe tocar la base con `session`.
   */
  inTournament<T>(
    tournamentId: string | Types.ObjectId,
    fn: (session: ClientSession, status: TournamentStatus) => Promise<T>,
  ): Promise<T> {
    return this.connection.transaction(async (session) =>
      fn(session, await this.lock(tournamentId, session)),
    );
  }

  /**
   * Cerrojo lógico del torneo dentro de una transacción abierta: escribe su documento solo si
   * no está finalizado y devuelve su estado. Hasta el commit, cualquier otra escritura del
   * mismo torneo (incluida la transición a FINISHED) espera o se reintenta.
   */
  async lock(tournamentId: string | Types.ObjectId, session: ClientSession) {
    const locked = await this.tournaments
      .findOneAndUpdate(
        { _id: tournamentId, status: { $ne: TournamentStatus.FINISHED } },
        { $inc: { writeSeq: 1 } },
        { session, timestamps: false, projection: { status: 1 } },
      )
      .lean();
    if (locked) return locked.status;
    if (!(await this.tournaments.exists({ _id: tournamentId }).session(session)))
      throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);
    throw new ConflictException(TOURNAMENT_FINISHED_MESSAGE);
  }

  /** Escritura sobre el torneo o lo que cuelga de él: dueño y torneo no finalizado. */
  async tournament(id: string | Types.ObjectId, user: AuthUser) {
    const tournament = await this.ownedTournament(id, user);
    assertNotFinished(tournament.status);
    return tournament;
  }

  /** Solo propiedad (sin la regla de inmutabilidad): para iniciar/finalizar. */
  async ownedTournament(id: string | Types.ObjectId, user: AuthUser) {
    const tournament = await this.tournaments.findById(id).lean();
    if (!tournament) throw new NotFoundException(`Torneo ${id} no encontrado`);
    if (!isOwner(tournament.organizerId, user)) {
      throw new ForbiddenException(
        'No tienes permiso para modificar este torneo',
      );
    }
    return tournament;
  }

  /** Escritura sobre un partido (datos, estado, resultado, estadísticas). */
  async match(id: string, user: AuthUser) {
    const match = await this.matches.findById(id).lean();
    if (!match) throw new NotFoundException(`Partido ${id} no encontrado`);
    const tournament = await this.tournaments
      .findById(match.tournamentId)
      .select('organizerId status')
      .lean();
    if (!tournament || !isOwner(tournament.organizerId, user)) {
      throw new ForbiddenException(
        'No tienes permiso para modificar partidos de este torneo',
      );
    }
    assertNotFinished(tournament.status);
    return match;
  }

  async player(id: string | Types.ObjectId, user: AuthUser) {
    const player = await this.players.findById(id).lean();
    if (!player) throw new NotFoundException(`Jugador ${id} no encontrado`);
    if (!isOwner(player.createdBy, user))
      throw new ForbiddenException(
        'Solo quien registró este jugador puede modificarlo',
      );
    return player;
  }

  /**
   * Editar la ficha (datos y foto). Borrar la ficha sigue siendo solo de quien la registró (`player`).
   * Ver `editablePlayerIds` para quién puede.
   */
  async editablePlayer(id: string | Types.ObjectId, user: AuthUser) {
    const player = await this.players.findById(id).lean();
    if (!player) throw new NotFoundException(`Jugador ${id} no encontrado`);
    if (isOwner(player.createdBy, user)) return player;
    if (!(await this.editablePlayerIds([player._id], user)).has(player._id.toHexString())) {
      throw new ForbiddenException('Solo quien registró este jugador o quien administra su equipo puede modificarlo');
    }
    return player;
  }

  /**
   * De estos jugadores, cuáles puede editar el usuario además de los que registró (consultas fijas):
   * - OWNER/MANAGER activo de un equipo con el jugador en su plantilla ACTUAL (TeamRoster ACTIVE).
   * - Custodio de un equipo sin cuenta (lo dio de alta él y no tiene OWNER activo, p. ej. el
   *   organizador que lo inscribió) con el jugador en su plantilla actual o jugando con él en un
   *   torneo no finalizado (TeamMembership activa). En cuanto el equipo tiene OWNER, se acaba.
   */
  async editablePlayerIds(playerIds: Types.ObjectId[], user: AuthUser): Promise<Set<string>> {
    if (!playerIds.length) return new Set();
    const me = new Types.ObjectId(user.id);
    const [roster, playing] = await Promise.all([
      this.rosters.find({ playerId: { $in: playerIds }, status: TeamRosterStatus.ACTIVE }).select('playerId teamId').lean(),
      this.memberships.find({ playerId: { $in: playerIds }, active: true }).select('playerId teamId tournamentId').lean(),
    ]);
    // Un torneo finalizado es historia: jugar ahí con el equipo no da permiso para siempre.
    const finished = new Set(
      (await this.tournaments.distinct('_id', { _id: { $in: playing.map((m) => m.tournamentId) }, status: TournamentStatus.FINISHED })).map(String),
    );
    const links = [
      ...roster.map((r) => ({ playerId: r.playerId, teamId: r.teamId, roster: true })),
      ...playing.filter((m) => !finished.has(String(m.tournamentId))).map((m) => ({ playerId: m.playerId, teamId: m.teamId, roster: false })),
    ];
    if (!links.length) return new Set();
    const teamIds = [...new Map(links.map((l) => [l.teamId.toHexString(), l.teamId])).values()];
    const [admins, custodied] = await Promise.all([
      this.teamAdmins.find({ teamId: { $in: teamIds }, status: TeamAdminStatus.ACTIVE, $or: [{ userId: me }, { role: TeamAdminRole.OWNER }] }).select('teamId userId role').lean(),
      this.teams.find({ _id: { $in: teamIds }, createdBy: me }).select('_id').lean(),
    ]);
    const managed = new Set(admins.filter((a) => a.userId.equals(me)).map((a) => a.teamId.toHexString()));
    const owned = new Set(admins.filter((a) => a.role === TeamAdminRole.OWNER).map((a) => a.teamId.toHexString()));
    const custodian = new Set(custodied.map((t) => t._id.toHexString()).filter((id) => !owned.has(id)));
    return new Set(
      links
        .filter((l) => custodian.has(l.teamId.toHexString()) || (l.roster && managed.has(l.teamId.toHexString())))
        .map((l) => l.playerId.toHexString()),
    );
  }
}

function assertNotFinished(status: TournamentStatus) {
  if (status === TournamentStatus.FINISHED) {
    throw new ConflictException(TOURNAMENT_FINISHED_MESSAGE);
  }
}

/** Poner un partido en juego, finalizarlo o capturar su resultado exige el torneo ACTIVE. */
export function assertStarted(status: TournamentStatus) {
  if (status !== TournamentStatus.ACTIVE) {
    throw new ConflictException(
      status === TournamentStatus.FINISHED ? TOURNAMENT_FINISHED_MESSAGE : TOURNAMENT_NOT_STARTED_MESSAGE,
    );
  }
}

function isOwner(
  ownerId: Types.ObjectId | null | undefined,
  user: AuthUser,
): boolean {
  return ownerId != null && ownerId.toHexString() === user.id;
}
