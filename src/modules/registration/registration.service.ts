import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { RegistrationLink } from './schemas/registration-link.schema.js';
import { RegistrationDraft } from './schemas/registration-draft.schema.js';
import { RegistrationRequest } from './schemas/registration-request.schema.js';
import { DEFAULT_REGISTRATION, Tournament, TournamentRegistrationSettings } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { TeamAdmin } from '../teams/schemas/team-admin.schema.js';
import { TeamRoster } from '../teams/schemas/team-roster.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { User } from '../users/schemas/user.schema.js';
import {
  RegistrationLinkStatus,
  RegistrationRequestStatus,
  TeamAdminRole,
  TeamAdminSource,
  TeamAdminStatus,
  TeamRosterStatus,
  TournamentStatus,
} from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { TeamAccessService } from '../../common/authorization/team-access.service.js';
import { publicPlayer, teamRef } from '../../common/utils/public.js';
import { todayISODate } from '../../common/utils/dates.js';
import { toObjectId } from '../../common/utils/serialize.js';
import { deriveShortName } from '../teams/teams.service.js';
import type { CreateTeamDto } from '../teams/dto/team.dto.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { EnvConfig } from '../../config/env.validation.js';
import type { SaveRegistrationDraftDto, SubmitRegistrationDto, UpdateRegistrationSettingsDto } from './dto/registration.dto.js';
import {
  decryptRegistrationToken,
  encryptRegistrationToken,
  hashRegistrationToken,
  newRegistrationToken,
  TOKEN_PATTERN,
} from './registration-token.js';

const PENDING = RegistrationRequestStatus.PENDING;
const isDuplicateKey = (e: unknown) => e instanceof mongo.MongoServerError && e.code === 11000;
const INVALID_LINK = 'Este enlace de inscripción no es válido o fue revocado.';

export type ClosedReason = 'FINISHED' | 'DISABLED' | 'DEADLINE' | 'FULL';
const CLOSED_MESSAGE: Record<ClosedReason, string> = {
  FINISHED: 'El torneo ya terminó: las inscripciones están cerradas.',
  DISABLED: 'Las inscripciones de este torneo están cerradas.',
  DEADLINE: 'La fecha límite de inscripción ya pasó.',
  FULL: 'El torneo ya no tiene lugares disponibles.',
};

/** Problema de una selección (envío, detalle del organizador y aprobación usan la misma función). */
export interface SelectionProblem {
  code: 'TEAM_NOT_FOUND' | 'ALREADY_ENROLLED' | 'FULL' | 'PLAYER_NOT_FOUND' | 'NOT_IN_ROSTER' | 'OTHER_TEAM' | 'TOO_FEW' | 'TOO_MANY';
  message: string;
  playerIds?: string[];
}

type LeanTournament = { _id: Types.ObjectId; status: TournamentStatus; registration?: TournamentRegistrationSettings | null };
type LeanRequest = RegistrationRequest & { _id: Types.ObjectId };

/**
 * Inscripción de equipos por link (Etapa 7). Conecta identidades EXISTENTES (User, Team, TeamAdmin,
 * TeamRoster, Player) con un Tournament; al aprobar produce las mismas estructuras que el flujo
 * manual del organizador (TournamentTeam + TeamMembership), con sus mismos índices y el mismo
 * cerrojo del torneo. Permisos por relación: organizador = Tournament.organizerId (OwnershipService);
 * quien inscribe = OWNER/MANAGER del equipo (TeamAccessService). El link NO autoriza nada: solo
 * da acceso al flujo. Nunca se usa User.role.
 */
@Injectable()
export class RegistrationService {
  private readonly secret: string;

  constructor(
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(RegistrationLink.name) private readonly links: Model<RegistrationLink>,
    @InjectModel(RegistrationRequest.name) private readonly requests: Model<RegistrationRequest>,
    @InjectModel(RegistrationDraft.name) private readonly drafts: Model<RegistrationDraft>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(TeamAdmin.name) private readonly admins: Model<TeamAdmin>,
    @InjectModel(TeamRoster.name) private readonly rosters: Model<TeamRoster>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ownership: OwnershipService,
    private readonly access: TeamAccessService,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.secret = config.get('JWT_REFRESH_SECRET', { infer: true });
  }

  // ─── Estado de la inscripción ─────────────────────────────────────────────

  private settingsOf(t: LeanTournament): TournamentRegistrationSettings {
    return { ...DEFAULT_REGISTRATION, ...t.registration, approvalRequired: true };
  }

  /** ¿Acepta solicitudes nuevas? FINISHED es terminal; deadline inclusiva (día del servidor). */
  private closedReason(t: LeanTournament, enrolledCount: number): ClosedReason | null {
    const r = this.settingsOf(t);
    if (t.status === TournamentStatus.FINISHED) return 'FINISHED';
    if (!r.enabled) return 'DISABLED';
    if (r.deadline && todayISODate() > r.deadline) return 'DEADLINE';
    if (r.maxTeams !== null && enrolledCount >= r.maxTeams) return 'FULL';
    return null;
  }

  private enrolledCount(tournamentId: Types.ObjectId, session?: ClientSession) {
    return this.enrollments.countDocuments({ tournamentId }).session(session ?? null);
  }

  // ─── Organizador: configuración y enlace ──────────────────────────────────

  async settings(tournamentId: string, user: AuthUser) {
    const t = await this.ownership.ownedTournament(tournamentId, user);
    const id = t._id;
    const [link, enrolled, counts] = await Promise.all([
      this.links.findOne({ tournamentId: id, status: RegistrationLinkStatus.ACTIVE }).select('+tokenCiphertext createdAt').lean(),
      this.enrolledCount(id),
      this.countsOf(id),
    ]);
    const reason = this.closedReason(t, enrolled);
    return {
      registration: this.settingsOf(t),
      open: reason === null,
      closedReason: reason,
      enrolledTeams: enrolled,
      link: link ? { token: decryptRegistrationToken(link.tokenCiphertext, this.secret), createdAt: link.createdAt } : null,
      counts,
    };
  }

  async updateSettings(tournamentId: string, dto: UpdateRegistrationSettingsDto, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user);
    await this.ownership.inTournament(tournamentId, async (session) => {
      const t = await this.tournaments.findById(tournamentId).select('status registration').session(session).lean<LeanTournament>();
      const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
      const next = { ...this.settingsOf(t!), ...patch, approvalRequired: true };
      if (next.minPlayers !== null && next.maxPlayers !== null && next.minPlayers > next.maxPlayers) {
        throw new BadRequestException('El mínimo de jugadores no puede ser mayor que el máximo');
      }
      const enrolled = await this.enrolledCount(t!._id, session);
      if (next.maxTeams !== null && next.maxTeams < enrolled) {
        throw new BadRequestException(`Ya hay ${enrolled} equipos inscritos: el cupo no puede ser menor`);
      }
      await this.tournaments.updateOne({ _id: t!._id }, { $set: { registration: next } }, { session });
    });
    return this.settings(tournamentId, user);
  }

  /** Genera (o regenera) el enlace: revoca el ACTIVE anterior y crea otro en la misma transacción. */
  async generateLink(tournamentId: string, user: AuthUser) {
    await this.ownership.tournament(tournamentId, user);
    const token = newRegistrationToken();
    await this.ownership.inTournament(tournamentId, async (session) => {
      const id = toObjectId(tournamentId);
      await this.links.updateMany(
        { tournamentId: id, status: RegistrationLinkStatus.ACTIVE },
        { $set: { status: RegistrationLinkStatus.REVOKED, revokedAt: new Date(), revokedBy: toObjectId(user.id) } },
        { session },
      );
      await this.links.create(
        [{ tournamentId: id, tokenHash: hashRegistrationToken(token), tokenCiphertext: encryptRegistrationToken(token, this.secret), createdBy: toObjectId(user.id) }],
        { session },
      );
    });
    return this.settings(tournamentId, user);
  }

  /** Revoca el enlace activo. Las solicitudes ya enviadas se conservan y se siguen revisando. */
  async revokeLink(tournamentId: string, user: AuthUser) {
    const t = await this.ownership.ownedTournament(tournamentId, user);
    const res = await this.links.updateOne(
      { tournamentId: t._id, status: RegistrationLinkStatus.ACTIVE },
      { $set: { status: RegistrationLinkStatus.REVOKED, revokedAt: new Date(), revokedBy: toObjectId(user.id) } },
    );
    if (!res.modifiedCount) throw new NotFoundException('El torneo no tiene un enlace de inscripción activo');
  }

  // ─── Organizador: solicitudes ─────────────────────────────────────────────

  async listRequests(tournamentId: string, status: RegistrationRequestStatus | undefined, user: AuthUser) {
    const t = await this.ownership.ownedTournament(tournamentId, user);
    const [rows, counts] = await Promise.all([
      this.requests.find({ tournamentId: t._id, ...(status ? { status } : {}) }).sort({ createdAt: -1, _id: -1 }).lean<LeanRequest[]>(),
      this.countsOf(t._id),
    ]);
    return { counts, requests: await this.summaries(rows) };
  }

  async getRequest(tournamentId: string, requestId: string, user: AuthUser) {
    const t = await this.ownership.ownedTournament(tournamentId, user);
    return this.detail(t, requestId);
  }

  /**
   * Aprobación ATÓMICA dentro del cerrojo del torneo (mismo mecanismo que toda escritura
   * deportiva): revalida TODO con datos actuales y crea TournamentTeam + una TeamMembership por
   * jugador + marca la solicitud APPROVED, o no hace nada. Dos aprobaciones simultáneas (misma
   * solicitud o último cupo) se serializan: la segunda ve el resultado de la primera.
   */
  async approve(tournamentId: string, requestId: string, user: AuthUser) {
    const owned = await this.ownership.tournament(tournamentId, user);
    await this.ownership.inTournament(tournamentId, async (session) => {
      const request = await this.requests.findOne({ _id: toObjectId(requestId), tournamentId: owned._id }).session(session).lean<LeanRequest>();
      if (!request) throw new NotFoundException('Solicitud no encontrada');
      if (request.status !== PENDING) throw new ConflictException(this.notPendingMessage(request.status));
      const t = await this.tournaments.findById(owned._id).select('status registration').session(session).lean<LeanTournament>();
      const problems = await this.problemsOf(t!, request.teamId, request.playerIds, session);
      if (problems.length) throw new ConflictException({ message: problems.map((p) => p.message).join(' '), problems });

      await this.enrollments.create([{ tournamentId: owned._id, teamId: request.teamId }], { session });
      const startDate = todayISODate();
      await this.memberships.insertMany(
        request.playerIds.map((playerId) => ({ playerId, teamId: request.teamId, tournamentId: owned._id, jerseyNumber: null, startDate, endDate: null, active: true })),
        { session },
      );
      const res = await this.requests.updateOne(
        { _id: request._id, status: PENDING },
        { $set: { status: RegistrationRequestStatus.APPROVED, reviewedAt: new Date(), reviewedBy: toObjectId(user.id) } },
        { session },
      );
      if (!res.modifiedCount) throw new ConflictException('La solicitud cambió mientras se aprobaba; vuelve a intentarlo');
    });
    return this.detail(owned, requestId);
  }

  async reject(tournamentId: string, requestId: string, reason: string | null | undefined, user: AuthUser) {
    const t = await this.ownership.tournament(tournamentId, user);
    const res = await this.requests.updateOne(
      { _id: toObjectId(requestId), tournamentId: t._id, status: PENDING },
      { $set: { status: RegistrationRequestStatus.REJECTED, reviewedAt: new Date(), reviewedBy: toObjectId(user.id), rejectionReason: reason?.trim() || null } },
    );
    if (!res.modifiedCount) {
      const current = await this.requests.findOne({ _id: toObjectId(requestId), tournamentId: t._id }).select('status').lean();
      if (!current) throw new NotFoundException('Solicitud no encontrada');
      throw new ConflictException(this.notPendingMessage(current.status));
    }
    return this.detail(t, requestId);
  }

  // ─── Por enlace (quien inscribe) ──────────────────────────────────────────

  /** Resolución PÚBLICA del enlace: solo lo necesario para decidir si inscribirse. */
  async resolve(token: string) {
    const { tournament } = await this.activeLink(token);
    const enrolled = await this.enrolledCount(tournament._id);
    const reason = this.closedReason(tournament, enrolled);
    const r = this.settingsOf(tournament);
    return {
      tournament: {
        id: tournament._id.toHexString(),
        name: tournament.name,
        format: tournament.format,
        category: tournament.category,
        startDate: tournament.startDate,
        endDate: tournament.endDate,
        venue: tournament.venue,
        status: tournament.status,
      },
      registration: {
        open: reason === null,
        closedReason: reason,
        deadline: r.deadline,
        minPlayers: r.minPlayers,
        maxPlayers: r.maxPlayers,
        maxTeams: r.maxTeams,
        spotsLeft: r.maxTeams === null ? null : Math.max(0, r.maxTeams - enrolled),
      },
    };
  }

  /**
   * Equipos que la persona ADMINISTRA (OWNER/MANAGER) con su estado en este torneo: inscrito o no
   * y su historial de solicitudes. Consultas fijas, sin importar cuántos equipos o solicitudes.
   */
  async mine(token: string, user: AuthUser) {
    const { tournament } = await this.activeLink(token);
    const roles = await this.admins.find({ userId: toObjectId(user.id), status: TeamAdminStatus.ACTIVE }).select('teamId role').lean();
    const teamIds = roles.map((r) => r.teamId);
    const [teams, sizes, enrolled, requests] = await Promise.all([
      this.teams.find({ _id: { $in: teamIds } }).select('name shortName logoUrl colors city').sort({ name: 1 }).lean(),
      this.rosters.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { teamId: { $in: teamIds }, status: TeamRosterStatus.ACTIVE } },
        { $group: { _id: '$teamId', n: { $sum: 1 } } },
      ]),
      this.enrollments.find({ tournamentId: tournament._id, teamId: { $in: teamIds } }).select('teamId').lean(),
      this.requests.find({ tournamentId: tournament._id, teamId: { $in: teamIds } }).sort({ createdAt: -1, _id: -1 }).lean<LeanRequest[]>(),
    ]);
    const size = new Map(sizes.map((s) => [s._id.toHexString(), s.n]));
    const enrolledIds = new Set(enrolled.map((e) => e.teamId.toHexString()));
    const summaries = await this.summaries(requests);
    const role = new Map(roles.map((r) => [r.teamId.toHexString(), r.role]));
    return {
      teams: teams.map((t) => {
        const id = t._id.toHexString();
        return {
          team: { ...teamRef(t), city: t.city ?? null },
          myRole: role.get(id)!,
          rosterSize: size.get(id) ?? 0,
          enrolled: enrolledIds.has(id),
          requests: summaries.filter((s) => s.team?.id === id),
        };
      }),
    };
  }

  /**
   * Envía la solicitud: OWNER/MANAGER del equipo (el link no basta), jugadores de su plantilla
   * GLOBAL ACTIVE, límites del torneo. Una sola PENDING por equipo y torneo (índice único parcial).
   */
  async submit(token: string, dto: SubmitRegistrationDto, user: AuthUser) {
    const { tournament } = await this.activeLink(token);
    const reason = this.closedReason(tournament, await this.enrolledCount(tournament._id));
    if (reason) throw new ConflictException(CLOSED_MESSAGE[reason]);
    await this.access.requireManager(dto.teamId, user);
    const teamId = toObjectId(dto.teamId);
    const playerIds = dto.playerIds.map(toObjectId);
    if (await this.requests.exists({ tournamentId: tournament._id, teamId, status: PENDING })) {
      throw new ConflictException('Este equipo ya tiene una solicitud pendiente en este torneo.');
    }
    const problems = await this.problemsOf(tournament, teamId, playerIds);
    if (problems.length) throw new ConflictException({ message: problems.map((p) => p.message).join(' '), problems });
    try {
      const [created] = await this.requests.create([{ tournamentId: tournament._id, teamId, submittedBy: toObjectId(user.id), status: PENDING, playerIds }]);
      // Enviada: la inscripción deja de estar "incompleta".
      await this.drafts.deleteOne({ userId: toObjectId(user.id), tournamentId: tournament._id });
      return (await this.summaries([created.toObject() as LeanRequest]))[0];
    } catch (e) {
      if (isDuplicateKey(e)) throw new ConflictException('Este equipo ya tiene una solicitud pendiente en este torneo.');
      throw e;
    }
  }

  /** Cancelar una solicitud PENDING (OWNER/MANAGER del equipo). Nunca una ya revisada. */
  async cancel(token: string, requestId: string, user: AuthUser) {
    const { tournament } = await this.activeLink(token);
    if (tournament.status === TournamentStatus.FINISHED) throw new ConflictException(CLOSED_MESSAGE.FINISHED);
    const request = await this.requests.findOne({ _id: toObjectId(requestId), tournamentId: tournament._id }).lean<LeanRequest>();
    if (!request) throw new NotFoundException('Solicitud no encontrada');
    await this.access.requireManager(request.teamId.toHexString(), user);
    const res = await this.requests.updateOne(
      { _id: request._id, status: PENDING },
      { $set: { status: RegistrationRequestStatus.CANCELLED, cancelledAt: new Date(), cancelledBy: toObjectId(user.id) } },
    );
    if (!res.modifiedCount) throw new ConflictException('Solo se puede cancelar una solicitud pendiente.');
  }

  /**
   * Crear un equipo NUEVO desde el flujo de inscripción: quien lo crea queda como su OWNER
   * (source CREATOR) en la misma transacción. No es un claim: nunca da acceso a equipos existentes.
   * La creación normal de equipos (POST /teams) no cambia.
   */
  async createOwnTeam(token: string, dto: CreateTeamDto, user: AuthUser) {
    const { tournament } = await this.activeLink(token);
    const reason = this.closedReason(tournament, await this.enrolledCount(tournament._id));
    if (reason) throw new ConflictException(CLOSED_MESSAGE[reason]);
    const team = await this.createOwnedTeam(dto, user);
    return { team, myRole: TeamAdminRole.OWNER, rosterSize: 0, enrolled: false, requests: [] };
  }

  /**
   * Equipo NUEVO cuyo OWNER es quien lo crea (source CREATOR), en una transacción. Lo usan el enlace
   * de inscripción y "Crear mi equipo" del panel (POST /me/teams). No es un claim: nunca da acceso
   * a equipos existentes. POST /teams (custodia, sin OWNER) no cambia.
   */
  async createOwnedTeam(dto: CreateTeamDto, user: AuthUser) {
    const me = toObjectId(user.id);
    const team = await this.connection.transaction(async (session) => {
      const [created] = await this.teams.create([{ ...dto, shortName: dto.shortName ?? deriveShortName(dto.name), createdBy: me }], { session });
      await this.admins.create(
        [{ teamId: created._id, userId: me, role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE, source: TeamAdminSource.CREATOR, grantedBy: me }],
        { session },
      );
      return created.toObject();
    });
    return { ...teamRef(team), city: team.city ?? null };
  }

  // ─── Inscripciones incompletas (borradores) ───────────────────────────────

  /** GET /tournament-registration/:token/draft — `{ draft }`: mi progreso en este torneo, o null. */
  async getDraft(token: string, user: AuthUser) {
    return { draft: await this.draftOf(token, user) };
  }

  private async draftOf(token: string, user: AuthUser) {
    const { tournament } = await this.activeLink(token);
    const d = await this.drafts.findOne({ userId: toObjectId(user.id), tournamentId: tournament._id }).lean();
    if (!d) return null;
    // Si dejó de administrar el equipo, el borrador vuelve a "elegir equipo" (no se filtra nada).
    const stillManages = d.teamId ? await this.access.canManageTeam(d.teamId, user.id) : false;
    return stillManages
      ? { teamId: d.teamId!.toHexString(), playerIds: d.playerIds.map((p) => p.toHexString()), step: d.step, updatedAt: d.updatedAt }
      : { teamId: null, playerIds: [], step: 'team' as const, updatedAt: d.updatedAt };
  }

  /**
   * PUT /tournament-registration/:token/draft — guarda el progreso (upsert, uno por usuario y torneo).
   * Solo con un equipo que administras; los jugadores se revalidan al ENVIAR (como siempre).
   */
  async saveDraft(token: string, dto: SaveRegistrationDraftDto, user: AuthUser) {
    const { link, tournament } = await this.activeLink(token);
    if (dto.teamId) {
      await this.access.requireManager(dto.teamId, user);
      // Ya enviada o ya inscrito: no hay nada "a medias". También cubre un guardado que llega
      // tarde, después del envío (no resucita el borrador que el envío borró).
      const teamId = toObjectId(dto.teamId);
      const done = await Promise.all([
        this.requests.exists({ tournamentId: tournament._id, teamId, status: PENDING }),
        this.enrollments.exists({ tournamentId: tournament._id, teamId }),
      ]);
      if (done.some(Boolean)) {
        await this.deleteDraft(tournament._id, user);
        return { draft: null };
      }
    }
    const set = {
      linkId: link._id,
      teamId: dto.teamId ? toObjectId(dto.teamId) : null,
      playerIds: dto.teamId ? dto.playerIds.map(toObjectId) : [],
      step: dto.teamId ? dto.step : ('team' as const),
    };
    // Upsert por (usuario, torneo) = índice único: ante guardados simultáneos MongoDB reintenta
    // él mismo el que choca, así que queda un solo borrador.
    await this.drafts.updateOne({ userId: toObjectId(user.id), tournamentId: tournament._id }, { $set: set }, { upsert: true });
    return this.getDraft(token, user);
  }

  /**
   * Cancelar la inscripción incompleta: solo borra el borrador. El equipo, su plantilla y los
   * jugadores creados por el camino se conservan (son datos reales del club). Idempotente.
   */
  async deleteDraft(tournamentId: Types.ObjectId | string, user: AuthUser) {
    await this.drafts.deleteOne({ userId: toObjectId(user.id), tournamentId: toObjectId(tournamentId) });
  }

  /** DELETE /tournament-registration/:token/draft */
  async deleteDraftByToken(token: string, user: AuthUser) {
    const { tournament } = await this.activeLink(token);
    await this.deleteDraft(tournament._id, user);
  }

  /**
   * Para el panel (GET /me/home): mis inscripciones incompletas y las solicitudes pendientes de mis
   * equipos, con lo necesario para mostrarlas y volver al enlace (consultas fijas). El token del
   * enlace solo se devuelve a quien ya lo usó (borrador propio) o administra el equipo, y solo si
   * el enlace sigue activo.
   */
  async homeSummary(user: AuthUser) {
    const me = toObjectId(user.id);
    const myTeamIds = (await this.admins.find({ userId: me, status: TeamAdminStatus.ACTIVE }).select('teamId').lean()).map((a) => a.teamId);
    const [drafts, pending] = await Promise.all([
      this.drafts.find({ userId: me }).sort({ updatedAt: -1 }).limit(20).lean(),
      myTeamIds.length ? this.requests.find({ teamId: { $in: myTeamIds }, status: PENDING }).sort({ createdAt: -1 }).limit(20).lean() : Promise.resolve([]),
    ]);
    const tournamentIds = [...new Set([...drafts, ...pending].map((x) => x.tournamentId.toHexString()))];
    const teamIds = [...new Set([...drafts.map((d) => d.teamId?.toHexString()), ...pending.map((r) => r.teamId.toHexString())].filter((x): x is string => !!x))];
    const [tournaments, teams, links] = await Promise.all([
      this.tournaments.find({ _id: { $in: tournamentIds.map(toObjectId) } }).select('name status startDate').lean(),
      this.teams.find({ _id: { $in: teamIds.map(toObjectId) } }).select('name shortName logoUrl colors').lean(),
      this.links.find({ tournamentId: { $in: tournamentIds.map(toObjectId) }, status: RegistrationLinkStatus.ACTIVE }).select('+tokenCiphertext tournamentId').lean(),
    ]);
    const tById = new Map(tournaments.map((t) => [t._id.toHexString(), { id: t._id.toHexString(), name: t.name, status: t.status }]));
    const teamById = new Map(teams.map((t) => [t._id.toHexString(), teamRef(t)]));
    const tokenOf = new Map(links.map((l) => [l.tournamentId.toHexString(), decryptRegistrationToken(l.tokenCiphertext, this.secret)]));
    return {
      drafts: drafts
        .filter((d) => tById.has(d.tournamentId.toHexString()))
        .map((d) => ({
          tournament: tById.get(d.tournamentId.toHexString())!,
          team: d.teamId ? (teamById.get(d.teamId.toHexString()) ?? null) : null,
          step: d.step,
          playerCount: d.playerIds.length,
          updatedAt: d.updatedAt,
          /** null: el enlace ya no está activo (no se puede continuar; sí cancelar). */
          token: tokenOf.get(d.tournamentId.toHexString()) ?? null,
        })),
      pendingRequests: pending
        .filter((r) => tById.has(r.tournamentId.toHexString()))
        .map((r) => ({
          id: r._id.toHexString(),
          tournament: tById.get(r.tournamentId.toHexString())!,
          team: teamById.get(r.teamId.toHexString()) ?? null,
          playerCount: r.playerIds.length,
          submittedAt: r.createdAt,
          token: tokenOf.get(r.tournamentId.toHexString()) ?? null,
        })),
    };
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async activeLink(token: string) {
    // Mismo mensaje para malformado, inexistente o revocado: no se revela nada.
    if (!TOKEN_PATTERN.test(token)) throw new NotFoundException(INVALID_LINK);
    const link = await this.links.findOne({ tokenHash: hashRegistrationToken(token), status: RegistrationLinkStatus.ACTIVE }).lean();
    if (!link) throw new NotFoundException(INVALID_LINK);
    const tournament = await this.tournaments
      .findById(link.tournamentId)
      .select('name format category startDate endDate venue status registration')
      .lean<LeanTournament & Pick<Tournament, 'name' | 'format' | 'category' | 'startDate' | 'endDate' | 'venue'>>();
    if (!tournament) throw new NotFoundException(INVALID_LINK);
    return { link, tournament };
  }

  /**
   * Validación de una selección con datos ACTUALES (en lote: consultas fijas, sin una por jugador).
   * Con `session`, dentro del cerrojo del torneo (aprobación).
   */
  async problemsOf(t: LeanTournament, teamId: Types.ObjectId, playerIds: Types.ObjectId[], session?: ClientSession): Promise<SelectionProblem[]> {
    const s = session ?? null;
    const r = this.settingsOf(t);
    // En secuencia: una transacción de MongoDB no admite operaciones paralelas en la misma sesión.
    const team = await this.teams.exists({ _id: teamId }).session(s);
    const enrolled = await this.enrollments.exists({ tournamentId: t._id, teamId }).session(s);
    const enrolledCount = await this.enrolledCount(t._id, session);
    const players = await this.players.find({ _id: { $in: playerIds } }).select('firstName lastName').session(s).lean();
    const roster = await this.rosters.find({ teamId, playerId: { $in: playerIds }, status: TeamRosterStatus.ACTIVE }).select('playerId').session(s).lean();
    const active = await this.memberships.find({ tournamentId: t._id, playerId: { $in: playerIds }, active: true }).select('playerId teamId').session(s).lean();
    if (!team) return [{ code: 'TEAM_NOT_FOUND', message: 'El equipo ya no existe.' }];
    const problems: SelectionProblem[] = [];
    if (enrolled) problems.push({ code: 'ALREADY_ENROLLED', message: 'Este equipo ya está inscrito en el torneo.' });
    else if (r.maxTeams !== null && enrolledCount >= r.maxTeams) problems.push({ code: 'FULL', message: CLOSED_MESSAGE.FULL });

    const name = new Map(players.map((p) => [p._id.toHexString(), `${p.firstName} ${p.lastName}`]));
    const ids = playerIds.map((id) => id.toHexString());
    const missing = ids.filter((id) => !name.has(id));
    if (missing.length) problems.push({ code: 'PLAYER_NOT_FOUND', message: 'Algún jugador de la selección ya no existe.', playerIds: missing });
    const inRoster = new Set(roster.map((x) => x.playerId.toHexString()));
    const outside = ids.filter((id) => name.has(id) && !inRoster.has(id));
    if (outside.length) {
      problems.push({
        code: 'NOT_IN_ROSTER',
        message: `La plantilla cambió desde que se envió la solicitud: ${outside.map((id) => name.get(id)).join(', ')} ya no ${outside.length === 1 ? 'pertenece' : 'pertenecen'} al equipo.`,
        playerIds: outside,
      });
    }
    const elsewhere = active.filter((m) => !m.teamId.equals(teamId));
    if (elsewhere.length) {
      const otherTeams = await this.teams.find({ _id: { $in: elsewhere.map((m) => m.teamId) } }).select('name').session(s).lean();
      const teamName = new Map(otherTeams.map((x) => [x._id.toHexString(), x.name]));
      problems.push({
        code: 'OTHER_TEAM',
        message: elsewhere.map((m) => `${name.get(m.playerId.toHexString())} ya juega con ${teamName.get(m.teamId.toHexString()) ?? 'otro equipo'} en este torneo.`).join(' '),
        playerIds: elsewhere.map((m) => m.playerId.toHexString()),
      });
    }
    if (r.minPlayers !== null && ids.length < r.minPlayers) problems.push({ code: 'TOO_FEW', message: `Se necesitan al menos ${r.minPlayers} jugadores (hay ${ids.length}).` });
    if (r.maxPlayers !== null && ids.length > r.maxPlayers) problems.push({ code: 'TOO_MANY', message: `Se permiten como máximo ${r.maxPlayers} jugadores (hay ${ids.length}).` });
    return problems;
  }

  private notPendingMessage(status: RegistrationRequestStatus) {
    return status === RegistrationRequestStatus.CANCELLED
      ? 'El equipo canceló esta solicitud.'
      : `Esta solicitud ya fue ${status === RegistrationRequestStatus.APPROVED ? 'aprobada' : 'rechazada'}.`;
  }

  private async countsOf(tournamentId: Types.ObjectId) {
    const rows = await this.requests.aggregate<{ _id: RegistrationRequestStatus; n: number }>([
      { $match: { tournamentId } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(Object.values(RegistrationRequestStatus).map((s) => [s, 0])) as Record<RegistrationRequestStatus, number>;
    for (const r of rows) counts[r._id] = r.n;
    return counts;
  }

  /** Resúmenes en lote (equipos y remitentes en 2 consultas). Del remitente solo el nombre. */
  private async summaries(rows: LeanRequest[]) {
    const [teams, users] = await Promise.all([
      this.teams.find({ _id: { $in: [...new Set(rows.map((r) => r.teamId.toHexString()))].map(toObjectId) } }).select('name shortName logoUrl colors').lean(),
      this.users.find({ _id: { $in: [...new Set(rows.map((r) => r.submittedBy.toHexString()))].map(toObjectId) } }).select('firstName lastName').lean(),
    ]);
    const teamById = new Map(teams.map((t) => [t._id.toHexString(), teamRef(t)]));
    const userById = new Map(users.map((u) => [u._id.toHexString(), { firstName: u.firstName, lastName: u.lastName }]));
    return rows.map((r) => ({
      id: r._id.toHexString(),
      team: teamById.get(r.teamId.toHexString()) ?? null,
      status: r.status,
      playerCount: r.playerIds.length,
      submittedBy: userById.get(r.submittedBy.toHexString()) ?? null,
      submittedAt: r.createdAt,
      reviewedAt: r.reviewedAt ?? null,
      rejectionReason: r.rejectionReason ?? null,
      cancelledAt: r.cancelledAt ?? null,
    }));
  }

  /** Detalle para el organizador: jugadores enviados (públicos) y, si sigue PENDING, problemas actuales. */
  private async detail(t: LeanTournament, requestId: string) {
    const request = await this.requests.findOne({ _id: toObjectId(requestId), tournamentId: t._id }).lean<LeanRequest>();
    if (!request) throw new NotFoundException('Solicitud no encontrada');
    const [summary] = await this.summaries([request]);
    const players = await this.players.find({ _id: { $in: request.playerIds } }).lean();
    const byId = new Map(players.map((p) => [p._id.toHexString(), publicPlayer(p)]));
    const current = await this.tournaments.findById(t._id).select('status registration').lean<LeanTournament>();
    const problems = request.status === PENDING ? await this.problemsOf(current!, request.teamId, request.playerIds) : [];
    const flagged = new Map(problems.flatMap((p) => (p.playerIds ?? []).map((id) => [id, p.code] as const)));
    return {
      ...summary,
      players: request.playerIds.map((id) => {
        const player = byId.get(id.toHexString());
        return {
          player: player ? { id: player.id, firstName: player.firstName, lastName: player.lastName, position: player.position, photoUrl: player.photoUrl, age: player.age } : null,
          problem: flagged.get(id.toHexString()) ?? null,
        };
      }),
      problems,
    };
  }
}
