import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { Referee, refereeName } from './schemas/referee.schema.js';
import { Match, type RefereeAssignment } from '../matches/schemas/match.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Venue } from '../venues/schemas/venue.schema.js';
import { MatchLogAction, MatchStatus, RefereeAssignmentStatus, RefereeRole } from '../../common/enums/index.js';
import { OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import { sameId, serialize, toObjectId } from '../../common/utils/serialize.js';
import type { AuthUser } from '../auth/auth.types.js';
import { addDays, availabilityWarnings, clockOf, conflictsAmong, DEFAULT_BUFFER_MINUTES, durationOf, interval, overlaps, RESERVING, reserves, type Slot } from '../venues/occupancy.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import type { AssignRefereeDto, CreateRefereeDto, RefereeAbsenceDto, UpdateRefereeDto } from './dto/referee.dto.js';

/** Partidos por jugar: impiden desactivar o eliminar al árbitro asignado. */
const PENDING = [MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.POSTPONED];
const ACTIVE = RefereeAssignmentStatus.ASSIGNED;

type LeanReferee = Referee & { _id: Types.ObjectId };
type MatchSlotDoc = Pick<Match, 'tournamentId' | 'venueId' | 'date' | 'time' | 'homeTeamId' | 'awayTeamId'> & { _id: Types.ObjectId };
/** Duración o margen distintos a los guardados (al revalidar un cambio antes de escribirlo). */
type Override = { tournamentId?: Types.ObjectId; minutes?: number; venueId?: Types.ObjectId; buffer?: number };

export interface RefereeConflict {
  matchId: string;
  tournamentName: string;
  date: string;
  time: string;
  endTime: string;
  homeTeam: string;
  awayTeam: string;
}

/**
 * Árbitros del organizador y sus asignaciones (Módulo 2B). Un árbitro no puede estar en dos
 * partidos cuya ocupación (duración del torneo + margen de la sede, como las canchas en 2A) se
 * solape, en ningún torneo del organizador. Cada asignación toma el cerrojo del torneo (escritura
 * del partido) y el del árbitro (`writeSeq`), así dos torneos no pueden asignarlo a la vez.
 */
@Injectable()
export class RefereesService {
  constructor(
    @InjectModel(Referee.name) private readonly referees: Model<Referee>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Venue.name) private readonly venues: Model<Venue>,
    @InjectConnection() private readonly connection: Connection,
    private readonly ownership: OwnershipService,
    private readonly log: MatchLogService,
    private readonly access: TournamentAccessService,
  ) {}

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  async list(user: AuthUser) {
    const list = await this.referees.find({ organizerId: toObjectId(user.id), archived: false }).sort({ lastName: 1, firstName: 1 }).lean();
    const usage = await this.matches.aggregate<{ _id: Types.ObjectId; total: number; pending: number }>([
      { $match: { 'referees.refereeId': { $in: list.map((r) => r._id) } } },
      { $unwind: '$referees' },
      { $match: { 'referees.refereeId': { $in: list.map((r) => r._id) } } },
      { $group: { _id: '$referees.refereeId', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $and: [{ $in: ['$status', PENDING] }, { $eq: ['$referees.status', ACTIVE] }] }, 1, 0] } } } },
    ]);
    const byId = new Map(usage.map((u) => [u._id.toHexString(), u]));
    return list.map((r) => view(r, byId.get(r._id.toHexString())));
  }

  /**
   * Árbitros del PROPIETARIO del torneo con su contacto, para ADMIN/COORDINATOR de ese torneo
   * (Permission.REFEREE_CONTACT). El propietario sale del torneo; el catálogo no se modifica aquí.
   */
  async forTournament(tournamentId: string, user: AuthUser) {
    const { tournament } = await this.access.require(tournamentId, user.id, Permission.REFEREE_CONTACT);
    const list = await this.referees.find({ organizerId: tournament.organizerId, archived: false }).sort({ lastName: 1, firstName: 1 }).lean();
    return list.map((r) => ({ id: r._id.toHexString(), name: refereeName(r), phone: r.phone, email: r.email, active: r.active }));
  }

  async create(dto: CreateRefereeDto, user: AuthUser) {
    assertWindows(dto.availability);
    const [created] = await this.referees.create([{ ...dto, organizerId: toObjectId(user.id) }]);
    return view(created.toObject());
  }

  async update(id: string, dto: UpdateRefereeDto, user: AuthUser) {
    assertWindows(dto.availability);
    await this.write(id, user, async (ref, session) => {
      if (dto.active === false && ref.active) await this.assertNoPending(ref._id, session, 'desactivarlo');
      await this.referees.updateOne({ _id: ref._id }, { $set: dto }, { session, runValidators: true });
      // El nombre público del central se mantiene al renombrar.
      if ((dto.firstName && dto.firstName !== ref.firstName) || (dto.lastName && dto.lastName !== ref.lastName)) {
        await this.refreshCentral({ 'referees.refereeId': ref._id }, session);
      }
    });
    const ref = await this.referees.findById(id).lean();
    return view(ref!);
  }

  /** Sin partidos se borra; con partidos se archiva (su historial sigue resolviendo). */
  async remove(id: string, user: AuthUser) {
    let archived = false;
    await this.write(id, user, async (ref, session) => {
      await this.assertNoPending(ref._id, session, 'eliminarlo');
      if (await this.matches.exists({ 'referees.refereeId': ref._id }).session(session)) {
        archived = true;
        await this.referees.updateOne({ _id: ref._id }, { $set: { archived: true, active: false } }, { session });
      } else await this.referees.deleteOne({ _id: ref._id }, { session });
    });
    return { archived };
  }

  /** Historial: todos sus partidos asignados (incluidas ausencias y sustituciones). */
  async history(id: string, user: AuthUser) {
    const ref = await this.referees.findById(id).lean();
    if (!ref) throw new NotFoundException('Árbitro no encontrado');
    if (!sameId(ref.organizerId, user.id)) throw new ForbiddenException('Este árbitro es de otro organizador');
    const docs = await this.matches
      .find({ 'referees.refereeId': ref._id })
      .select('tournamentId date time status homeTeamId awayTeamId homeScore awayScore venue referees')
      .sort({ date: -1, time: -1 })
      .lean();
    const [tournaments, teams, others] = await Promise.all([
      this.tournaments.find({ _id: { $in: docs.map((d) => d.tournamentId) } }).select('name').lean(),
      this.teams.find({ _id: { $in: docs.flatMap((d) => [d.homeTeamId, d.awayTeamId]) } }).select('name').lean(),
      this.referees.find({ _id: { $in: docs.flatMap((d) => d.referees.map((r) => r.refereeId)) } }).select('firstName lastName').lean(),
    ]);
    const tName = new Map(tournaments.map((t) => [t._id.toHexString(), t.name]));
    const teamName = new Map(teams.map((t) => [t._id.toHexString(), t.name]));
    const refName = new Map(others.map((r) => [r._id.toHexString(), refereeName(r)]));
    return docs.flatMap((d) =>
      d.referees
        .filter((a) => sameId(a.refereeId, ref._id))
        .map((a) => {
          const replacedBy = d.referees.find((x) => x.substituteFor && sameId(x.substituteFor, a._id));
          const replaced = a.substituteFor ? d.referees.find((x) => sameId(x._id, a.substituteFor!)) : undefined;
          return {
            assignmentId: a._id.toHexString(),
            role: a.role,
            status: a.status,
            absenceNote: a.absenceNote,
            replacedBy: replacedBy ? refName.get(replacedBy.refereeId.toHexString()) ?? null : null,
            substituteFor: replaced ? refName.get(replaced.refereeId.toHexString()) ?? null : null,
            match: {
              id: d._id.toHexString(),
              tournamentId: d.tournamentId.toHexString(),
              tournamentName: tName.get(d.tournamentId.toHexString()) ?? null,
              date: d.date,
              time: d.time,
              status: d.status,
              venue: d.venue,
              homeTeam: teamName.get(d.homeTeamId.toHexString()) ?? null,
              awayTeam: teamName.get(d.awayTeamId.toHexString()) ?? null,
              homeScore: d.homeScore,
              awayScore: d.awayScore,
            },
          };
        }),
    );
  }

  private async write(id: string, user: AuthUser, fn: (ref: LeanReferee, session: ClientSession) => Promise<void>) {
    await this.connection.transaction(async (session) => {
      const ref = await this.referees.findOneAndUpdate({ _id: toObjectId(id), archived: false }, { $inc: { writeSeq: 1 } }, { session, returnDocument: 'after' }).lean();
      if (!ref) throw new NotFoundException('Árbitro no encontrado');
      if (!sameId(ref.organizerId, user.id)) throw new ForbiddenException('Este árbitro es de otro organizador');
      await fn(ref, session);
    });
  }

  private async assertNoPending(refereeId: Types.ObjectId, session: ClientSession, action: string) {
    const pending = await this.matches
      .countDocuments({ status: { $in: PENDING }, referees: { $elemMatch: { refereeId, status: ACTIVE } } })
      .session(session);
    if (pending) {
      throw new ConflictException(`No se puede ${action}: tiene ${pending} ${pending === 1 ? 'partido asignado pendiente' : 'partidos asignados pendientes'}. Reasígnalos primero.`);
    }
  }

  // ─── Asignaciones ───────────────────────────────────────────────────────────

  /** Árbitros del organizador con sus conflictos y avisos para un partido (para elegir). */
  async options(matchId: string, user: AuthUser) {
    const match = await this.ownership.match(matchId, user, Permission.ASSIGNMENTS);
    const tournament = await this.tournaments.findById(match.tournamentId).select('organizerId').lean();
    const slot = await this.slotOf(match, null, null);
    const list = await this.referees.find({ organizerId: tournament!.organizerId, archived: false, active: true }).sort({ lastName: 1, firstName: 1 }).lean();
    return Promise.all(
      list.map(async (r) => ({
        id: r._id.toHexString(),
        name: refereeName(r),
        conflicts: reserves(match.status) ? await this.conflicts(r._id, slot, match._id, null, null) : [],
        warnings: availabilityWarnings(r.availability, slot, { subject: refereeName(r), of: 'del árbitro' }),
      })),
    );
  }

  async assign(matchId: string, dto: AssignRefereeDto, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.ASSIGNMENTS);
    let warnings: string[] = [];
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.ASSIGNMENTS }, async (session) => {
      const match = await this.reload(matchId, session);
      if (match.referees.some((a) => a.status === ACTIVE && a.role === dto.role)) {
        throw new ConflictException('Ese rol ya tiene árbitro: quítalo o márcalo como ausente primero');
      }
      warnings = await this.add(session, match, dto.refereeId, dto.role, null);
      await this.log.referee(session, { userId: user.id }, match, MatchLogAction.REFEREE_ASSIGNED, {
        referee: { from: null, to: { refereeId: dto.refereeId, role: dto.role } },
      });
    });
    return this.matchView(matchId, warnings);
  }

  /** Quitar una asignación sin historia (ni ausente, ni sustituida, ni sustituta). */
  async unassign(matchId: string, assignmentId: string, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.ASSIGNMENTS);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.ASSIGNMENTS }, async (session) => {
      const match = await this.reload(matchId, session);
      const a = match.referees.find((x) => sameId(x._id, assignmentId));
      if (!a) throw new NotFoundException('Asignación no encontrada');
      // Ausente, sustituido o sustituto: es la historia de quién arbitró y no se borra.
      if (a.status !== ACTIVE || a.substituteFor || match.referees.some((x) => x.substituteFor && sameId(x.substituteFor, a._id))) {
        throw new ConflictException('Una ausencia o sustitución es historial del partido y no se borra');
      }
      await this.matches.updateOne({ _id: match._id }, { $pull: { referees: { _id: a._id } } }, { session });
      await this.log.referee(session, { userId: user.id }, match, MatchLogAction.REFEREE_REMOVED, {
        referee: { from: { refereeId: a.refereeId.toHexString(), role: a.role }, to: null },
      });
      await this.refreshCentral({ _id: match._id }, session);
    });
    return this.matchView(matchId, []);
  }

  /**
   * Ausencia: la asignación queda ABSENT (no se borra) y, si se indica, el sustituto entra con el
   * mismo rol y `substituteFor` apuntando a ella. El sustituto pasa por las mismas validaciones.
   */
  async absence(matchId: string, assignmentId: string, dto: RefereeAbsenceDto, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.ASSIGNMENTS);
    let warnings: string[] = [];
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.ASSIGNMENTS }, async (session) => {
      const match = await this.reload(matchId, session);
      const a = match.referees.find((x) => sameId(x._id, assignmentId));
      if (!a) throw new NotFoundException('Asignación no encontrada');
      if (a.status !== ACTIVE) throw new ConflictException('Ya está registrado como ausente');
      await this.matches.updateOne(
        { _id: match._id, 'referees._id': a._id },
        { $set: { 'referees.$.status': RefereeAssignmentStatus.ABSENT, 'referees.$.absentAt': new Date(), 'referees.$.absenceNote': dto.note ?? null } },
        { session },
      );
      if (dto.substituteId) {
        const updated = await this.reload(matchId, session);
        warnings = await this.add(session, updated, dto.substituteId, a.role, a._id);
      } else await this.refreshCentral({ _id: match._id }, session);
      // Una sola entrada: la ausencia y, si lo hay, su sustituto.
      await this.log.referee(
        session,
        { userId: user.id },
        match,
        MatchLogAction.REFEREE_ABSENT,
        {
          referee: { from: { refereeId: a.refereeId.toHexString(), role: a.role, status: ACTIVE }, to: { refereeId: a.refereeId.toHexString(), role: a.role, status: RefereeAssignmentStatus.ABSENT } },
          ...(dto.substituteId ? { substitute: { from: null, to: { refereeId: dto.substituteId, role: a.role } } } : {}),
        },
        dto.note ?? null,
      );
    });
    return this.matchView(matchId, warnings);
  }

  /** Alta de una asignación dentro de la transacción del partido, con el cerrojo del árbitro. */
  private async add(session: ClientSession, match: Match & { _id: Types.ObjectId }, refereeId: string, role: RefereeRole, substituteFor: Types.ObjectId | null) {
    const tournament = await this.tournaments.findById(match.tournamentId).select('organizerId').session(session).lean();
    const ref = await this.referees
      .findOneAndUpdate({ _id: toObjectId(refereeId) }, { $inc: { writeSeq: 1 } }, { session, returnDocument: 'after' })
      .lean();
    if (!ref || !tournament || !sameId(ref.organizerId, tournament.organizerId)) throw new BadRequestException('El árbitro no es del organizador del torneo');
    if (!ref.active || ref.archived) throw new ConflictException('El árbitro está desactivado');
    if (match.referees.some((a) => a.status === ACTIVE && sameId(a.refereeId, ref._id))) {
      throw new ConflictException('Ese árbitro ya tiene otro rol en este partido');
    }
    const slot = await this.slotOf(match, null, session);
    if (reserves(match.status)) {
      const conflicts = await this.conflicts(ref._id, slot, match._id, session, null);
      if (conflicts.length) throw conflictError(refereeName(ref), conflicts);
    }
    await this.matches.updateOne(
      { _id: match._id },
      { $push: { referees: { refereeId: ref._id, role, status: ACTIVE, substituteFor, assignedAt: new Date() } } },
      { session, runValidators: true },
    );
    await this.refreshCentral({ _id: match._id }, session);
    return availabilityWarnings(ref.availability, slot, { subject: refereeName(ref), of: 'del árbitro' });
  }

  // ─── Revalidaciones (cambios de horario, estado, cancha, duración o margen) ──

  /**
   * Antes de guardar un partido con otro horario, estado, cancha o torneo: sus árbitros en
   * funciones no pueden quedar en dos partidos a la vez. Se rechaza (409) sin escribir nada.
   */
  async revalidateMatch(
    session: ClientSession,
    next: { _id: Types.ObjectId; referees: RefereeAssignment[]; tournamentId: Types.ObjectId | string; venueId: Types.ObjectId | null; date: string; time: string; status: MatchStatus },
  ) {
    const active = next.referees.filter((a) => a.status === ACTIVE);
    if (!active.length || !reserves(next.status)) return;
    const slot = await this.slotOf({ ...next, tournamentId: toObjectId(next.tournamentId) }, null, session);
    for (const a of active) {
      const ref = await this.referees.findOneAndUpdate({ _id: a.refereeId }, { $inc: { writeSeq: 1 } }, { session, returnDocument: 'after' }).lean();
      const conflicts = await this.conflicts(a.refereeId, slot, next._id, session, null);
      if (conflicts.length) throw conflictError(ref ? refereeName(ref) : 'el árbitro', conflicts);
    }
  }

  /** Otra duración del torneo (o margen de una sede) cambia lo que ocupan sus partidos. */
  async revalidate(session: ClientSession, filter: Record<string, unknown>, override: Override) {
    const refereeIds = (await this.matches
      .distinct('referees.refereeId', { ...filter, status: { $in: RESERVING }, 'referees.status': ACTIVE })
      .session(session)) as Types.ObjectId[];
    for (const refereeId of refereeIds) {
      const ref = await this.referees.findOneAndUpdate({ _id: refereeId }, { $inc: { writeSeq: 1 } }, { session, returnDocument: 'after' }).lean();
      const docs = await this.matches
        .find({ status: { $in: RESERVING }, referees: { $elemMatch: { refereeId, status: ACTIVE } } })
        .select('tournamentId venueId date time homeTeamId awayTeamId')
        .session(session)
        .lean();
      const slots = await this.slots(docs, session, override);
      const pairs = conflictsAmong(docs.map((d, i) => ({ id: d._id.toHexString(), ...slots[i] })));
      if (pairs.length) {
        const ids = new Set(pairs.flatMap(([a, b]) => [a.id, b.id]));
        throw conflictError(ref ? refereeName(ref) : 'un árbitro', await this.describe(docs.filter((d) => ids.has(d._id.toHexString())), session, override));
      }
    }
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  private async conflicts(refereeId: Types.ObjectId, slot: Slot, excludeId: Types.ObjectId | null, session: ClientSession | null, override: Override | null) {
    const dates = [-2, -1, 0, 1, 2].map((d) => addDays(slot.date, d));
    const docs = await this.matches
      .find({
        status: { $in: RESERVING },
        date: { $in: dates },
        referees: { $elemMatch: { refereeId, status: ACTIVE } },
        ...(excludeId ? { _id: { $ne: excludeId } } : {}),
      })
      .select('tournamentId venueId date time homeTeamId awayTeamId')
      .session(session)
      .lean();
    if (!docs.length) return [];
    const slots = await this.slots(docs, session, override);
    return this.describe(docs.filter((_, i) => overlaps(slot, slots[i])), session, override);
  }

  /** Ocupación de un partido: duración de su torneo + margen de su sede (o el de 2A sin cancha). */
  private async slotOf(m: Pick<Match, 'tournamentId' | 'venueId' | 'date' | 'time'>, override: Override | null, session: ClientSession | null): Promise<Slot> {
    return (await this.slots([m], session, override))[0];
  }

  private async slots(docs: Pick<Match, 'tournamentId' | 'venueId' | 'date' | 'time'>[], session: ClientSession | null, override: Override | null): Promise<Slot[]> {
    const [ts, vs] = await Promise.all([
      this.tournaments.find({ _id: { $in: docs.map((d) => d.tournamentId) } }).select('name information.schedule.durationMinutes').session(session).lean(),
      this.venues.find({ _id: { $in: docs.map((d) => d.venueId).filter(Boolean) } }).select('bufferMinutes').session(session).lean(),
    ]);
    const minutes = new Map(ts.map((t) => [t._id.toHexString(), durationOf(t)]));
    const buffers = new Map(vs.map((v) => [v._id.toHexString(), v.bufferMinutes]));
    return docs.map((d) => ({
      date: d.date,
      time: d.time,
      duration: override?.tournamentId && sameId(override.tournamentId, d.tournamentId) ? override.minutes! : (minutes.get(d.tournamentId.toHexString()) ?? durationOf(null)),
      buffer: d.venueId
        ? override?.venueId && sameId(override.venueId, d.venueId)
          ? override.buffer!
          : (buffers.get(d.venueId.toHexString()) ?? DEFAULT_BUFFER_MINUTES)
        : DEFAULT_BUFFER_MINUTES,
    }));
  }

  private async describe(docs: MatchSlotDoc[], session: ClientSession | null, override: Override | null): Promise<RefereeConflict[]> {
    const [slots, ts, teams] = await Promise.all([
      this.slots(docs, session, override),
      this.tournaments.find({ _id: { $in: docs.map((d) => d.tournamentId) } }).select('name').session(session).lean(),
      this.teams.find({ _id: { $in: docs.flatMap((d) => [d.homeTeamId, d.awayTeamId]) } }).select('name').session(session).lean(),
    ]);
    const tName = new Map(ts.map((t) => [t._id.toHexString(), t.name]));
    const teamName = new Map(teams.map((t) => [t._id.toHexString(), t.name]));
    return docs.map((d, i) => ({
      matchId: d._id.toHexString(),
      tournamentName: tName.get(d.tournamentId.toHexString()) ?? '',
      date: d.date,
      time: d.time,
      endTime: clockOf(interval(slots[i]).end - slots[i].buffer),
      homeTeam: teamName.get(d.homeTeamId.toHexString()) ?? 'Local',
      awayTeam: teamName.get(d.awayTeamId.toHexString()) ?? 'Visitante',
    }));
  }

  /** Nombre público del central en funciones (el último asignado al rol CENTRAL). */
  private async refreshCentral(filter: Record<string, unknown>, session: ClientSession) {
    const docs = await this.matches.find(filter).select('referees').session(session).lean();
    const centralIds = docs.map((d) => d.referees.filter((a) => a.status === ACTIVE && a.role === RefereeRole.CENTRAL).at(-1)?.refereeId).filter(Boolean) as Types.ObjectId[];
    const refs = await this.referees.find({ _id: { $in: centralIds } }).select('firstName lastName').session(session).lean();
    const name = new Map(refs.map((r) => [r._id.toHexString(), refereeName(r)]));
    for (const d of docs) {
      const central = d.referees.filter((a) => a.status === ACTIVE && a.role === RefereeRole.CENTRAL).at(-1);
      await this.matches.updateOne({ _id: d._id }, { $set: { centralReferee: central ? (name.get(central.refereeId.toHexString()) ?? null) : null } }, { session });
    }
  }

  private async reload(matchId: string, session: ClientSession) {
    const match = await this.matches.findById(matchId).session(session).lean();
    if (!match) throw new NotFoundException('Partido no encontrado');
    return match;
  }

  /** Lectura del organizador (también con el torneo finalizado). */
  async assigned(matchId: string, user: AuthUser) {
    const match = await this.matches.findById(matchId).select('tournamentId').lean();
    if (!match) throw new NotFoundException('Partido no encontrado');
    await this.ownership.ownedTournament(match.tournamentId, user, Permission.VIEW);
    return this.matchView(matchId);
  }

  /** El partido con sus árbitros resueltos (vista del organizador). */
  async matchView(matchId: string, warnings: string[] = []) {
    const match = await this.matches.findById(matchId).select('referees centralReferee').lean();
    const refs = await this.referees.find({ _id: { $in: match!.referees.map((a) => a.refereeId) } }).select('firstName lastName').lean();
    const name = new Map(refs.map((r) => [r._id.toHexString(), refereeName(r)]));
    return {
      centralReferee: match!.centralReferee,
      referees: serialize(match!.referees).map((a) => ({ ...a, name: name.get(a.refereeId) ?? null })),
      warnings,
    };
  }
}

/** Vista del organizador (teléfono y correo incluidos: solo él la ve). */
function view(r: LeanReferee, usage?: { total: number; pending: number }) {
  const { writeSeq: _seq, organizerId: _org, ...rest } = r;
  return { ...serialize(rest), name: refereeName(r), matches: usage?.total ?? 0, pendingMatches: usage?.pending ?? 0 };
}

function conflictError(who: string, conflicts: RefereeConflict[]) {
  const first = conflicts[0];
  return new ConflictException({
    statusCode: 409,
    error: 'REFEREE_CONFLICT',
    message: `${who} ya arbitra ${first.homeTeam} vs ${first.awayTeam} (${first.tournamentName}) el ${first.date} de ${first.time} a ${first.endTime}${conflicts.length > 1 ? ` y ${conflicts.length - 1} más` : ''}.`,
    conflicts,
  });
}

function assertWindows(a: { weekly: { from: string; to: string }[] } | undefined) {
  for (const w of a?.weekly ?? []) {
    if (w.from >= w.to) throw new BadRequestException(`Horario inválido (${w.from}–${w.to}): el fin debe ser posterior al inicio`);
  }
}
