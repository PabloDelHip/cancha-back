import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { MatchSheet, type SheetTeam } from './schemas/match-sheet.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Round } from '../rounds/schemas/round.schema.js';
import { Player } from '../players/schemas/player.schema.js';
import { TeamMembership } from '../players/schemas/team-membership.schema.js';
import { User } from '../users/schemas/user.schema.js';
import { MatchLogAction, MatchStatus } from '../../common/enums/index.js';
import { assertStarted, OwnershipService } from '../../common/authorization/ownership.service.js';
import { TournamentAccessService } from '../../common/authorization/tournament-access.service.js';
import { Permission, permissionsOf } from '../../common/authorization/permissions.js';
import { sameId, toObjectId } from '../../common/utils/serialize.js';
import { belongsOn } from '../players/membership-rules.js';
import { assertSheetOpen } from '../matches/match-rules.js';
import { DisciplineService } from '../discipline/discipline.service.js';
import { RefereesService } from '../referees/referees.service.js';
import { MatchIncidentsService } from '../match-incidents/match-incidents.service.js';
import { MatchLogService } from '../match-log/match-log.service.js';
import { EvidenceService } from './evidence.service.js';
import { checkLineup, participationMismatch, participationOf } from './lineup.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { ReopenSheetDto, SaveObservationsDto, SaveSheetTeamDto } from './dto/match-sheet.dto.js';

/** Versión del documento de la ficha: un PDF futuro se genera de este JSON sin rehacer nada. */
export const SHEET_SCHEMA_VERSION = 1;

type LeanMatch = Match & { _id: Types.ObjectId };

/**
 * Ficha técnica digital (Módulo 2D). Reúne en un solo documento lo que ya existe (partido,
 * resultado, estadísticas, árbitros, incidencias, historial) sin copiarlo, más lo propio de la
 * ficha (alineaciones, sustituciones, observaciones y fotografías).
 *
 * - "Jugó" sigue siendo PlayerMatchStats (estadísticas, perfiles y disciplina no cambian). Con
 *   alineación, ambos deben coincidir: se valida al guardar la alineación (si ya hay estadísticas),
 *   al capturar el resultado y al cerrar.
 * - Cerrar (`Match.sheetClosed`) congela la información deportiva: los endpoints existentes la
 *   rechazan con 409 SHEET_CLOSED dentro de su transacción. Reabrir exige permiso y motivo. La regla
 *   de torneo FINISHED (solo lectura) sigue mandando: ni cerrar ni reabrir en un torneo finalizado.
 */
@Injectable()
export class MatchSheetService {
  constructor(
    @InjectModel(MatchSheet.name) private readonly sheets: Model<MatchSheet>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly ownership: OwnershipService,
    private readonly access: TournamentAccessService,
    private readonly discipline: DisciplineService,
    private readonly referees: RefereesService,
    private readonly incidents: MatchIncidentsService,
    private readonly log: MatchLogService,
    private readonly evidence: EvidenceService,
  ) {}

  // ─── Lectura ────────────────────────────────────────────────────────────────

  /** La ficha completa (VIEW; también con el torneo finalizado). */
  async view(matchId: string, user: AuthUser) {
    const match = await this.matches.findById(matchId).lean<LeanMatch>();
    if (!match) throw new NotFoundException('Partido no encontrado');
    const { tournament, role } = await this.access.require(match.tournamentId, user.id, Permission.VIEW);
    const [sheet, statRows, teams, round, referees, incidents, history, evidence] = await Promise.all([
      this.sheets.findOne({ matchId: match._id }).lean(),
      this.stats.find({ matchId: match._id }).lean(),
      this.teams.find({ _id: { $in: [match.homeTeamId, match.awayTeamId] } }).select('name shortName logoUrl').lean(),
      this.rounds.findOne({ tournamentId: match.tournamentId, number: match.round }).select('name').lean(),
      this.referees.matchView(matchId),
      this.incidents.list(matchId, user),
      this.log.ofMatch(matchId, user),
      this.evidence.ofMatch(match._id),
    ]);
    const playerIds = [...new Set([...statRows.map((s) => s.playerId.toHexString()), ...(sheet?.teams ?? []).flatMap((t) => t.players.map((p) => p.playerId.toHexString()))])];
    const [players, memberships, closer] = await Promise.all([
      this.players.find({ _id: { $in: playerIds.map(toObjectId) } }).select('firstName lastName nickname position photoUrl').lean(),
      this.memberships.find({ tournamentId: match.tournamentId, playerId: { $in: playerIds.map(toObjectId) } }).select('playerId teamId jerseyNumber active startDate endDate').lean(),
      match.sheetClosed ? this.users.findById(match.sheetClosed.by).select('firstName lastName').lean() : null,
    ]);
    const playerById = new Map(players.map((p) => [p._id.toHexString(), p]));
    const nameOf = (id: string) => {
      const p = playerById.get(id);
      return p ? `${p.firstName} ${p.lastName}` : null;
    };
    const jerseyOf = (id: string, teamId: Types.ObjectId) => memberships.find((m) => sameId(m.playerId, id) && sameId(m.teamId, teamId) && belongsOn(m, match.date))?.jerseyNumber ?? null;

    const side = (teamId: Types.ObjectId, which: 'home' | 'away') => {
      const team = teams.find((t) => sameId(t._id, teamId));
      const lineup = sheet?.teams.find((t) => sameId(t.teamId, teamId)) ?? null;
      const participation = lineup?.players.length ? participationOf(lineup) : null;
      const rows = statRows.filter((s) => sameId(s.teamId, teamId));
      const shirt = new Map(lineup?.players.map((p) => [p.playerId.toHexString(), p.jerseyNumber]) ?? []);
      const mismatch = participation ? participationMismatch(participation.participants, new Set(rows.filter((r) => r.played).map((r) => r.playerId.toHexString()))) : null;
      return {
        side: which,
        team: { id: teamId.toHexString(), name: team?.name ?? null, shortName: team?.shortName ?? null, logoUrl: team?.logoUrl ?? null },
        lineup: lineup
          ? {
              updatedAt: lineup.updatedAt,
              players: lineup.players.map((p) => {
                const id = p.playerId.toHexString();
                return {
                  playerId: id,
                  name: nameOf(id),
                  position: playerById.get(id)?.position ?? null,
                  jerseyNumber: p.jerseyNumber,
                  starter: p.starter,
                  captain: p.captain,
                  participated: participation!.participants.has(id),
                  enteredAt: participation!.entered.get(id) ?? null,
                  leftAt: participation!.left.get(id) ?? null,
                };
              }),
              substitutions: [...lineup.substitutions]
                .map((s, i) => ({ outPlayerId: s.outPlayerId.toHexString(), inPlayerId: s.inPlayerId.toHexString(), minute: s.minute, i }))
                .sort((a, b) => a.minute - b.minute || a.i - b.i)
                .map(({ i: _i, ...s }) => ({ ...s, outName: nameOf(s.outPlayerId), inName: nameOf(s.inPlayerId) })),
            }
          : null,
        stats: rows.map((r) => {
          const id = r.playerId.toHexString();
          return {
            playerId: id,
            name: nameOf(id),
            jerseyNumber: shirt.get(id) ?? jerseyOf(id, teamId),
            played: r.played,
            goals: r.goals,
            assists: r.assists,
            ownGoals: r.ownGoals ?? 0,
            yellowCards: r.yellowCards,
            redCards: r.redCards,
            sendOff: r.sendOff,
          };
        }),
        /** Alineación y estadísticas coinciden (null = sin alineación capturada). */
        consistency: mismatch ? { consistent: !mismatch.missing.length && !mismatch.extra.length, missing: mismatch.missing.map(nameOf), extra: mismatch.extra.map(nameOf) } : null,
      };
    };

    return {
      schemaVersion: SHEET_SCHEMA_VERSION,
      generatedAt: new Date(),
      tournament: { id: tournament._id.toHexString(), name: tournament.name, status: tournament.status },
      myRole: role,
      permissions: permissionsOf(role),
      match: {
        id: match._id.toHexString(),
        status: match.status,
        date: match.date,
        time: match.time,
        round: match.round,
        roundName: round?.name ?? null,
        stage: match.stage,
        venue: match.venue,
        fieldId: match.fieldId?.toHexString() ?? null,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        penalties: match.penalties,
        extraTime: match.extraTime,
      },
      closure: match.sheetClosed
        ? { closed: true, at: match.sheetClosed.at, by: closer ? `${closer.firstName} ${closer.lastName}`.trim() : null, role: match.sheetClosed.role, homeScore: match.sheetClosed.homeScore, awayScore: match.sheetClosed.awayScore }
        : { closed: false },
      referees: referees.referees.map((r) => ({ id: r.id, refereeId: r.refereeId, name: r.name, role: r.role, status: r.status, substituteFor: r.substituteFor, absenceNote: r.absenceNote })),
      centralReferee: referees.centralReferee,
      teams: [side(match.homeTeamId, 'home'), side(match.awayTeamId, 'away')],
      incidents,
      observations: sheet?.observations ?? null,
      evidence,
      history,
    };
  }

  // ─── Escritura (RESULTS, como la captura) ────────────────────────────────────

  /** Alineación y sustituciones de un equipo (reemplaza las anteriores de ese equipo). */
  async saveTeam(matchId: string, teamId: string, dto: SaveSheetTeamDto, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.RESULTS);
    let warnings: string[] = [];
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.RESULTS }, async (session, tournamentStatus) => {
      assertStarted(tournamentStatus);
      const match = await this.reload(matchId, before.tournamentId, session);
      assertSheetOpen(match);
      if (match.status === MatchStatus.CANCELLED) throw new ConflictException('El partido está cancelado');
      const team = sameId(teamId, match.homeTeamId) ? match.homeTeamId : sameId(teamId, match.awayTeamId) ? match.awayTeamId : null;
      if (!team) throw new BadRequestException('El equipo no juega este partido');
      const rival = sameId(team, match.homeTeamId) ? match.awayTeamId : match.homeTeamId;

      const { errors, participation } = checkLineup(
        dto.players.map((p) => ({ playerId: p.playerId, jerseyNumber: p.jerseyNumber ?? null, starter: p.starter, captain: !!p.captain })),
        dto.substitutions,
      );
      if (errors.length) {
        // Los mensajes citan ids: se cambian por nombres.
        const ids = [...new Set(dto.players.map((p) => p.playerId).concat(dto.substitutions.flatMap((x) => [x.outPlayerId, x.inPlayerId])))];
        const names = await this.names(ids, session);
        throw new BadRequestException(errors.map((e) => ids.reduce((msg, id, i) => msg.split(id).join(names[i]), e)));
      }

      // Pertenencia: plantilla de ESE equipo en este torneo, vigente en la fecha del partido.
      const ids = dto.players.map((p) => toObjectId(p.playerId));
      const memberships = await this.memberships.find({ tournamentId: match.tournamentId, playerId: { $in: ids } }).session(session).lean();
      const notMember = dto.players.filter((p) => !memberships.some((m) => sameId(m.playerId, p.playerId) && sameId(m.teamId, team) && belongsOn(m, match.date)));
      if (notMember.length) {
        const names = await this.names(notMember.map((p) => p.playerId), session);
        throw new BadRequestException(`No están registrados con este equipo en la fecha del partido: ${names.join(', ')}`);
      }
      // Nadie en los dos equipos (alineación del rival o estadísticas con el rival).
      const sheet = await this.sheets.findOne({ matchId: match._id }).session(session).lean();
      const rivalLineup = sheet?.teams.find((t) => sameId(t.teamId, rival));
      const rivalStats = await this.stats.find({ matchId: match._id, teamId: rival, playerId: { $in: ids } }).select('playerId').session(session).lean();
      const both = dto.players.filter((p) => rivalLineup?.players.some((x) => sameId(x.playerId, p.playerId)) || rivalStats.some((s) => sameId(s.playerId, p.playerId)));
      if (both.length) throw new BadRequestException(`Ya figuran con el rival en este partido: ${(await this.names(both.map((p) => p.playerId), session)).join(', ')}`);

      // Elegibilidad: suspendidos que participan (el reglamento decide si se bloquea o solo se avisa).
      const suspended = await this.discipline.suspendedAmong(match, [...participation.participants], session);
      if (suspended.playerIds.length) {
        const names = await this.names(suspended.playerIds, session);
        if (suspended.block) throw new ConflictException(`Jugadores suspendidos para este partido: ${names.join(', ')}. Déjalos como suplentes sin ingresar o revisa su sanción en Disciplina.`);
        warnings = [`Participan estando suspendidos: ${names.join(', ')}. Al capturar las estadísticas quedará registrada la incidencia en Disciplina.`];
      }

      // Con estadísticas ya capturadas para el equipo, deben coincidir con la participación.
      const rows = await this.stats.find({ matchId: match._id, teamId: team }).select('playerId played').session(session).lean();
      if (rows.length) {
        const { missing, extra } = participationMismatch(participation.participants, new Set(rows.filter((r) => r.played).map((r) => r.playerId.toHexString())));
        if (missing.length || extra.length) {
          throw new ConflictException({
            statusCode: 409,
            error: 'LINEUP_MISMATCH',
            message: [
              missing.length ? `Participan según la alineación pero no figuran como jugados en las estadísticas: ${(await this.names(missing, session)).join(', ')}` : null,
              extra.length ? `Figuran como jugados en las estadísticas sin participar según la alineación: ${(await this.names(extra, session)).join(', ')}` : null,
            ]
              .filter(Boolean)
              .join('. ') + '. Corrige la alineación o las estadísticas.',
          });
        }
      }

      const previous = sheet?.teams.find((t) => sameId(t.teamId, team)) ?? null;
      const reason = dto.reason?.trim() || null;
      if (previous?.players.length && match.status === MatchStatus.FINISHED && !reason) {
        throw new BadRequestException('Indica el motivo de la corrección de la alineación (el partido ya finalizó)');
      }
      const next: SheetTeam = {
        teamId: team,
        players: dto.players.map((p) => ({
          playerId: toObjectId(p.playerId),
          // Sin dorsal indicado, el de su participación en el torneo.
          jerseyNumber: p.jerseyNumber !== undefined ? p.jerseyNumber : (memberships.find((m) => sameId(m.playerId, p.playerId) && sameId(m.teamId, team) && belongsOn(m, match.date))?.jerseyNumber ?? null),
          starter: p.starter,
          captain: !!p.captain,
        })),
        substitutions: dto.substitutions.map((s) => ({ outPlayerId: toObjectId(s.outPlayerId), inPlayerId: toObjectId(s.inPlayerId), minute: s.minute })),
        updatedAt: new Date(),
        updatedBy: toObjectId(user.id),
      };
      const teamsNext = [...(sheet?.teams ?? []).filter((t) => !sameId(t.teamId, team)), next];
      await this.sheets.updateOne(
        { matchId: match._id },
        { $set: { teams: teamsNext }, $setOnInsert: { tournamentId: match.tournamentId, matchId: match._id, observations: null } },
        { upsert: true, session, runValidators: true },
      );
      const snap = (t: SheetTeam | null) =>
        t ? { teamId: t.teamId.toHexString(), players: t.players.map((p) => ({ playerId: p.playerId.toHexString(), jerseyNumber: p.jerseyNumber, starter: p.starter, captain: p.captain })), substitutions: t.substitutions.map((s) => ({ outPlayerId: s.outPlayerId.toHexString(), inPlayerId: s.inPlayerId.toHexString(), minute: s.minute })) } : null;
      await this.log.entry(session, { userId: user.id }, match, MatchLogAction.SHEET_LINEUP_SAVED, { lineup: { from: snap(previous), to: snap(next) } }, reason);
    });
    return { ...(await this.view(matchId, user)), warnings };
  }

  async saveObservations(matchId: string, dto: SaveObservationsDto, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.RESULTS);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.RESULTS }, async (session) => {
      const match = await this.reload(matchId, before.tournamentId, session);
      assertSheetOpen(match);
      const next = dto.observations?.trim() || null;
      const sheet = await this.sheets.findOne({ matchId: match._id }).select('observations').session(session).lean();
      const previous = sheet?.observations ?? null;
      if (previous === next) return;
      await this.sheets.updateOne(
        { matchId: match._id },
        { $set: { observations: next }, $setOnInsert: { tournamentId: match.tournamentId, matchId: match._id, teams: [] } },
        { upsert: true, session, runValidators: true },
      );
      await this.log.entry(session, { userId: user.id }, match, MatchLogAction.SHEET_OBSERVATIONS_SAVED, { observations: { from: previous, to: next } });
    });
    return this.view(matchId, user);
  }

  // ─── Cierre y reapertura ────────────────────────────────────────────────────

  /**
   * Cerrar (SHEET_CLOSE): partido FINISHED con marcador; alineaciones capturadas válidas y
   * coherentes con las estadísticas. Alineaciones, sustituciones y fotos NO son obligatorias.
   */
  async close(matchId: string, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.SHEET_CLOSE);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.SHEET_CLOSE }, async (session) => {
      const match = await this.reload(matchId, before.tournamentId, session);
      if (match.sheetClosed) throw new ConflictException('La ficha ya está cerrada');
      if (match.status !== MatchStatus.FINISHED || match.homeScore === null || match.awayScore === null) {
        throw new ConflictException('Solo se cierra la ficha de un partido finalizado con su resultado');
      }
      const sheet = await this.sheets.findOne({ matchId: match._id }).session(session).lean();
      const rows = await this.stats.find({ matchId: match._id }).select('playerId teamId played').session(session).lean();
      const problems: string[] = [];
      for (const team of sheet?.teams ?? []) {
        if (!team.players.length) continue;
        const errors = checkLineup(
          team.players.map((p) => ({ ...p, playerId: p.playerId.toHexString() })),
          team.substitutions.map((s) => ({ outPlayerId: s.outPlayerId.toHexString(), inPlayerId: s.inPlayerId.toHexString(), minute: s.minute })),
        ).errors;
        problems.push(...errors);
        const { missing, extra } = participationMismatch(participationOf(team).participants, new Set(rows.filter((r) => r.played && sameId(r.teamId, team.teamId)).map((r) => r.playerId.toHexString())));
        if (missing.length) problems.push(`Participan según la alineación sin estadísticas de jugado: ${(await this.names(missing, session)).join(', ')}`);
        if (extra.length) problems.push(`Jugados en las estadísticas sin participar según la alineación: ${(await this.names(extra, session)).join(', ')}`);
      }
      if (problems.length) throw new ConflictException({ statusCode: 409, error: 'SHEET_INCONSISTENT', message: `La ficha tiene datos inconsistentes: ${problems.join('. ')}`, problems });
      const role = await this.access.roleOf(match.tournamentId, user.id, session);
      const closed = { at: new Date(), by: toObjectId(user.id), role, homeScore: match.homeScore, awayScore: match.awayScore };
      await this.matches.updateOne({ _id: match._id, sheetClosed: null }, { $set: { sheetClosed: closed } }, { session });
      await this.log.entry(session, { userId: user.id }, match, MatchLogAction.SHEET_CLOSED, {
        sheet: { from: 'OPEN', to: 'CLOSED' },
        score: { from: null, to: { home: match.homeScore, away: match.awayScore } },
      });
    });
    return this.view(matchId, user);
  }

  /** Reabrir (SHEET_REOPEN) con motivo. En un torneo finalizado no se puede (cerrojo del torneo). */
  async reopen(matchId: string, dto: ReopenSheetDto, user: AuthUser) {
    const before = await this.ownership.match(matchId, user, Permission.SHEET_REOPEN);
    await this.ownership.inTournament(before.tournamentId, { user, permission: Permission.SHEET_REOPEN }, async (session) => {
      const match = await this.reload(matchId, before.tournamentId, session);
      if (!match.sheetClosed) throw new ConflictException('La ficha no está cerrada');
      await this.matches.updateOne({ _id: match._id }, { $set: { sheetClosed: null } }, { session });
      await this.log.entry(
        session,
        { userId: user.id },
        match,
        MatchLogAction.SHEET_REOPENED,
        { sheet: { from: { status: 'CLOSED', closedAt: match.sheetClosed.at, closedBy: match.sheetClosed.by.toHexString() }, to: 'OPEN' } },
        dto.reason,
      );
    });
    return this.view(matchId, user);
  }

  // ─── Internos ───────────────────────────────────────────────────────────────

  private async names(ids: string[], session: ClientSession) {
    const list = await this.players.find({ _id: { $in: ids.map(toObjectId) } }).select('firstName lastName').session(session).lean();
    const byId = new Map(list.map((p) => [p._id.toHexString(), `${p.firstName} ${p.lastName}`]));
    return ids.map((id) => byId.get(id) ?? id);
  }

  private async reload(id: string, tournamentId: Types.ObjectId, session: ClientSession) {
    const match = await this.matches.findById(id).session(session).lean<LeanMatch>();
    if (!match) throw new NotFoundException('Partido no encontrado');
    if (!sameId(match.tournamentId, tournamentId)) throw new ConflictException('El partido cambió de torneo; recarga e inténtalo de nuevo');
    return match;
  }
}
