import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession, Connection } from 'mongoose';
import { Venue } from './schemas/venue.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { MatchStatus } from '../../common/enums/index.js';
import { sameId, serialize, toObjectId } from '../../common/utils/serialize.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RefereesService } from '../referees/referees.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import type { CheckSlotQueryDto, CreateFieldDto, CreateVenueDto, UpdateFieldDto, UpdateVenueDto } from './dto/venue.dto.js';
import {
  addDays,
  availabilityWarnings,
  clockOf,
  conflictsAmong,
  durationOf,
  interval,
  overlaps,
  RESERVING,
  reserves,
  type Availability,
  type Slot,
} from './occupancy.js';

/** Partidos que todavía se jugarán en la cancha: impiden desactivarla o eliminarla. */
const PENDING = [MatchStatus.SCHEDULED, MatchStatus.LIVE, MatchStatus.POSTPONED];

type LeanVenue = Venue & { _id: Types.ObjectId };
type TournamentDuration = { _id: Types.ObjectId; name: string; information?: { schedule?: { durationMinutes?: number | null } } };
export const venueLabel = (venueName: string, fieldName: string) => `${venueName} · ${fieldName}`;

export interface FieldConflict {
  matchId: string;
  tournamentId: string;
  tournamentName: string;
  date: string;
  time: string;
  endTime: string;
  homeTeam: string;
  awayTeam: string;
}

/**
 * Sedes y canchas del organizador (Etapa 2A). Las reservas se validan dentro de la transacción de
 * quien escribe el partido y toman el cerrojo de la sede (`writeSeq`): dos torneos del mismo
 * organizador que asignan la misma cancha a la vez no pueden confirmarse ambos sin verse.
 */
@Injectable()
export class VenuesService {
  constructor(
    @InjectModel(Venue.name) private readonly venues: Model<Venue>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectConnection() private readonly connection: Connection,
    private readonly referees: RefereesService,
    private readonly tournamentAccess: TournamentAccessService,
  ) {}

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  /** Sedes del organizador (sin las eliminadas) con el uso de cada cancha. */
  async list(user: AuthUser) {
    return this.listOf(toObjectId(user.id));
  }

  /**
   * Catálogo del PROPIETARIO del torneo, para quien asigna canchas en él (RBAC R3). El propietario
   * sale siempre del torneo (nunca del cliente); el colaborador solo lo lee, no lo administra.
   */
  async forTournament(tournamentId: string, user: AuthUser) {
    const { tournament } = await this.tournamentAccess.require(tournamentId, user.id, Permission.ASSIGNMENTS);
    return this.listOf(tournament.organizerId);
  }

  private async listOf(organizerId: Types.ObjectId) {
    const venues = await this.venues.find({ organizerId, archived: false }).sort({ name: 1 }).lean();
    const fieldIds = venues.flatMap((v) => v.fields.map((f) => f._id));
    const usage = await this.matches.aggregate<{ _id: Types.ObjectId; total: number; pending: number }>([
      { $match: { fieldId: { $in: fieldIds } } },
      { $group: { _id: '$fieldId', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $in: ['$status', PENDING] }, 1, 0] } } } },
    ]);
    const byField = new Map(usage.map((u) => [u._id.toHexString(), u]));
    return venues.map((v) => this.view(v, byField));
  }

  private view(v: LeanVenue, usage = new Map<string, { total: number; pending: number }>()) {
    const { writeSeq: _seq, organizerId: _org, ...rest } = v;
    return serialize({
      ...rest,
      fields: v.fields
        .filter((f) => !f.archived)
        .map((f) => ({ ...f, matches: usage.get(f._id.toHexString())?.total ?? 0, pendingMatches: usage.get(f._id.toHexString())?.pending ?? 0 })),
    });
  }

  async create(dto: CreateVenueDto, user: AuthUser) {
    dto.fields?.forEach((f) => assertAvailability(f.availability));
    const [created] = await this.venues.create([
      {
        organizerId: toObjectId(user.id),
        name: dto.name,
        address: dto.address ?? null,
        ...(dto.bufferMinutes !== undefined ? { bufferMinutes: dto.bufferMinutes } : {}),
        fields: (dto.fields ?? []).map((f) => ({ name: f.name, availability: f.availability ?? { weekly: [], closedDates: [] } })),
      },
    ]);
    return this.view(created.toObject());
  }

  async update(id: string, dto: UpdateVenueDto, user: AuthUser) {
    if (dto.fields !== undefined) throw new BadRequestException('Las canchas se administran en /venues/:id/fields');
    await this.write(id, user, async (venue, session) => {
      const set: Record<string, unknown> = {};
      if (dto.name !== undefined) set.name = dto.name;
      if (dto.address !== undefined) set.address = dto.address;
      if (dto.bufferMinutes !== undefined) set.bufferMinutes = dto.bufferMinutes;
      if (dto.active !== undefined) set.active = dto.active;
      if (dto.active === false && venue.active) await this.assertNoPending(venue.fields.map((f) => f._id), session, 'desactivar la sede');
      await this.venues.updateOne({ _id: venue._id }, { $set: set }, { session, runValidators: true });
      // Más margen puede hacer chocar partidos ya asignados: se rechaza sin tocar nada.
      if (dto.bufferMinutes !== undefined && dto.bufferMinutes > venue.bufferMinutes) {
        for (const f of venue.fields) await this.assertFieldConsistent(f._id, dto.bufferMinutes, session);
        // También alarga la ocupación de sus árbitros en esos partidos.
        await this.referees.revalidate(session, { venueId: venue._id }, { venueId: venue._id, buffer: dto.bufferMinutes });
      }
      if (dto.name !== undefined && dto.name !== venue.name) {
        for (const f of venue.fields) await this.matches.updateMany({ fieldId: f._id }, { $set: { venue: venueLabel(dto.name, f.name) } }, { session });
      }
    });
    return this.one(id);
  }

  /** Sin partidos se borra; con partidos se archiva (las referencias históricas siguen resolviendo). */
  async remove(id: string, user: AuthUser) {
    let archived = false;
    await this.write(id, user, async (venue, session) => {
      const fieldIds = venue.fields.map((f) => f._id);
      await this.assertNoPending(fieldIds, session, 'eliminar la sede');
      if (await this.matches.exists({ fieldId: { $in: fieldIds } }).session(session)) {
        archived = true;
        await this.venues.updateOne({ _id: venue._id }, { $set: { archived: true, active: false } }, { session });
      } else await this.venues.deleteOne({ _id: venue._id }, { session });
    });
    return { archived };
  }

  async addField(id: string, dto: CreateFieldDto, user: AuthUser) {
    assertAvailability(dto.availability);
    await this.write(id, user, async (venue, session) => {
      if (venue.fields.filter((f) => !f.archived).length >= 30) throw new BadRequestException('Una sede admite hasta 30 canchas');
      await this.venues.updateOne(
        { _id: venue._id },
        { $push: { fields: { name: dto.name, availability: dto.availability ?? { weekly: [], closedDates: [] } } } },
        { session, runValidators: true },
      );
    });
    return this.one(id);
  }

  async updateField(id: string, fieldId: string, dto: UpdateFieldDto, user: AuthUser) {
    assertAvailability(dto.availability);
    await this.write(id, user, async (venue, session) => {
      const field = fieldOf(venue, fieldId);
      const set: Record<string, unknown> = {};
      if (dto.name !== undefined) set['fields.$.name'] = dto.name;
      if (dto.availability !== undefined) set['fields.$.availability'] = dto.availability;
      if (dto.active !== undefined) set['fields.$.active'] = dto.active;
      if (dto.active === false && field.active) await this.assertNoPending([field._id], session, 'desactivar la cancha');
      await this.venues.updateOne({ _id: venue._id, 'fields._id': field._id }, { $set: set }, { session, runValidators: true });
      if (dto.name !== undefined && dto.name !== field.name) {
        await this.matches.updateMany({ fieldId: field._id }, { $set: { venue: venueLabel(venue.name, dto.name) } }, { session });
      }
    });
    return this.one(id);
  }

  async removeField(id: string, fieldId: string, user: AuthUser) {
    let archived = false;
    await this.write(id, user, async (venue, session) => {
      const field = fieldOf(venue, fieldId);
      await this.assertNoPending([field._id], session, 'eliminar la cancha');
      if (await this.matches.exists({ fieldId: field._id }).session(session)) {
        archived = true;
        await this.venues.updateOne({ _id: venue._id, 'fields._id': field._id }, { $set: { 'fields.$.archived': true, 'fields.$.active': false } }, { session });
      } else await this.venues.updateOne({ _id: venue._id }, { $pull: { fields: { _id: field._id } } }, { session });
    });
    return { archived, venue: await this.one(id) };
  }

  private async one(id: string) {
    const v = await this.venues.findById(id).lean();
    if (!v) throw new NotFoundException('Sede no encontrada');
    const usage = await this.matches.aggregate<{ _id: Types.ObjectId; total: number; pending: number }>([
      { $match: { fieldId: { $in: v.fields.map((f) => f._id) } } },
      { $group: { _id: '$fieldId', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $in: ['$status', PENDING] }, 1, 0] } } } },
    ]);
    return this.view(v, new Map(usage.map((u) => [u._id.toHexString(), u])));
  }

  /** Escritura sobre una sede propia, en transacción y con su cerrojo. */
  private async write(id: string, user: AuthUser, fn: (venue: LeanVenue, session: ClientSession) => Promise<void>) {
    await this.connection.transaction(async (session) => {
      const venue = await this.venues
        .findOneAndUpdate({ _id: toObjectId(id), archived: false }, { $inc: { writeSeq: 1 } }, { session, returnDocument: 'after' })
        .lean();
      if (!venue) throw new NotFoundException('Sede no encontrada');
      if (!sameId(venue.organizerId, user.id)) throw new ForbiddenException('Esta sede es de otro organizador');
      await fn(venue, session);
    });
  }

  private async assertNoPending(fieldIds: Types.ObjectId[], session: ClientSession, action: string) {
    const pending = await this.matches.countDocuments({ fieldId: { $in: fieldIds }, status: { $in: PENDING } }).session(session);
    if (pending) {
      throw new ConflictException(`No se puede ${action}: tiene ${pending} ${pending === 1 ? 'partido pendiente' : 'partidos pendientes'}. Asígnales otra cancha primero.`);
    }
  }

  // ─── Reservas ───────────────────────────────────────────────────────────────

  /** Vista previa para el formulario: conflictos (bloquearían) y advertencias (no bloquean). */
  async check(q: CheckSlotQueryDto, user: AuthUser) {
    // RBAC: quien asigna canchas en ese torneo; las canchas son las del propietario del torneo.
    const { tournament } = await this.tournamentAccess.require(q.tournamentId, user.id, Permission.ASSIGNMENTS);
    const venue = await this.venues.findOne({ 'fields._id': toObjectId(q.fieldId) }).lean();
    if (!venue || !sameId(venue.organizerId, tournament.organizerId)) throw new NotFoundException('Cancha no encontrada');
    const field = fieldOf(venue, q.fieldId, { archived: true });
    const slot: Slot = { date: q.date, time: q.time, duration: durationOf(tournament), buffer: venue.bufferMinutes };
    const { start, end } = interval(slot);
    return {
      start: q.time,
      end: clockOf(end - slot.buffer),
      freeAt: clockOf(end),
      crossesMidnight: Math.floor((end - slot.buffer) / 1440) !== Math.floor(start / 1440),
      conflicts: await this.conflicts(field._id, slot, q.matchId ? toObjectId(q.matchId) : null, null, null),
      warnings: availabilityWarnings(field.availability, slot),
    };
  }

  /**
   * Asigna (o mantiene) la cancha de un partido dentro de la transacción del partido: toma el
   * cerrojo de la sede, valida que sea del organizador y que esté activa si es una asignación
   * nueva, y rechaza (409) si se solapa con otro partido de esa cancha en cualquier torneo.
   */
  async assign(
    session: ClientSession,
    input: { matchId: Types.ObjectId | null; tournamentId: Types.ObjectId | string; date: string; time: string; status: MatchStatus; fieldId: Types.ObjectId | null; changed: boolean },
  ): Promise<{ venueId: Types.ObjectId | null; fieldId: Types.ObjectId | null; venue: string | null; warnings: string[] }> {
    if (!input.fieldId) return { venueId: null, fieldId: null, venue: null, warnings: [] };
    const tournament = await this.tournaments.findById(input.tournamentId).select('organizerId name information.schedule.durationMinutes').session(session).lean();
    const venue = await this.venues
      .findOneAndUpdate({ 'fields._id': input.fieldId }, { $inc: { writeSeq: 1 } }, { session, returnDocument: 'after' })
      .lean();
    if (!venue || !tournament || !sameId(venue.organizerId, tournament.organizerId)) {
      throw new BadRequestException('La cancha no pertenece a las sedes del organizador del torneo');
    }
    const field = fieldOf(venue, input.fieldId, { archived: true });
    if (input.changed && (!venue.active || venue.archived || !field.active || field.archived)) {
      throw new ConflictException('La cancha (o su sede) está desactivada: elige otra');
    }
    const slot: Slot = { date: input.date, time: input.time, duration: durationOf(tournament), buffer: venue.bufferMinutes };
    if (reserves(input.status)) {
      const conflicts = await this.conflicts(field._id, slot, input.matchId, session, null);
      if (conflicts.length) throw conflictError(venueLabel(venue.name, field.name), conflicts);
    }
    return { venueId: venue._id, fieldId: field._id, venue: venueLabel(venue.name, field.name), warnings: availabilityWarnings(field.availability, slot) };
  }

  /**
   * Cambiar la duración de un torneo cambia lo que ocupan todos sus partidos con cancha: se
   * rechaza (409) si así alguno chocaría, sin modificar nada.
   */
  async revalidateTournament(session: ClientSession, tournamentId: Types.ObjectId, duration: number) {
    const fieldIds = await this.matches.distinct('fieldId', { tournamentId, fieldId: { $ne: null }, status: { $in: RESERVING } }).session(session);
    for (const fieldId of fieldIds as Types.ObjectId[]) {
      const venue = await this.venues.findOneAndUpdate({ 'fields._id': fieldId }, { $inc: { writeSeq: 1 } }, { session, returnDocument: 'after' }).lean();
      if (venue) await this.assertFieldConsistent(fieldId, venue.bufferMinutes, session, { tournamentId, minutes: duration });
    }
  }

  /** Todos los partidos que reservan una cancha, sin solapes (con margen o duración nuevos). */
  private async assertFieldConsistent(fieldId: Types.ObjectId, buffer: number, session: ClientSession, override: { tournamentId: Types.ObjectId; minutes: number } | null = null) {
    const docs = await this.matches.find({ fieldId, status: { $in: RESERVING } }).select('tournamentId date time homeTeamId awayTeamId').session(session).lean();
    const durations = await this.durations(docs.map((d) => d.tournamentId), session, override);
    const slots = docs.map((d) => ({ id: d._id.toHexString(), date: d.date, time: d.time, duration: durations.get(d.tournamentId.toHexString())!.minutes, buffer }));
    const pairs = conflictsAmong(slots);
    if (pairs.length) {
      const ids = new Set(pairs.flatMap(([a, b]) => [a.id, b.id]));
      throw conflictError('la cancha', await this.describe(docs.filter((d) => ids.has(d._id.toHexString())), durations, buffer));
    }
  }

  private async conflicts(fieldId: Types.ObjectId, slot: Slot, excludeId: Types.ObjectId | null, session: ClientSession | null, override: { tournamentId: Types.ObjectId; minutes: number } | null) {
    // La duración máxima (1440) más el margen cabe en ±2 días.
    const dates = [-2, -1, 0, 1, 2].map((d) => addDays(slot.date, d));
    const docs = await this.matches
      .find({ fieldId, status: { $in: RESERVING }, date: { $in: dates }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
      .select('tournamentId date time homeTeamId awayTeamId')
      .session(session)
      .lean();
    if (!docs.length) return [];
    const durations = await this.durations(docs.map((d) => d.tournamentId), session, override);
    const hits = docs.filter((d) => overlaps(slot, { date: d.date, time: d.time, duration: durations.get(d.tournamentId.toHexString())!.minutes, buffer: slot.buffer }));
    return this.describe(hits, durations, slot.buffer);
  }

  private async durations(ids: Types.ObjectId[], session: ClientSession | null, override: { tournamentId: Types.ObjectId; minutes: number } | null) {
    const ts = await this.tournaments.find({ _id: { $in: ids } }).select('name information.schedule.durationMinutes').session(session).lean<TournamentDuration[]>();
    return new Map(ts.map((t) => [t._id.toHexString(), { name: t.name, minutes: override && sameId(override.tournamentId, t._id) ? override.minutes : durationOf(t) }]));
  }

  private async describe(docs: (Pick<Match, 'date' | 'time' | 'tournamentId' | 'homeTeamId' | 'awayTeamId'> & { _id: Types.ObjectId })[], durations: Map<string, { name: string; minutes: number }>, buffer: number): Promise<FieldConflict[]> {
    const teams = await this.teams.find({ _id: { $in: docs.flatMap((d) => [d.homeTeamId, d.awayTeamId]) } }).select('name').lean();
    const name = new Map(teams.map((t) => [t._id.toHexString(), t.name]));
    return docs.map((d) => {
      const t = durations.get(d.tournamentId.toHexString())!;
      return {
        matchId: d._id.toHexString(),
        tournamentId: d.tournamentId.toHexString(),
        tournamentName: t.name,
        date: d.date,
        time: d.time,
        endTime: clockOf(interval({ date: d.date, time: d.time, duration: t.minutes, buffer }).end - buffer),
        homeTeam: name.get(d.homeTeamId.toHexString()) ?? 'Local',
        awayTeam: name.get(d.awayTeamId.toHexString()) ?? 'Visitante',
      };
    });
  }
}

/** Cancha de la sede. Las eliminadas (archivadas) solo se resuelven para partidos que ya la usan. */
function fieldOf(venue: LeanVenue, fieldId: string | Types.ObjectId, { archived = false } = {}) {
  const field = venue.fields.find((f) => sameId(f._id, fieldId));
  if (!field || (field.archived && !archived)) throw new NotFoundException('Cancha no encontrada');
  return field;
}

function conflictError(where: string, conflicts: FieldConflict[]) {
  const first = conflicts[0];
  return new ConflictException({
    statusCode: 409,
    error: 'FIELD_CONFLICT',
    message: `Conflicto de horario en ${where}: ${first.homeTeam} vs ${first.awayTeam} (${first.tournamentName}) el ${first.date} de ${first.time} a ${first.endTime}${conflicts.length > 1 ? ` y ${conflicts.length - 1} más` : ''}.`,
    conflicts,
  });
}

function assertAvailability(a: Availability | undefined) {
  for (const w of a?.weekly ?? []) {
    if (w.from >= w.to) throw new BadRequestException(`Horario inválido (${w.from}–${w.to}): el fin debe ser posterior al inicio`);
  }
}

/**
 * Borrar partidos con cancha asignada libera sus reservas: nunca en silencio. Exige
 * `releaseAssignments: true` y dice cuántos son.
 */
export async function assertAssignmentsReleased(matches: Model<Match>, tournamentId: Types.ObjectId, release: boolean | undefined, session: ClientSession) {
  if (release) return;
  const assigned = await matches
    .countDocuments({ tournamentId, $or: [{ fieldId: { $ne: null } }, { 'referees.0': { $exists: true } }] })
    .session(session);
  if (assigned) {
    throw new ConflictException({
      statusCode: 409,
      error: 'ASSIGNMENTS_TO_RELEASE',
      message: `${assigned} ${assigned === 1 ? 'partido tiene cancha o árbitros asignados' : 'partidos tienen cancha o árbitros asignados'}: al reemplazar el calendario se liberarán. Para confirmarlo envía releaseAssignments: true.`,
      assigned,
    });
  }
}
