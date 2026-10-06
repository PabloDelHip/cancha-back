/**
 * Eliminación directa. Funciones puras.
 *
 * Estructura: un cuadro de tamaño S = siguiente potencia de 2 ≥ equipos. Las cabezas de serie se
 * colocan con el orden estándar (1 vs S, luego los cruces que mantienen a 1 y 2 en mitades
 * opuestas): con 8 → 1-8, 4-5, 2-7, 3-6; con 4 → 1-4, 2-3. Si no es potencia de 2, las mejores
 * cabezas de serie pasan de ronda sin jugar (BYE): nunca se inventan equipos. Como S/2 < equipos,
 * ninguna llave queda con dos BYEs.
 *
 * Resultado: el bracket guarda solo la ESTRUCTURA (de dónde viene cada lado). Quién juega cada llave
 * y quién pasa se DERIVAN de los partidos con `reconcile`, así que ningún ganador guardado puede
 * contradecir un resultado.
 *
 * Decisión de una llave: marcador (partido único) o global (ida y vuelta). Si queda igualada, decide
 * la tanda de penales capturada en el partido que la cierra; sin ella la llave queda pendiente
 * (NEEDS_PENALTIES) y no avanza: nunca se elige un clasificado arbitrariamente. No hay regla de
 * gol de visitante.
 *
 * Localía: el lado `home` de la llave es la mejor cabeza de serie (o el ganador de la llave de
 * arriba) y juega en casa el partido que cierra la llave: partido único en su casa; ida y vuelta →
 * ida en casa del otro, vuelta en la suya.
 */
import { KnockoutTiebreak, MatchStatus } from '../../common/enums/index.js';
import type { StagedMatch } from './tables.js';
import type { BracketTie, KnockoutSeed, SlotSource, TournamentPhase } from './types.js';

export function nextPowerOfTwo(n: number) {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

/** Orden estándar de cabezas de serie en un cuadro de `size` (potencia de 2). */
export function bracketOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

/** Nombre de una ronda por cuántos equipos la disputan. */
export function roundName(teamsInRound: number): string {
  const names: Record<number, string> = {
    2: 'Final',
    4: 'Semifinal',
    8: 'Cuartos de final',
    16: 'Octavos de final',
    32: 'Dieciseisavos de final',
    64: 'Treintaidosavos de final',
  };
  return names[teamsInRound] ?? `Ronda de ${teamsInRound}`;
}

/**
 * Cuadro de `seedCount` equipos. Primera ronda en orden estándar (1-8, 4-5, 2-7, 3-6…). Después:
 * fijo (el ganador de cada par de llaves se cruza, como en el Mundial) o, con `reseed`, nada: el
 * organizador arma a mano los cruces de cada ronda siguiente (reacomodo).
 */
export function buildBracket(seedCount: number, reseed = false): BracketTie[] {
  const size = nextPowerOfTwo(seedCount);
  const order = bracketOrder(size);
  const ties: BracketTie[] = [];
  for (let i = 0; i < size / 2; i++) {
    ties.push({ round: 0, slot: i, home: { type: 'SEED', seed: order[2 * i] }, away: { type: 'SEED', seed: order[2 * i + 1] } });
  }
  for (let r = 1, inRound = size / 4; inRound >= 1; r++, inRound /= 2) {
    for (let i = 0; i < inRound; i++) {
      if (!reseed) ties.push({ round: r, slot: i, home: { type: 'WINNER', round: r - 1, slot: 2 * i }, away: { type: 'WINNER', round: r - 1, slot: 2 * i + 1 } });
    }
  }
  return ties;
}

export const roundsOf = (bracket: BracketTie[]) => Math.max(...bracket.map((t) => t.round)) + 1;

/** Equipos de la primera ronda del cuadro. */
export const bracketSize = (phase: Pick<TournamentPhase, 'manual' | 'size' | 'seeds'>) =>
  phase.manual ? (phase.size ?? 2) : nextPowerOfTwo(phase.seeds?.length ?? 2);

/**
 * Rondas del cuadro. A mano se conocen por el tamaño aunque aún no tengan cruces (la final es
 * siempre la última): nunca se toma como final una ronda anterior solo porque es la última creada.
 */
export const phaseRounds = (phase: TournamentPhase) =>
  phase.manual || phase.reseed ? Math.log2(bracketSize(phase)) : (phase.bracket?.length ? roundsOf(phase.bracket) : 0);

/** Match.round de la ronda `round`, partido `leg` (ida 0, vuelta 1). */
export const knockoutRoundNumber = (phase: TournamentPhase, round: number, leg: number) =>
  (phase.roundBase ?? 1) + round * phase.legs + leg;

export interface LegState {
  leg: number;
  matchId: string | null;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  status: MatchStatus | null;
  penalties: { home: number; away: number } | null;
  extraTime: boolean;
  date: string | null;
  time: string | null;
}

export type TieStatus = 'WAITING' | 'READY' | 'PLAYING' | 'NEEDS_PENALTIES' | 'DECIDED';

/**
 * Cómo se decide una llave igualada (por ronda: la final puede tener su propia regla) y, para
 * BETTER_POSITION, la posición de cada equipo en la fase regular (1 = mejor).
 */
export interface TiebreakRules {
  tiebreak: KnockoutTiebreak;
  finalTiebreak: KnockoutTiebreak | null;
  rank?: Map<string, number>;
}
const DEFAULT_RULES: TiebreakRules = { tiebreak: KnockoutTiebreak.PENALTIES, finalTiebreak: null };

/** Regla que aplica a la ronda `round` de una fase con `rounds` rondas (la última es la final). */
export const tiebreakFor = (rules: TiebreakRules, round: number, rounds: number) =>
  round === rounds - 1 && rules.finalTiebreak ? rules.finalTiebreak : rules.tiebreak;

export interface TieState {
  round: number;
  slot: number;
  homeSource: SlotSource;
  awaySource: SlotSource;
  homeTeamId: string | null;
  awayTeamId: string | null;
  bye: boolean;
  legs: LegState[];
  /** Goles globales de cada lado de la llave. */
  aggregate: { home: number; away: number } | null;
  /** Regla de desempate de esta ronda. */
  tiebreak: KnockoutTiebreak;
  winnerTeamId: string | null;
  decidedBy: 'BYE' | 'SCORE' | 'PENALTIES' | 'POSITION' | null;
  status: TieStatus;
}

export interface LegSpec {
  round: number;
  slot: number;
  leg: number;
  homeTeamId: string;
  awayTeamId: string;
}

export interface ReconcileResult {
  ties: TieState[];
  championTeamId: string | null;
  /** La final está decidida. */
  complete: boolean;
  create: LegSpec[];
  update: { matchId: string; homeTeamId: string; awayTeamId: string }[];
  remove: string[];
  /** Cambios imposibles: una llave ya jugada tendría que cambiar de equipos. */
  conflicts: string[];
}

const hasResult = (m: StagedMatch) =>
  m.status === MatchStatus.LIVE || m.status === MatchStatus.FINISHED || m.homeScore !== null || m.awayScore !== null;
const isFinished = (m: StagedMatch) => m.status === MatchStatus.FINISHED && m.homeScore !== null && m.awayScore !== null;

export function seedMap(seeds: KnockoutSeed[] = []) {
  return new Map(seeds.map((s) => [s.seed, s]));
}

export function reconcile(phase: TournamentPhase, matches: StagedMatch[], rules: TiebreakRules = DEFAULT_RULES): ReconcileResult {
  const bracket = phase.bracket ?? [];
  const seeds = seedMap(phase.seeds);
  const legs = phase.legs;
  const byKey = new Map<string, StagedMatch>();
  for (const m of matches) {
    if (m.stage?.phase === phase.index && m.stage.tie) byKey.set(`${m.stage.tie.round}-${m.stage.tie.slot}-${m.stage.tie.leg}`, m);
  }
  const winners = new Map<string, string | null>();
  const out: ReconcileResult = { ties: [], championTeamId: null, complete: false, create: [], update: [], remove: [], conflicts: [] };
  const rounds = phaseRounds(phase);

  const side = (src: SlotSource): string | 'BYE' | null =>
    src.type === 'TEAM'
      ? src.teamId
      : src.type === 'SEED'
        ? (seeds.get(src.seed)?.teamId ?? 'BYE')
        : (winners.get(`${src.round}-${src.slot}`) ?? null);

  for (let r = 0; r < rounds; r++) {
    for (const tie of bracket.filter((t) => t.round === r).sort((a, b) => a.slot - b.slot)) {
      const home = side(tie.home);
      const away = side(tie.away);
      const existing = Array.from({ length: legs }, (_, l) => byKey.get(`${r}-${tie.slot}-${l}`));
      const state: TieState = {
        round: r,
        slot: tie.slot,
        homeSource: tie.home,
        awaySource: tie.away,
        homeTeamId: home === 'BYE' ? null : home,
        awayTeamId: away === 'BYE' ? null : away,
        bye: home === 'BYE' || away === 'BYE',
        legs: [],
        aggregate: null,
        tiebreak: tiebreakFor(rules, r, rounds),
        winnerTeamId: null,
        decidedBy: null,
        status: 'WAITING',
      };
      const where = `${r + 1}ª ronda, llave ${tie.slot + 1}`;

      if (state.bye || !home || !away) {
        // Llave sin partido posible (BYE) o con un lado aún por decidir: no debe tener partidos.
        for (const m of existing) {
          if (!m) continue;
          if (hasResult(m)) out.conflicts.push(`La llave (${where}) ya se jugó y cambiaría de equipos`);
          else out.remove.push(m.id);
        }
        if (state.bye) {
          const passer = home === 'BYE' ? away : home;
          if (passer && passer !== 'BYE') {
            state.winnerTeamId = passer;
            state.decidedBy = 'BYE';
            state.status = 'DECIDED';
          }
        }
      } else {
        const oriented = existing.map((m, l) => {
          // La llave se cierra en casa de `home`: partido único en su casa; ida y vuelta → vuelta.
          const [h, a] = legs === 2 && l === 0 ? [away, home] : [home, away];
          if (!m) {
            // A mano (o en las rondas de reacomodo), el organizador crea los partidos junto con el cruce.
            if (!phase.manual && tie.home.type !== 'TEAM') out.create.push({ round: r, slot: tie.slot, leg: l, homeTeamId: h, awayTeamId: a });
          } else if (m.homeTeamId !== h || m.awayTeamId !== a) {
            if (hasResult(m)) out.conflicts.push(`La llave (${where}) ya se jugó y cambiaría de equipos`);
            else out.update.push({ matchId: m.id, homeTeamId: h, awayTeamId: a });
          }
          const same = m && m.homeTeamId === h && m.awayTeamId === a;
          const leg: LegState = {
            leg: l,
            matchId: m?.id ?? null,
            homeTeamId: h,
            awayTeamId: a,
            homeScore: same ? m.homeScore : null,
            awayScore: same ? m.awayScore : null,
            status: same ? m.status : null,
            penalties: same ? m.penalties : null,
            extraTime: same ? (m.extraTime ?? false) : false,
            date: m?.date ?? null,
            time: m?.time ?? null,
          };
          return { leg, match: same ? m : undefined };
        });
        state.legs = oriented.map((o) => o.leg);
        const played = oriented.filter((o) => o.match && isFinished(o.match));
        if (played.length === legs) {
          const goalsOf = (team: string) =>
            oriented.reduce((sum, { leg }) => sum + (leg.homeTeamId === team ? leg.homeScore! : leg.awayScore!), 0);
          state.aggregate = { home: goalsOf(home), away: goalsOf(away) };
          if (state.aggregate.home !== state.aggregate.away) {
            state.winnerTeamId = state.aggregate.home > state.aggregate.away ? home : away;
            state.decidedBy = 'SCORE';
          } else if (state.tiebreak === KnockoutTiebreak.BETTER_POSITION && betterOf(rules.rank, home, away)) {
            // Igualada: pasa el mejor posicionado de la fase regular (sin penales).
            state.winnerTeamId = betterOf(rules.rank, home, away);
            state.decidedBy = 'POSITION';
          } else {
            const last = oriented[legs - 1].leg;
            if (last.penalties && last.penalties.home !== last.penalties.away) {
              state.winnerTeamId = last.penalties.home > last.penalties.away ? last.homeTeamId : last.awayTeamId;
              state.decidedBy = 'PENALTIES';
            }
          }
          state.status = state.winnerTeamId ? 'DECIDED' : 'NEEDS_PENALTIES';
        } else {
          state.status = oriented.some((o) => o.match && hasResult(o.match)) ? 'PLAYING' : 'READY';
        }
      }
      winners.set(`${r}-${tie.slot}`, state.winnerTeamId);
      out.ties.push(state);
    }
  }
  const final = out.ties.find((t) => t.round === rounds - 1 && t.slot === 0);
  out.championTeamId = final?.winnerTeamId ?? null;
  out.complete = out.championTeamId !== null;
  return out;
}

/** El mejor posicionado de los dos (null si falta la posición de alguno o empatan en ella). */
function betterOf(rank: Map<string, number> | undefined, a: string, b: string): string | null {
  const ra = rank?.get(a);
  const rb = rank?.get(b);
  if (ra === undefined || rb === undefined || ra === rb) return null;
  return ra < rb ? a : b;
}
