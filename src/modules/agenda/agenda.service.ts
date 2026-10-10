import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Match } from '../matches/schemas/match.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Round } from '../rounds/schemas/round.schema.js';
import { Venue } from '../venues/schemas/venue.schema.js';
import { Referee, refereeName } from '../referees/schemas/referee.schema.js';
import { RefereeAssignmentStatus, TournamentStatus } from '../../common/enums/index.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { can, Permission, permissionsOf, type AccessRole } from '../../common/authorization/permissions.js';
import { paginated, skipFor } from '../../common/dto/pagination.dto.js';
import { sameId, serialize, toObjectId } from '../../common/utils/serialize.js';
import { publicMatch } from '../matches/match-rules.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { AgendaQueryDto } from './dto/agenda.dto.js';

type LeanTournament = Pick<Tournament, 'name' | 'status' | 'organizerId'> & { _id: Types.ObjectId };

/**
 * Agenda global (Módulo 2C-3): partidos de todos los torneos a los que el usuario tiene acceso
 * (propios y colaboraciones ACTIVAS, el mismo cálculo que "Mis torneos"). Solo lectura: las
 * modificaciones siguen por los endpoints de partidos, árbitros e incidencias, con sus permisos y
 * su transacción. Todo se filtra aquí, nunca solo en el cliente.
 *
 * Filtros por sede, cancha o árbitro: son catálogos del PROPIETARIO, que un colaborador solo ve con
 * ASSIGNMENTS (R3). Un recurso fuera de ese alcance responde 404 (sin revelar si existe) y limita la
 * agenda a los torneos de su propietario donde el usuario tiene ASSIGNMENTS.
 *
 * Consultas fijas por página (sin N+1): acceso, torneos, partidos + total, equipos y jornadas.
 */
@Injectable()
export class AgendaService {
  constructor(
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    @InjectModel(Venue.name) private readonly venues: Model<Venue>,
    @InjectModel(Referee.name) private readonly referees: Model<Referee>,
    private readonly access: TournamentAccessService,
  ) {}

  async list(user: AuthUser, q: AgendaQueryDto) {
    if (q.from && q.to && q.from > q.to) throw new BadRequestException('La fecha inicial es posterior a la final');
    const { roles, tournaments } = await this.scope(user, !!q.includeFinished);
    let visible = tournaments;
    if (q.tournamentId) {
      if (!roles.has(q.tournamentId)) throw new NotFoundException('Torneo no encontrado');
      visible = visible.filter((t) => sameId(t._id, q.tournamentId!));
    }
    const filter: Record<string, unknown> = {};
    if (q.venueId || q.fieldId || q.refereeId) {
      const owner = await this.resourceOwner(q);
      // Solo torneos de ese propietario donde el usuario gestiona asignaciones.
      visible = visible.filter((t) => sameId(t.organizerId, owner) && can(roles.get(t._id.toHexString())!, Permission.ASSIGNMENTS));
      if (!visible.length && !tournaments.some((t) => sameId(t.organizerId, owner) && can(roles.get(t._id.toHexString())!, Permission.ASSIGNMENTS))) {
        throw new NotFoundException('Recurso no encontrado');
      }
      if (q.venueId) filter.venueId = toObjectId(q.venueId);
      if (q.fieldId) filter.fieldId = toObjectId(q.fieldId);
      if (q.refereeId) filter.referees = { $elemMatch: { refereeId: toObjectId(q.refereeId), status: RefereeAssignmentStatus.ASSIGNED } };
    }
    filter.tournamentId = { $in: visible.map((t) => t._id) };
    if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    if (q.status?.length) filter.status = { $in: q.status };

    const [docs, total] = await Promise.all([
      // Orden cronológico estable: fecha, hora y _id (índice tournamentId+date+time+_id).
      this.matches.find(filter).sort({ date: 1, time: 1, _id: 1 }).skip(skipFor(q)).limit(q.limit).lean(),
      this.matches.countDocuments(filter),
    ]);
    const [teams, rounds] = await Promise.all([
      this.teams.find({ _id: { $in: docs.flatMap((d) => [d.homeTeamId, d.awayTeamId]) } }).select('name shortName logoUrl').lean(),
      this.rounds.find({ tournamentId: { $in: [...new Set(docs.map((d) => d.tournamentId.toHexString()))].map(toObjectId) }, number: { $in: [...new Set(docs.map((d) => d.round))] } }).select('tournamentId number name').lean(),
    ]);
    const team = new Map(teams.map((t) => [t._id.toHexString(), { id: t._id.toHexString(), name: t.name }]));
    const roundName = new Map(rounds.map((r) => [`${r.tournamentId.toHexString()}|${r.number}`, r.name]));
    const byId = new Map(tournaments.map((t) => [t._id.toHexString(), t]));
    const data = docs.map((d) => {
      const t = byId.get(d.tournamentId.toHexString())!;
      return {
        ...serialize(publicMatch(d)),
        tournament: { id: t._id.toHexString(), name: t.name, status: t.status },
        homeTeam: team.get(d.homeTeamId.toHexString()) ?? null,
        awayTeam: team.get(d.awayTeamId.toHexString()) ?? null,
        roundName: roundName.get(`${d.tournamentId.toHexString()}|${d.round}`) ?? null,
      };
    });
    return { ...paginated(data, total, q), tournaments: this.tournamentViews(visible, roles) };
  }

  /**
   * Opciones de los filtros: torneos accesibles (con rol y permisos) y, de los propietarios donde
   * el usuario gestiona asignaciones, sus sedes, canchas y árbitros (solo nombres, sin contacto).
   */
  async options(user: AuthUser, includeFinished: boolean) {
    const { roles, tournaments } = await this.scope(user, includeFinished);
    const owners = [
      ...new Map(
        tournaments.filter((t) => can(roles.get(t._id.toHexString())!, Permission.ASSIGNMENTS)).map((t) => [t.organizerId.toHexString(), t.organizerId]),
      ).values(),
    ];
    const [venues, referees] = await Promise.all([
      this.venues.find({ organizerId: { $in: owners }, archived: false }).select('name fields').sort({ name: 1 }).lean(),
      this.referees.find({ organizerId: { $in: owners }, archived: false }).select('firstName lastName').sort({ lastName: 1, firstName: 1 }).lean(),
    ]);
    return {
      tournaments: this.tournamentViews(tournaments, roles),
      venues: venues.map((v) => ({ id: v._id.toHexString(), name: v.name, fields: v.fields.filter((f) => !f.archived).map((f) => ({ id: f._id.toHexString(), name: f.name })) })),
      referees: referees.map((r) => ({ id: r._id.toHexString(), name: refereeName(r) })),
    };
  }

  /** Torneos accesibles (propios y colaboraciones activas); finalizados solo si se piden. */
  private async scope(user: AuthUser, includeFinished: boolean) {
    const roles = await this.access.accessible(user.id);
    const tournaments = await this.tournaments
      .find({ _id: { $in: [...roles.keys()].map(toObjectId) }, ...(includeFinished ? {} : { status: { $ne: TournamentStatus.FINISHED } }) })
      .select('name status organizerId')
      .sort({ name: 1 })
      .lean<LeanTournament[]>();
    return { roles, tournaments };
  }

  /** Propietario del recurso filtrado (404 si no existe o si sede y cancha no coinciden). */
  private async resourceOwner(q: AgendaQueryDto): Promise<Types.ObjectId> {
    const owners: Types.ObjectId[] = [];
    if (q.venueId || q.fieldId) {
      const venue = await this.venues
        .findOne({ ...(q.venueId ? { _id: toObjectId(q.venueId) } : {}), ...(q.fieldId ? { 'fields._id': toObjectId(q.fieldId) } : {}) })
        .select('organizerId')
        .lean();
      if (!venue) throw new NotFoundException(q.fieldId ? 'Cancha no encontrada' : 'Sede no encontrada');
      owners.push(venue.organizerId);
    }
    if (q.refereeId) {
      const ref = await this.referees.findById(q.refereeId).select('organizerId').lean();
      if (!ref) throw new NotFoundException('Árbitro no encontrado');
      owners.push(ref.organizerId);
    }
    // Sede y árbitro de propietarios distintos nunca coinciden en un partido.
    if (owners.some((o) => !o.equals(owners[0]))) throw new NotFoundException('Recurso no encontrado');
    return owners[0];
  }

  private tournamentViews(list: LeanTournament[], roles: Map<string, AccessRole>) {
    return list.map((t) => {
      const role = roles.get(t._id.toHexString()) ?? null;
      return { id: t._id.toHexString(), name: t.name, status: t.status, myRole: role, permissions: permissionsOf(role) };
    });
  }
}
