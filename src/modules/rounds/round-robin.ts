/**
 * Liga todos contra todos (método del círculo). Portado de front/src/utils/schedule.ts
 * (mismas reglas, verificado para 2–12 equipos):
 * - cada pareja se enfrenta exactamente una vez por vuelta;
 * - nadie juega dos veces en una jornada;
 * - con número impar de equipos, cada jornada descansa uno (`bye`);
 * - la segunda vuelta repite los cruces con la localía invertida.
 *
 * Localías: con número par cada equipo juega n−1 partidos (impar), así que la diferencia
 * local/visitante es 1 por vuelta, el mínimo posible. Con número impar el "descanso" ocupa
 * la posición fija del círculo: así cada equipo alterna local/visitante jornada a jornada y
 * termina cada vuelta con exactamente tantos partidos de local como de visitante.
 */
export type Legs = 1 | 2;

export interface GeneratedRound {
  number: number;
  pairs: [home: string, away: string][];
  bye: string | null;
}

export function generateRoundRobin(teamIds: string[], legs: Legs): GeneratedRound[] {
  if (teamIds.length < 2) return [];
  const slots: (string | null)[] = [...teamIds];
  // Impar: el descanso es el elemento fijo (ver "Localías").
  if (slots.length % 2) slots.unshift(null);
  const n = slots.length;
  const firstLeg: GeneratedRound[] = [];

  for (let r = 0; r < n - 1; r++) {
    const pairs: [string, string][] = [];
    let bye: string | null = null;
    for (let i = 0; i < n / 2; i++) {
      const a = slots[i];
      const b = slots[n - 1 - i];
      if (a === null || b === null) {
        bye = a ?? b;
        continue;
      }
      // El fijo (índice 0) alterna localía por jornada; el resto, según su posición.
      const flip = i === 0 ? r % 2 === 1 : i % 2 === 1;
      pairs.push(flip ? [b, a] : [a, b]);
    }
    firstLeg.push({ number: r + 1, pairs, bye });
    slots.splice(1, 0, slots.pop()!);
  }

  if (legs === 1) return firstLeg;
  return [
    ...firstLeg,
    ...firstLeg.map((round) => ({
      number: round.number + firstLeg.length,
      pairs: round.pairs.map(([h, a]) => [a, h] as [string, string]),
      bye: round.bye,
    })),
  ];
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
