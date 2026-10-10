import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { MatchIncident } from './schemas/match-incident.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { MatchIncidentStatus, MatchIncidentType, MatchLogAction, MatchStatus, SuspensionDecision } from '../../common/enums/index.js';
import { assertStarted, OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { sameId, serialize, toObjectId } from '../../common/utils/serialize.js';
import { CompetitionService } from '../competition/competition.service.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import { assertSheetOpen } from '../matches/match-rules.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { ReportIncidentDto, ResolveIncidentDto, VoidIncidentDto } from './dto/match-incident.dto.js';

const { OPEN, RESOLVED, VOID } = MatchIncidentStatus;
type LeanIncident = MatchIncident & { _id: Types.ObjectId };

/**
 * Incidencias operativas de los partidos (Módulo 2C-2). Todas las escrituras van con el cerrojo
 * del torneo y dejan su entrada en `match_logs` en la misma transacción.
 *
 * Una incidencia de SUSPENSIÓN deja el partido SUSPENDED: pendiente de decisión, sin resultado
 * automático. La decisión (reanudar, reprogramar, posponer, cancelar o dar por terminado) se toma
 * editando el partido o capturando su resultado, y cierra la incidencia (`resolveSuspension`).
 */
@Injectable()
export class MatchIncidentsService {
  constructor(
    @InjectModel(MatchIncident.name) private readonly incidents: Model<MatchIncident>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
    private readonly competition: CompetitionService,
    private readonly log: MatchLogService,
  ) {}

  async report(matchId: string, dto: ReportIncidentDto, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.INCIDENTS);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.INCIDENTS }, async (session, tournamentStatus) => {
      const match = await this.reload(matchId, before.tournamentId, session);
      assertSheetOpen(match);
      // Doble envío: la misma incidencia abierta no se registra dos veces.
      if (await this.incidents.exists({ matchId: match._id, type: dto.type, description: dto.description, status: OPEN }).session(session)) {
        throw new ConflictException('Esa incidencia ya está registrada');
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      let suspendedFrom: MatchStatus | null = null;
      if (dto.type === MatchIncidentType.SUSPENSION) {
        assertStarted(tournamentStatus);
        if (match.status !== MatchStatus.SCHEDULED && match.status !== MatchStatus.LIVE) {
          throw new ConflictException('Solo se puede suspender un partido programado o en juego');
        }
        if (match.stage) {
          const phases = (await this.tournaments.findById(match.tournamentId).select('phases').session(session).lean())?.phases ?? [];
          this.competition.assertStageWrite(phases, match.stage, { resultOrStatus: true });
        }
        await this.matches.updateOne({ _id: match._id }, { $set: { status: MatchStatus.SUSPENDED } }, { session });
        suspendedFrom = match.status;
        changes.status = { from: match.status, to: MatchStatus.SUSPENDED };
      }
      const [created] = await this.incidents.create(
        [
          {
            tournamentId: match.tournamentId,
            matchId: match._id,
            type: dto.type,
            description: dto.description,
            occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
            reportedBy: toObjectId(user.id),
            reportedRole: await this.access.roleOf(match.tournamentId, user.id, session),
            suspendedFrom,
          },
        ],
        { session },
      );
      changes.incident = { from: null, to: { incidentId: created._id.toHexString(), type: dto.type, description: dto.description } };
      await this.log.entry(session, { userId: user.id }, match, MatchLogAction.INCIDENT_REPORTED, changes);
    });
    return this.list(matchId, user);
  }

  /** Resolver una incidencia informativa (una suspensión se resuelve decidiendo sobre el partido). */
  async resolve(matchId: string, incidentId: string, dto: ResolveIncidentDto, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.INCIDENTS);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.INCIDENTS }, async (session) => {
      const match = await this.reload(matchId, before.tournamentId, session);
      assertSheetOpen(match);
      const incident = await this.one(match._id, incidentId, session);
      if (incident.type === MatchIncidentType.SUSPENSION) {
        throw new ConflictException('Una suspensión se resuelve decidiendo sobre el partido: reanudar, reprogramar, posponer, cancelar o capturar el resultado final');
      }
      if (incident.status !== OPEN) throw new ConflictException(incident.status === RESOLVED ? 'La incidencia ya está resuelta' : 'La incidencia está anulada');
      const role = await this.access.roleOf(match.tournamentId, user.id, session);
      await this.incidents.updateOne(
        { _id: incident._id, status: OPEN },
        { $set: { status: RESOLVED, resolution: { at: new Date(), by: toObjectId(user.id), role, note: dto.note, decision: null } } },
        { session },
      );
      await this.log.entry(session, { userId: user.id }, match, MatchLogAction.INCIDENT_RESOLVED, {
        incident: { from: { incidentId, type: incident.type, status: OPEN }, to: { incidentId, type: incident.type, status: RESOLVED } },
      }, dto.note);
    });
    return this.list(matchId, user);
  }

  /**
   * Anular una incidencia registrada por error (VOID, se conserva). Una suspensión solo mientras
   * siga pendiente de decisión: el partido vuelve al estado que tenía al suspenderse.
   */
  async void(matchId: string, incidentId: string, dto: VoidIncidentDto, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.INCIDENTS);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.INCIDENTS }, async (session) => {
      const match = await this.reload(matchId, before.tournamentId, session);
      assertSheetOpen(match);
      const incident = await this.one(match._id, incidentId, session);
      if (incident.status === VOID) throw new ConflictException('La incidencia ya está anulada');
      const changes: Record<string, { from: unknown; to: unknown }> = {
        incident: { from: { incidentId, type: incident.type, status: incident.status }, to: { incidentId, type: incident.type, status: VOID } },
      };
      if (incident.type === MatchIncidentType.SUSPENSION) {
        if (incident.status !== OPEN || match.status !== MatchStatus.SUSPENDED) {
          throw new ConflictException('Ya se decidió qué pasa con el partido: esta suspensión no se puede anular');
        }
        const back = incident.suspendedFrom ?? MatchStatus.SCHEDULED;
        await this.matches.updateOne({ _id: match._id, status: MatchStatus.SUSPENDED }, { $set: { status: back } }, { session });
        changes.status = { from: MatchStatus.SUSPENDED, to: back };
      }
      const role = await this.access.roleOf(match.tournamentId, user.id, session);
      await this.incidents.updateOne(
        { _id: incident._id, status: incident.status },
        { $set: { status: VOID, voided: { at: new Date(), by: toObjectId(user.id), role, note: dto.reason } } },
        { session },
      );
      await this.log.entry(session, { userId: user.id }, match, MatchLogAction.INCIDENT_VOIDED, changes, dto.reason);
    });
    return this.list(matchId, user);
  }

  /**
   * Cierra la suspensión abierta del partido con la decisión tomada. Lo llama quien cambia el
   * partido, dentro de su transacción (y con el cerrojo del torneo ya tomado).
   */
  async resolveSuspension(session: ClientSession, match: { _id: Types.ObjectId; tournamentId: Types.ObjectId }, decision: SuspensionDecision, note: string | null, userId: string) {
    const role = await this.access.roleOf(match.tournamentId, userId, session);
    await this.incidents.updateOne(
      { matchId: match._id, type: MatchIncidentType.SUSPENSION, status: OPEN },
      { $set: { status: RESOLVED, resolution: { at: new Date(), by: toObjectId(userId), role, note, decision } } },
      { session },
    );
  }

  /** Incidencias del partido en orden cronológico (también si el partido ya se eliminó). */
  async list(matchId: string, user: AuthUser) {
    const id = toObjectId(matchId);
    const tournamentId =
      (await this.matches.findById(id).select('tournamentId').lean())?.tournamentId ?? (await this.incidents.findOne({ matchId: id }).select('tournamentId').lean())?.tournamentId;
    if (!tournamentId) throw new NotFoundException('Partido no encontrado');
    await this.ownership.ownedTournament(tournamentId, user, Permission.LOGS_VIEW);
    const list = await this.incidents.find({ matchId: id }).sort({ createdAt: 1, _id: 1 }).lean();
    const userIds = [...new Set(list.flatMap((i) => [i.reportedBy, i.resolution?.by, i.voided?.by]).filter(Boolean).map(String))];
    const users = await this.users.find({ _id: { $in: userIds.map(toObjectId) } }).select('firstName lastName').lean();
    const names = Object.fromEntries(users.map((u) => [u._id.toHexString(), `${u.firstName} ${u.lastName}`.trim()]));
    return { incidents: serialize(list), users: names };
  }

  private async one(matchId: Types.ObjectId, incidentId: string, session: ClientSession) {
    const incident = await this.incidents.findOne({ _id: toObjectId(incidentId), matchId }).session(session).lean<LeanIncident>();
    if (!incident) throw new NotFoundException('Incidencia no encontrada');
    return incident;
  }

  private async reload(id: string, tournamentId: Types.ObjectId, session: ClientSession) {
    const match = await this.matches.findById(id).session(session).lean();
    if (!match) throw new NotFoundException(`Partido ${id} no encontrado`);
    if (!sameId(match.tournamentId, tournamentId)) throw new ConflictException('El partido cambió de torneo; recarga e inténtalo de nuevo');
    return match;
  }
}
