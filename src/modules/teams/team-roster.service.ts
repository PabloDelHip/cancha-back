import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { TeamRoster } from './schemas/team-roster.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { newPlayerFields } from '../players/players.service.js';
import { PlayerDuplicatesService } from '../players/player-duplicates.service.js';
import { TeamRosterStatus } from '../../common/enums/index.js';
import { TeamAccessService } from '../../common/authorization/team-access.service.js';
import { publicPlayer } from '../../common/utils/public.js';
import { todayISODate } from '../../common/utils/dates.js';
import { toObjectId } from '../../common/utils/serialize.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { CreateRosterPlayerDto, RosterView } from './dto/team-roster.dto.js';

const ACTIVE = TeamRosterStatus.ACTIVE;
const isDuplicateKey = (e: unknown) => e instanceof mongo.MongoServerError && e.code === 11000;
const POSITION_ORDER = ['GOALKEEPER', 'DEFENDER', 'MIDFIELDER', 'FORWARD'];

/**
 * Plantilla GLOBAL del equipo (TeamRoster). Autoridad: SOLO TeamAccessService.requireManager
 * (OWNER o MANAGER). Ni `createdBy` (la custodia provisional de 6A no se extiende aquí) ni ser
 * organizador de un torneo donde juega el equipo dan acceso.
 *
 * Nunca toca TeamMembership, partidos ni estadísticas: la participación en torneos es otra
 * relación que controla el organizador de cada torneo.
 */
@Injectable()
export class TeamRosterService {
  constructor(
    @InjectModel(TeamRoster.name) private readonly roster: Model<TeamRoster>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectConnection() private readonly connection: Connection,
    private readonly access: TeamAccessService,
    private readonly duplicates: PlayerDuplicatesService,
  ) {}

  /** GET /teams/:id/global-roster — OWNER/MANAGER. Por defecto la plantilla actual (ACTIVE). */
  async list(teamId: string, view: RosterView, user: AuthUser) {
    await this.access.requireManager(teamId, user);
    return { teamId, status: view, players: await this.periods(teamId, view) };
  }

  /** POST /teams/:id/global-roster — alta (o reincorporación) de un Player existente. Ver ensureActive. */
  async add(teamId: string, playerId: string, user: AuthUser) {
    await this.access.requireManager(teamId, user);
    const player = await this.players.findById(playerId).select('_id').lean();
    if (!player) throw new NotFoundException(`Jugador ${playerId} no encontrado`);
    return this.ensureActive(teamId, player._id, user);
  }

  /**
   * POST /teams/:id/global-roster/players — crear un Player NUEVO (global, sin User) y dejarlo
   * ACTIVE en la plantilla. Mismo permiso que el alta (OWNER/MANAGER), comprobado ANTES de escribir:
   * quien no administra el equipo no crea fichas por esta vía.
   *
   * - Player + TeamRoster en una transacción: o quedan ambos o ninguno (sin fichas huérfanas).
   * - `requestId` (idempotencia por usuario, índice único parcial en players): un doble clic o un
   *   reintento devuelve el jugador ya creado (`created: false`) y garantiza su periodo ACTIVE.
   * - No busca parecidos ni fusiona por nombre: la búsqueda previa es responsabilidad de la UI.
   * - No toca TeamMembership, TournamentTeam, partidos ni estadísticas.
   */
  async createAndAdd(teamId: string, dto: CreateRosterPlayerDto, user: AuthUser) {
    await this.access.requireManager(teamId, user);
    const { requestId, ...fields } = dto;
    const key = { createdBy: toObjectId(user.id), creationRequestId: requestId };
    const replay = async () => {
      const existing = await this.players.findOne(key).select('_id').lean();
      return existing && this.ensureActive(teamId, existing._id, user);
    };
    const previous = await replay();
    if (previous) return previous;
    // Posibles duplicados → 409 con candidatos (después del reintento: si no, el jugador recién
    // creado se detectaría como duplicado de sí mismo). `confirmNew` lo omite.
    await this.duplicates.assertNoneOrConfirmed(fields);
    let playerId!: Types.ObjectId;
    try {
      await this.connection.transaction(async (session) => {
        const [player] = await this.players.create([{ ...newPlayerFields(fields, user), creationRequestId: requestId }], { session });
        await this.roster.create(
          [{ teamId: toObjectId(teamId), playerId: player._id, status: ACTIVE, joinedAt: todayISODate(), leftAt: null, addedBy: toObjectId(user.id) }],
          { session },
        );
        playerId = player._id;
      });
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // Otra petición con la misma clave ganó la carrera: mismo resultado que un reintento.
      const raced = await replay();
      if (!raced) throw e;
      return raced;
    }
    const [period] = await this.periods(teamId, 'active', playerId.toHexString());
    return { created: true, period };
  }

  /**
   * Garantiza un periodo ACTIVE. Idempotente: si ya está ACTIVE responde el periodo vigente
   * (`created: false`). Dos altas simultáneas: una inserta y la otra choca con el índice único
   * parcial y resuelve igual. Si tuvo periodos anteriores, se abre uno nuevo (reincorporación)
   * sin tocar los cerrados.
   */
  private async ensureActive(teamId: string, playerId: Types.ObjectId, user: AuthUser) {
    const key = { teamId: toObjectId(teamId), playerId };
    let created = false;
    if (!(await this.roster.exists({ ...key, status: ACTIVE }))) {
      try {
        await this.roster.create({ ...key, status: ACTIVE, joinedAt: todayISODate(), leftAt: null, addedBy: toObjectId(user.id) });
        created = true;
      } catch (e) {
        if (!isDuplicateKey(e)) throw e; // otra alta ganó la carrera: el resultado es el mismo
      }
    }
    const [period] = await this.periods(teamId, 'active', playerId.toHexString());
    return { created, period };
  }

  /**
   * DELETE /teams/:id/global-roster/:playerId — cierra el periodo ACTIVE (leftAt = hoy). Una sola
   * escritura condicional: dos bajas simultáneas → una cierra y la otra no encuentra ACTIVE.
   * Idempotente: sin periodo activo pero con historia en el equipo → 204; nunca estuvo → 404.
   */
  async remove(teamId: string, playerId: string, user: AuthUser) {
    await this.access.requireManager(teamId, user);
    const key = { teamId: toObjectId(teamId), playerId: toObjectId(playerId) };
    const res = await this.roster.updateOne(
      { ...key, status: ACTIVE },
      { $set: { status: TeamRosterStatus.INACTIVE, leftAt: todayISODate(), removedBy: toObjectId(user.id) } },
    );
    if (!res.modifiedCount && !(await this.roster.exists(key))) {
      throw new NotFoundException('El jugador no pertenece ni perteneció a la plantilla de este equipo');
    }
  }

  /** Plantilla actual pública (perfil del equipo): solo ACTIVE, solo datos deportivos públicos. */
  async currentPublic(teamId: string) {
    return (await this.periods(teamId, 'active')).map(({ player, joinedAt }) => ({ player, joinedAt }));
  }

  /** Periodos con su Player en 2 consultas (sin N+1). Actual: por posición y apellido. */
  private async periods(teamId: string, view: RosterView, playerId?: string) {
    const filter: Record<string, unknown> = { teamId: toObjectId(teamId) };
    if (view !== 'all') filter.status = view === 'active' ? ACTIVE : TeamRosterStatus.INACTIVE;
    if (playerId) filter.playerId = toObjectId(playerId);
    const rows = await this.roster.find(filter).sort({ joinedAt: -1, _id: -1 }).lean();
    const players = await this.players.find({ _id: { $in: [...new Set(rows.map((r) => r.playerId))] } }).lean();
    const byId = new Map(players.map((p) => [p._id.toHexString(), publicPlayer(p)]));
    const list = rows
      .filter((r) => byId.has(r.playerId.toHexString()))
      .map((r) => {
        const { createdAt: _c, updatedAt: _u, ...player } = byId.get(r.playerId.toHexString())!;
        return { periodId: r._id.toHexString(), player, status: r.status, joinedAt: r.joinedAt, leftAt: r.leftAt };
      });
    if (view === 'active') {
      list.sort(
        (a, b) =>
          POSITION_ORDER.indexOf(a.player.position) - POSITION_ORDER.indexOf(b.player.position) ||
          a.player.lastName.localeCompare(b.player.lastName) ||
          a.player.firstName.localeCompare(b.player.firstName),
      );
    }
    return list;
  }
}
