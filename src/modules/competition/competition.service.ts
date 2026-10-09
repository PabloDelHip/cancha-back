import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { Tournament, DEFAULT_SETTINGS } from '../tournaments/schemas/tournament.schema.js';
import { TournamentTeam } from '../tournaments/schemas/tournament-team.schema.js';
import { Match } from '../matches/schemas/match.schema.js';
import { Round } from '../rounds/schemas/round.schema.js';
import { PlayerMatchStats } from '../matches/schemas/player-match-stats.schema.js';
import { Team } from '../teams/schemas/team.schema.js';
import { CompetitionSystem, KnockoutTiebreak, MatchLogCause, MatchLogSource, MatchStatus, PhaseType } from '../../common/enums/index.js';
import { MatchLogService, type Actor } from '../match-log/match-log.service.js';
import { toObjectId } from '../../common/utils/serialize.js';
import { teamRef } from '../../common/utils/public.js';
import { assertStarted, OwnershipService } from '../../common/authorization/ownership.service.js';
import { Permission } from '../../common/authorization/permissions.js';
import type { AuthUser } from '../auth/auth.types.js';
import { bracketSize, knockoutRoundNumber, phaseRounds, reconcile, roundName, tiebreakFor } from './bracket.js';
import { knockoutMatch, manualBracketSizes, manualKnockoutPhase, matchDoc, planKnockout } from './planner.js';
import { phasesOf } from './formats.js';
import { buildStructure, tiebreakRules, type StructureInput } from './structure.js';
import type { StagedMatch } from './tables.js';
import { pointsRuleOf } from '../statistics/calculations.js';
import type { MatchStage, TiebreakDecision, TournamentPhase } from './types.js';
import type { AdvancePhaseDto, CreateTieDto } from './dto/advance.dto.js';

export const STAGED_MATCH_FIELDS = 'tournamentId round date time status homeTeamId awayTeamId homeScore awayScore stage penalties extraTime';

export type LeanStagedMatch = {
  _id: Types.ObjectId;
  tournamentId: Types.ObjectId;
  round: number;
  date: string;
  time: string;
  status: MatchStatus;
  homeTeamId: Types.ObjectId;
  awayTeamId: Types.ObjectId;
  homeScore: number | null;
  awayScore: number | null;
  stage?: MatchStage | null;
  penalties?: { home: number; away: number } | null;
  extraTime?: boolean;
};

export function toStaged(m: LeanStagedMatch): StagedMatch {
  return {
    id: m._id.toHexString(),
    tournamentId: m.tournamentId.toHexString(),
    round: m.round,
    date: m.date,
    time: m.time,
    status: m.status,
    homeTeamId: m.homeTeamId.toHexString(),
    awayTeamId: m.awayTeamId.toHexString(),
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    stage: m.stage ?? null,
    penalties: m.penalties ?? null,
    extraTime: m.extraTime ?? false,
  };
}

/** Entrada de buildStructure desde un torneo leído (lean). */
export function structureInput(
  t: Pick<Tournament, 'settings' | 'phases'>,
  matches: StagedMatch[],
  teamIds: string[],
  nameOf: (id: string) => string,
): StructureInput {
  const s = { ...DEFAULT_SETTINGS, ...t.settings };
  return {
    system: s.system,
    points: pointsRuleOf(s),
    playoffTeams: s.playoffTeams,
    qualifiersPerGroup: s.qualifiersPerGroup,
    knockoutTiebreak: s.knockoutTiebreak ?? KnockoutTiebreak.PENALTIES,
    finalTiebreak: s.finalTiebreak ?? null,
    phases: t.phases ?? [],
    matches,
    teamIds,
    nameOf,
  };
}

/**
 * Estructura de competición: lectura pública, avance de fase y reglas de escritura sobre los
 * partidos que forman parte de ella. Toda escritura corre dentro del cerrojo del torneo
 * (OwnershipService.inTournament), así que dos avances, dos resultados de eliminatoria o un avance
 * y un cierre no pueden cruzarse: la segunda operación ve lo que hizo la primera.
 */
@Injectable()
export class CompetitionService {
  constructor(
    @InjectModel(Tournament.name) private readonly tournaments: Model<Tournament>,
    @InjectModel(TournamentTeam.name) private readonly enrollments: Model<TournamentTeam>,
    @InjectModel(Match.name) private readonly matches: Model<Match>,
    @InjectModel(Round.name) private readonly rounds: Model<Round>,
    @InjectModel(Team.name) private readonly teams: Model<Team>,
    @InjectModel(PlayerMatchStats.name) private readonly stats: Model<PlayerMatchStats>,
    private readonly ownership: OwnershipService,
    private readonly log: MatchLogService,
  ) {}

  /** Torneo + partidos + inscritos + equipos (4 consultas fijas). */
  async context(tournamentId: string | Types.ObjectId, session: ClientSession | null = null) {
    const tid = toObjectId(tournamentId);
    const [tournament, rows, enrolled] = await Promise.all([
      this.tournaments.findById(tid).select('name status settings phases dataCoverage').session(session).lean(),
      this.matches.find({ tournamentId: tid }).select(STAGED_MATCH_FIELDS).session(session).lean<LeanStagedMatch[]>(),
      this.enrollments.find({ tournamentId: tid }).select('teamId').session(session).lean(),
    ]);
    if (!tournament) throw new NotFoundException(`Torneo ${tournamentId} no encontrado`);
    const matches = rows.map(toStaged);
    const teamIds = enrolled.map((e) => e.teamId.toHexString());
    const ids = new Set([...teamIds, ...matches.flatMap((m) => [m.homeTeamId, m.awayTeamId])]);
    const teams = await this.teams
      .find({ _id: { $in: [...ids].map(toObjectId) } })
      .select('name shortName logoUrl colors')
      .session(session)
      .lean();
    const teamMap = new Map(teams.map((t) => [t._id.toHexString(), teamRef(t)]));
    const input = structureInput(tournament, matches, teamIds, (id) => teamMap.get(id)?.name ?? '');
    return { tournament, matches, teamMap, input };
  }

  /** GET /tournaments/:id/structure (público). Tablas, cuadro y campeón: solo con cobertura FULL. */
  async structure(id: string) {
    const { tournament, teamMap, input } = await this.context(id);

    const view = buildStructure(input);
    const s = { ...DEFAULT_SETTINGS, ...tournament.settings };
    return {
      tournamentId: id,
      status: tournament.status,
      settings: {
        system: s.system,
        roundRobinLegs: s.roundRobinLegs,
        knockoutLegs: s.knockoutLegs,
        groupCount: s.groupCount,
        qualifiersPerGroup: s.qualifiersPerGroup,
        playoffTeams: s.playoffTeams,
        knockoutTiebreak: s.knockoutTiebreak ?? KnockoutTiebreak.PENALTIES,
        finalTiebreak: s.finalTiebreak ?? null,
        reseed: s.reseed ?? false,
      },
      ...view,
      tiebreaks: (tournament.phases ?? []).flatMap((p) => (p.tiebreaks ?? []).map((t) => ({ phase: p.index, ...t }))),
      teams: Object.fromEntries(teamMap),
    };
  }

  /**
   * Genera la fase siguiente (eliminatoria) desde la tabla o los grupos terminados. Idempotente frente
   * a la concurrencia: dentro del cerrojo, una segunda petición ve la fase ya creada y recibe 409.
   */
  async advance(id: string, dto: AdvancePhaseDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    await this.ownership.inTournament(id, { user, permission: Permission.SCHEDULE }, async (session, status) => {
      assertStarted(status);
      const { tournament, input } = await this.context(id, session);

      const phases = mergeTiebreaks(tournament.phases ?? [], dto.tiebreaks ?? []);
      const view = buildStructure({ ...input, phases });
      if (!view.next) throw new ConflictException('Este torneo no tiene otra fase por generar');
      if (dto.manual) {
        // A mano: el organizador elige los cruces. No hace falta la fase anterior terminada (pueden
        // quedar partidos pendientes) ni desempates, y la fase anterior no se congela.
        if (!view.phases[view.next.index - 1]?.generated) throw new ConflictException('Primero arma la fase anterior');
        const sizes = manualBracketSizes(input.teamIds.length);
        if (!sizes.includes(dto.bracketSize ?? 0)) throw new BadRequestException(`El cuadro puede empezar con ${sizes.join(', ')} equipos`);
        const s = { ...DEFAULT_SETTINGS, ...tournament.settings };
        const phase = manualKnockoutPhase(view.next.index, s.knockoutLegs, dto.bracketSize!, await this.nextRoundNumber(toObjectId(id), session));
        await this.tournaments.updateOne({ _id: toObjectId(id) }, { $set: { phases: [...phases, phase] } }, { session });
        return;
      }
      const tid = toObjectId(id);
      const plan = planNextKnockout(view, tournament.settings, dto, await this.nextRoundNumber(tid, session));
      await this.rounds.insertMany(plan.rounds.map((r) => ({ tournamentId: tid, ...r })), { session });
      if (plan.matches.length) await this.matches.insertMany(plan.matches.map((m) => matchDoc(tid, m)), { session });
      await this.tournaments.updateOne({ _id: tid }, { $set: { phases: [...phases, plan.phase!] } }, { session });
    });
    return this.structure(id);
  }

  /**
   * POST /tournaments/:id/phases/advance/preview: la eliminatoria que se generaría con los
   * clasificados (cruces, quién pasa directo y fechas), SIN guardar nada. El organizador decide si
   * la usa (advance) o la arma a mano.
   */
  async previewAdvance(id: string, dto: AdvancePhaseDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    const { tournament, input, teamMap } = await this.context(id);

    const view = buildStructure({ ...input, phases: mergeTiebreaks(tournament.phases ?? [], dto.tiebreaks ?? []) });
    if (!view.next) throw new ConflictException('Este torneo no tiene otra fase por generar');
    const plan = planNextKnockout(view, tournament.settings, dto, await this.nextRoundNumber(toObjectId(id), null));
    const phase = plan.phase!;
    const size = bracketSize(phase);
    return {
      seeds: phase.seeds ?? [],
      reseed: !!phase.reseed,
      rounds: Array.from({ length: phaseRounds(phase) }, (_, r) => ({
        name: roundName(size / 2 ** r),
        ties: (phase.bracket ?? []).filter((t) => t.round === r).map((t) => ({ slot: t.slot, home: t.home, away: t.away })),
      })),
      matches: plan.matches.map((m) => ({ homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId, date: m.date, time: m.time, roundName: plan.rounds.find((x) => x.number === m.round)?.name ?? null })),
      teams: Object.fromEntries(teamMap),
    };
  }

  /** Primera jornada libre después de todo lo programado. */
  private async nextRoundNumber(tid: Types.ObjectId, session: ClientSession | null) {
    const [lastRound, lastMatch] = await Promise.all([
      this.rounds.findOne({ tournamentId: tid }).sort({ number: -1 }).select('number').session(session).lean(),
      this.matches.findOne({ tournamentId: tid }).sort({ round: -1 }).select('round').session(session).lean(),
    ]);
    return Math.max(lastRound?.number ?? 0, lastMatch?.round ?? 0) + 1;
  }

  /** Fase eliminatoria armada a mano (o 409 si el cuadro es automático o no existe). */
  private manualPhase(phases: TournamentPhase[], index: number) {
    const phase = phases.find((p) => p.index === index && p.type === PhaseType.KNOCKOUT);
    if (!phase) throw new NotFoundException('Esa fase eliminatoria no existe');
    if (!phase.manual && !phase.reseed) throw new ConflictException('Este cuadro se arma automáticamente con los clasificados: sus cruces no se eligen a mano');
    return phase;
  }

  /** Con reacomodo, la primera ronda sale de la siembra: solo las siguientes se arman a mano. */
  private assertHandRound(phase: TournamentPhase, round: number) {
    if (phase.reseed && !phase.manual && round === 0) {
      throw new ConflictException('La primera ronda se arma con la siembra de los clasificados (1 vs 8, 4 vs 5…); las siguientes las armas tú');
    }
  }

  /**
   * Agregar un cruce a un cuadro armado a mano: el organizador elige la ronda y los dos equipos, y
   * se crean sus partidos (uno, o ida y vuelta) con la fecha que él decida. Quién pasa y el campeón
   * se siguen derivando de los resultados.
   */
  async createTie(id: string, phaseIndex: number, dto: CreateTieDto, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    await this.ownership.inTournament(id, { user, permission: Permission.SCHEDULE }, async (session) => {
      const { tournament, input } = await this.context(id, session);

      const phases = tournament.phases ?? [];
      const phase = this.manualPhase(phases, phaseIndex);
      this.assertHandRound(phase, dto.round);
      const rounds = phaseRounds(phase);
      if (dto.round >= rounds) throw new BadRequestException(`El cuadro tiene ${rounds} rondas (la última es la final)`);
      if (dto.legs.length !== phase.legs) {
        throw new BadRequestException(phase.legs === 2 ? 'Cada cruce es de ida y vuelta: indica la fecha de los dos partidos' : 'Cada cruce es a partido único');
      }
      if (dto.homeTeamId === dto.awayTeamId) throw new BadRequestException('Un equipo no puede enfrentarse a sí mismo');
      for (const t of [dto.homeTeamId, dto.awayTeamId]) {
        if (!input.teamIds.includes(t)) throw new BadRequestException('Los dos equipos deben estar inscritos en el torneo');
      }
      const inRound = (phase.bracket ?? []).filter((t) => t.round === dto.round);
      const capacity = bracketSize(phase) / 2 ** (dto.round + 1);
      if (inRound.length >= capacity) throw new ConflictException(`${roundName(bracketSize(phase) / 2 ** dto.round)} ya tiene sus ${capacity} cruces`);
      const busy = new Set(inRound.flatMap((t) => [t.home, t.away]).map((src) => (src.type === 'TEAM' ? src.teamId : '')));
      if (busy.has(dto.homeTeamId) || busy.has(dto.awayTeamId)) throw new ConflictException('Ese equipo ya tiene cruce en esta ronda');
      const slot = Array.from({ length: capacity }, (_, k) => k).find((k) => !inRound.some((t) => t.slot === k))!;

      // La llave se cierra en casa de `home`: con ida y vuelta, el local de la ida es el `away`.
      const [closer, other] = phase.legs === 2 ? [dto.awayTeamId, dto.homeTeamId] : [dto.homeTeamId, dto.awayTeamId];
      const tie = { round: dto.round, slot, home: { type: 'TEAM' as const, teamId: closer }, away: { type: 'TEAM' as const, teamId: other } };
      const tid = toObjectId(id);
      const name = roundName(bracketSize(phase) / 2 ** dto.round);
      const docs = dto.legs.map((leg, l) => {
        const number = knockoutRoundNumber(phase, dto.round, l);
        const [h, a] = phase.legs === 2 && l === 0 ? [other, closer] : [closer, other];
        return {
          number,
          roundName: name + (phase.legs === 2 ? (l === 0 ? ' · ida' : ' · vuelta') : ''),
          match: matchDoc(tid, {
            round: number,
            homeTeamId: h,
            awayTeamId: a,
            date: leg.date,
            time: leg.time,
            venue: leg.venue?.trim() || null,
            stage: { phase: phase.index, group: null, tie: { round: dto.round, slot, leg: l } },
          }),
        };
      });
      if (docs.some((d) => d.number > 99)) throw new BadRequestException('La eliminatoria superaría la jornada 99');
      // Un equipo no juega dos partidos en la misma jornada (p. ej. un partido de liga pendiente).
      for (const d of docs) {
        const clash = await this.matches.exists({
          tournamentId: tid,
          round: d.number,
          status: { $ne: MatchStatus.CANCELLED },
          $or: [{ homeTeamId: { $in: [d.match.homeTeamId, d.match.awayTeamId] } }, { awayTeamId: { $in: [d.match.homeTeamId, d.match.awayTeamId] } }],
        }).session(session);
        if (clash) throw new ConflictException(`Uno de los equipos ya juega en la jornada ${d.number}`);
      }
      for (const d of docs) {
        await this.rounds.updateOne(
          { tournamentId: tid, number: d.number },
          { $setOnInsert: { tournamentId: tid, number: d.number, name: d.roundName, date: d.match.date } },
          { upsert: true, session },
        );
      }
      const inserted = await this.matches.insertMany(docs.map((d) => d.match), { session });
      // Cruce armado a mano: sus partidos se registran como creados por el organizador.
      await this.log.created(session, { userId: user.id }, inserted.map((m) => m.toObject()));
      const next = phases.map((p) => (p.index === phase.index ? { ...p, bracket: [...(p.bracket ?? []), tie] } : p));
      await this.tournaments.updateOne({ _id: tid }, { $set: { phases: next } }, { session });
    });
    return this.structure(id);
  }

  /** Quitar un cruce armado a mano (y sus partidos) mientras ninguno tenga resultado ni estadísticas. */
  async deleteTie(id: string, phaseIndex: number, round: number, slot: number, user: AuthUser) {
    await this.ownership.tournament(id, user, Permission.SCHEDULE);
    await this.ownership.inTournament(id, { user, permission: Permission.SCHEDULE }, async (session) => {
      const { tournament, matches } = await this.context(id, session);
      const phases = tournament.phases ?? [];
      const phase = this.manualPhase(phases, phaseIndex);
      this.assertHandRound(phase, round);
      if (!(phase.bracket ?? []).some((t) => t.round === round && t.slot === slot)) throw new NotFoundException('Ese cruce no existe');
      const legs = matches.filter((m) => m.stage?.phase === phase.index && m.stage.tie?.round === round && m.stage.tie.slot === slot);
      const played =
        legs.some((m) => m.status === MatchStatus.LIVE || m.status === MatchStatus.FINISHED || m.homeScore !== null || m.awayScore !== null) ||
        (legs.length > 0 && (await this.stats.exists({ matchId: { $in: legs.map((m) => toObjectId(m.id)) } }).session(session)));
      if (played) throw new ConflictException('Ese cruce ya tiene resultado: no se puede quitar');
      if (legs.length) {
        await this.log.deleting(session, { userId: user.id }, { _id: { $in: legs.map((m) => toObjectId(m.id)) } }, MatchLogCause.TIE_REMOVED);
        await this.matches.deleteMany({ _id: { $in: legs.map((m) => toObjectId(m.id)) } }, { session });
      }
      const next = phases.map((p) => (p.index === phase.index ? { ...p, bracket: (p.bracket ?? []).filter((t) => !(t.round === round && t.slot === slot)) } : p));
      await this.tournaments.updateOne({ _id: toObjectId(id) }, { $set: { phases: next } }, { session });
    });
    return this.structure(id);
  }

  /**
   * Lugar en la estructura de un partido programado a mano (jornadas del organizador). Se llama
   * dentro del cerrojo. Liga clásica: sin estructura. Fase
   * regular de liga + playoffs: cuenta en su tabla (la fase se crea con el primer partido). Grupos:
   * cuenta en el grupo de los dos equipos. Eliminación: los partidos se arman por cruces.
   */
  async manualStage(
    tournament: Pick<Tournament, 'settings' | 'phases' | 'dataCoverage'>,
    homeTeamId: string,
    awayTeamId: string,
  ): Promise<{ stage: MatchStage | null; createPhase: TournamentPhase | null }> {
    const s = { ...DEFAULT_SETTINGS, ...tournament.settings };
    if (s.system === CompetitionSystem.LEAGUE) return { stage: null, createPhase: null };
    const first = phasesOf(s.system)[0];
    if (first === PhaseType.KNOCKOUT) {
      throw new ConflictException('En eliminación directa los partidos se arman por cruces: agrégalos desde Competición');
    }
    const phases = tournament.phases ?? [];
    if (phases.some((p) => p.index > 0 && !p.manual)) {
      throw new ConflictException('La fase regular ya definió los clasificados de la eliminatoria: no admite partidos nuevos');
    }
    const stored = phases.find((p) => p.index === 0);
    if (first === PhaseType.LEAGUE) {
      return {
        stage: { phase: 0, group: null, tie: null },
        createPhase: stored ? null : { index: 0, type: PhaseType.LEAGUE, legs: s.roundRobinLegs },
      };
    }
    if (!stored?.groups?.length) throw new ConflictException('Primero arma los grupos (Calendario → Generar → Armar a mano)');
    const group = stored.groups.find((g) => g.teamIds.includes(homeTeamId));
    if (!group || !group.teamIds.includes(awayTeamId)) {
      throw new ConflictException('Esos equipos están en grupos distintos: un partido de la fase de grupos es entre equipos del mismo grupo');
    }
    return { stage: { phase: 0, group: group.key, tie: null }, createPhase: null };
  }

  /**
   * Tras escribir un partido de eliminatoria: el bracket se deriva de los resultados. Crea los
   * partidos de las llaves que ya tienen sus dos equipos, corrige los de llaves sin jugar cuyo
   * equipo cambió y rechaza (409) cambios que alterarían una llave ya jugada.
   */
  /**
   * `actor`: quien desencadenó el cambio (al capturar o editar). Lo que el cuadro borra o
   * reasigna queda en el historial con origen SYSTEM y causa BRACKET_SYNC.
   */
  async syncKnockout(tournamentId: Types.ObjectId, session: ClientSession, actor: Actor) {
    const { tournament, matches, input } = await this.context(tournamentId, session);
    const rules = tiebreakRules(input);
    for (const phase of tournament.phases ?? []) {
      if (phase.type !== PhaseType.KNOCKOUT) continue;
      const r = reconcile(phase, matches, rules);
      if (r.conflicts.length) {
        throw new ConflictException(`${r.conflicts[0]}. Corrige primero los resultados de las rondas siguientes.`);
      }
      if (r.remove.length) {
        await this.log.deleting(session, { ...actor, source: MatchLogSource.SYSTEM }, { _id: { $in: r.remove.map(toObjectId) } }, MatchLogCause.BRACKET_SYNC);
        await this.matches.deleteMany({ _id: { $in: r.remove.map(toObjectId) } }, { session });
      }
      for (const u of r.update) {
        const before = await this.matches.findById(toObjectId(u.matchId)).session(session).lean();
        await this.matches.updateOne(
          { _id: toObjectId(u.matchId) },
          { homeTeamId: toObjectId(u.homeTeamId), awayTeamId: toObjectId(u.awayTeamId) },
          { session },
        );
        if (before) {
          const after = { ...before, homeTeamId: toObjectId(u.homeTeamId), awayTeamId: toObjectId(u.awayTeamId) };
          await this.log.teamsBySystem(session, actor, before, after);
        }
      }
      if (r.create.length) {
        await this.matches.insertMany(r.create.map((spec) => matchDoc(tournamentId, knockoutMatch(phase, spec))), { session });
      }
    }
  }

  /**
   * Reglas para escribir un partido que forma parte de la estructura (con `stage`):
   * - sus equipos y su torneo los decide la estructura: no se cambian a mano;
   * - no se eliminan;
   * - una eliminatoria no se cancela (dejaría la llave sin ganador para siempre);
   * - los partidos de una fase ya cerrada (existe la siguiente) no cambian: definieron clasificados.
   */
  assertStageWrite(
    phases: TournamentPhase[],
    stage: MatchStage | null | undefined,
    change: { teams?: boolean; remove?: boolean; cancel?: boolean; resultOrStatus?: boolean },
  ) {
    if (!stage) return;
    // Una fase queda cerrada solo si la siguiente salió AUTOMÁTICAMENTE de su tabla (sus resultados
    // definieron clasificados). Si la eliminatoria se arma a mano, la fase anterior sigue abierta.
    const closed = phases.some((p) => p.index > stage.phase && !p.manual);
    if (stage.tie) {
      if (change.remove) throw new ConflictException('Los partidos de un cruce no se eliminan uno por uno: quita el cruce completo (si se armó a mano)');
      if (change.teams) throw new ConflictException('Los equipos de este partido los define su cruce del cuadro');
      if (change.cancel) {
        throw new ConflictException('Un partido de eliminatoria no se cancela: la llave quedaría sin ganador. Posponlo o reprográmalo.');
      }
    } else if ((change.remove || change.teams) && closed) {
      // Todos contra todos: el organizador arma sus jornadas como quiera mientras la fase siga abierta.
      throw new ConflictException('Esa fase ya terminó y definió los clasificados de la siguiente: sus partidos ya no cambian');
    }
    if (change.resultOrStatus && closed) {
      throw new ConflictException('Esa fase ya terminó y definió los clasificados de la siguiente: sus partidos ya no cambian');
    }
  }

  /**
   * Penales y tiempos extra de un partido de eliminatoria, según la regla de su ronda:
   * - Penales: solo en el partido que cierra una llave igualada en el global, y no si la llave la
   *   gana el mejor posicionado (BETTER_POSITION con posiciones distintas).
   * - Tiempos extra: solo en el partido que cierra la llave y si la regla de la ronda es EXTRA_TIME.
   */
  assertKnockoutExtras(
    input: StructureInput,
    phases: TournamentPhase[],
    matches: StagedMatch[],
    match: StagedMatch,
    next: { homeScore: number; awayScore: number; status: MatchStatus; penalties: { home: number; away: number } | null; extraTime: boolean },
  ) {
    if (!next.penalties && !next.extraTime) return;
    const tie = match.stage?.tie;
    const phase = tie ? phases.find((p) => p.index === match.stage!.phase) : undefined;
    if (!tie || !phase) throw new BadRequestException('Los penales de eliminatoria solo existen en partidos de eliminatoria');
    if (tie.leg !== phase.legs - 1) throw new BadRequestException('Penales y tiempos extra se capturan en el partido que cierra la llave (la vuelta)');
    if (next.status !== MatchStatus.FINISHED) throw new BadRequestException('Penales y tiempos extra solo se capturan con el partido finalizado');
    const rules = tiebreakRules(input);
    const rule = tiebreakFor(rules, tie.round, phaseRounds(phase));
    if (next.extraTime && rule !== KnockoutTiebreak.EXTRA_TIME) {
      throw new BadRequestException('En esta ronda no hay tiempos extra: la regla de desempate del torneo es otra');
    }
    if (!next.penalties) return;
    if (next.penalties.home === next.penalties.away) throw new BadRequestException('La tanda de penales no puede terminar empatada');
    const simulated = matches.map((m) =>
      m.id === match.id ? { ...m, homeScore: next.homeScore, awayScore: next.awayScore, status: next.status, penalties: null } : m,
    );
    const state = reconcile(phase, simulated, rules).ties.find((t) => t.round === tie.round && t.slot === tie.slot);
    if (!state?.aggregate || state.aggregate.home !== state.aggregate.away) {
      throw new BadRequestException('Solo hay penales si la llave termina igualada en el marcador global');
    }
    if (state.decidedBy === 'POSITION') {
      throw new BadRequestException('En esta ronda una llave igualada la gana el mejor posicionado de la fase regular: no hay penales');
    }
  }

  /**
   * Penales tras un empate de liga o grupos (punto extra al ganador): solo si el torneo lo tiene
   * configurado, con el partido finalizado, empatado y una tanda con ganador.
   */
  assertShootout(
    pointsForShootoutWin: number | null | undefined,
    next: { homeScore: number; awayScore: number; status: MatchStatus; penalties: { home: number; away: number } | null; extraTime: boolean },
  ) {
    if (next.extraTime) throw new BadRequestException('Los tiempos extra solo existen en eliminatorias');
    if (!next.penalties) return;
    if (!pointsForShootoutWin) throw new BadRequestException('Este torneo no define los empates en penales');
    if (next.status !== MatchStatus.FINISHED) throw new BadRequestException('Los penales solo se capturan con el partido finalizado');
    if (next.homeScore !== next.awayScore) throw new BadRequestException('Solo hay penales si el partido termina empatado');
    if (next.penalties.home === next.penalties.away) throw new BadRequestException('La tanda de penales no puede terminar empatada');
  }

  /** Los formatos con eliminatoria requieren un campeón antes de finalizar. */
  async finishBlockers(tournamentId: Types.ObjectId, session: ClientSession): Promise<string[]> {
    const { input } = await this.context(tournamentId, session);
    if (input.system === CompetitionSystem.LEAGUE) return [];
    const view = buildStructure(input);
    if (view.championTeamId) return [];
    if (view.next) return [`Falta generar la eliminatoria. ${view.next.blockers.join('. ')}`.trim()];
    return ['La final aún no tiene ganador'];
  }
}

/** Añade los desempates recibidos a la última fase guardada (queda registrado quién decidió qué). */
function mergeTiebreaks(phases: TournamentPhase[], tiebreaks: TiebreakDecision[]) {
  if (!tiebreaks.length || !phases.length) return phases;
  const last = phases[phases.length - 1];
  const kept = (last.tiebreaks ?? []).filter((t) => !tiebreaks.some((n) => n.scope === t.scope && sameSet(n.order, t.order)));
  return [...phases.slice(0, -1), { ...last, tiebreaks: [...kept, ...tiebreaks] }];
}

const sameSet = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

/** Eliminatoria automática con los clasificados (o 409 con lo que falta). Compartido por advance y su vista previa. */
function planNextKnockout(view: ReturnType<typeof buildStructure>, settings: Partial<typeof DEFAULT_SETTINGS> | undefined, dto: AdvancePhaseDto, roundBase: number) {
  if (!view.next?.ready) {
    const blockers = view.next?.blockers ?? [];
    throw new ConflictException({ statusCode: 409, error: 'Conflict', message: blockers.join('. '), blockers });
  }
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const plan = planKnockout(view.next.index, view.next.seeds!, s.knockoutLegs, {
    startDate: dto.startDate,
    daysBetweenRounds: dto.daysBetweenRounds,
    firstKickoff: dto.firstKickoff,
    minutesBetweenMatches: dto.minutesBetweenMatches,
    venue: dto.venue?.trim() || null,
  }, roundBase, s.reseed ?? false);
  if (roundBase + plan.rounds.length - 1 > 99) throw new BadRequestException('La eliminatoria superaría la jornada 99');
  return plan;
}
