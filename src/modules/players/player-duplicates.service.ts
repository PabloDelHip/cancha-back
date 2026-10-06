import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Player } from './schemas/player.schema.js';
import { TeamMembership } from './schemas/team-membership.schema.js';
import { TeamRoster } from '../teams/schemas/team-roster.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { Tournament } from '../tournaments/schemas/tournament.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { TeamRosterStatus } from '../../common/enums/index.js';
import { publicPlayer, teamRef } from '../../common/utils/public.js';
import { duplicateScore, MAX_CANDIDATES, prefilterRegexes, type NameInput } from './duplicates.js';

export const PLAYER_POSSIBLE_DUPLICATES = 'PLAYER_POSSIBLE_DUPLICATES';

/**
 * Posibles duplicados de un jugador que se va a registrar, con lo necesario para reconocerlos:
 * nombre, apodo, posición, edad, foto, equipos actuales, torneos recientes y partidos jugados.
 * Solo datos públicos (los mismos de la búsqueda y los perfiles). Consultas fijas: prefiltro de
 * jugadores + (plantillas globales · participaciones · partidos) + (equipos · torneos).
 */
@Injectable()
export class PlayerDuplicatesService {
  constructor(
    @InjectModel(Player.name) private readonly players: Model<Player>,
    @InjectModel(TeamMembership.name) private readonly memberships: Model<TeamMembership>,
    @InjectModel(TeamRoster.name) private readonly rosters: Model<TeamRoster>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
  ) {}

  async find(input: NameInput) {
    const re = prefilterRegexes(input);
    if (!re) return [];
    const pool = await this.players
      .find({ $and: [{ searchName: { $regex: re.first } }, { searchName: { $regex: re.last } }] })
      .limit(300)
      .lean();
    const scored = pool
      .map((p) => ({ p, score: duplicateScore(input, p) }))
      .filter((x): x is { p: (typeof pool)[number]; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.p.lastName.localeCompare(b.p.lastName))
      .slice(0, MAX_CANDIDATES);
    if (!scored.length) return [];

    const ids = scored.map((x) => x.p._id);
    const [rosterRows, memberRows, played] = await Promise.all([
      this.rosters.find({ playerId: { $in: ids }, status: TeamRosterStatus.ACTIVE }).select('playerId teamId').lean(),
      this.memberships.find({ playerId: { $in: ids } }).sort({ startDate: -1 }).select('playerId teamId tournamentId active').lean(),
      this.stats.aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { playerId: { $in: ids }, played: true } }, { $group: { _id: '$playerId', n: { $sum: 1 } } }]),
    ]);
    const teamIds = [...new Set([...rosterRows, ...memberRows].map((r) => r.teamId.toHexString()))];
    const tournamentIds = [...new Set(memberRows.map((m) => m.tournamentId.toHexString()))];
    const [teamDocs, tournamentDocs] = await Promise.all([
      this.teams.find({ _id: { $in: teamIds.map((id) => new Types.ObjectId(id)) } }).select('name shortName logoUrl colors').lean(),
      this.tournaments.find({ _id: { $in: tournamentIds.map((id) => new Types.ObjectId(id)) } }).select('name status startDate').lean(),
    ]);
    const teamById = new Map(teamDocs.map((t) => [t._id.toHexString(), teamRef(t)]));
    const tournamentById = new Map(tournamentDocs.map((t) => [t._id.toHexString(), { id: t._id.toHexString(), name: t.name, status: t.status }]));
    const playedBy = new Map(played.map((r) => [r._id.toHexString(), r.n]));

    return scored.map(({ p, score }) => {
      const id = p._id.toHexString();
      const own = memberRows.filter((m) => m.playerId.equals(p._id));
      // Equipos: plantilla global actual primero, después los de sus participaciones en torneos.
      const teamOrder = [
        ...rosterRows.filter((r) => r.playerId.equals(p._id)).map((r) => r.teamId.toHexString()),
        ...own.map((m) => m.teamId.toHexString()),
      ];
      const tournaments = [...new Set(own.map((m) => m.tournamentId.toHexString()))].slice(0, 3);
      return {
        player: publicPlayer(p),
        teams: [...new Set(teamOrder)].slice(0, 4).map((t) => teamById.get(t)).filter((t) => t !== undefined),
        tournaments: tournaments.map((t) => tournamentById.get(t)).filter((t) => t !== undefined),
        appearances: playedBy.get(id) ?? 0,
        /** EXACT: mismo nombre y apellidos. SIMILAR: parecido (variantes, acentos, nombre compuesto…). */
        match: score >= 1 ? ('EXACT' as const) : ('SIMILAR' as const),
      };
    });
  }

  /** Lanza 409 con los candidatos si los hay (sin crear nada). `confirmNew` lo omite. */
  async assertNoneOrConfirmed(input: NameInput & { confirmNew?: boolean }) {
    if (input.confirmNew) return;
    const candidates = await this.find(input);
    if (!candidates.length) return;
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: PLAYER_POSSIBLE_DUPLICATES,
      message: 'Encontramos jugadores que podrían ser la misma persona. Revisa si alguno corresponde al jugador que intentas registrar.',
      candidates,
    });
  }
}
