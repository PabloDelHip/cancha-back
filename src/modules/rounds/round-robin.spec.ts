import { addDays, addMinutes, generateRoundRobin } from './round-robin.js';

const teams = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

describe('generateRoundRobin (liga todos contra todos)', () => {
  for (let n = 2; n <= 12; n++) {
    for (const legs of [1, 2] as const) {
      it(`${n} equipos, ${legs === 1 ? 'una vuelta' : 'ida y vuelta'}`, () => {
        const ids = teams(n);
        const rounds = generateRoundRobin(ids, legs);
        const perLeg = n % 2 ? n : n - 1;
        expect(rounds).toHaveLength(perLeg * legs);
        expect(rounds.map((r) => r.number)).toEqual(rounds.map((_, i) => i + 1));

        const meetings = new Map<string, string[]>(); // pareja → locales
        for (const round of rounds) {
          const playing = round.pairs.flat();
          // nadie juega dos veces en la jornada y nadie juega contra sí mismo
          expect(new Set(playing).size).toBe(playing.length);
          for (const [h, a] of round.pairs) expect(h).not.toBe(a);
          // con impar descansa exactamente uno; con par nadie
          if (n % 2) {
            expect(round.bye).not.toBeNull();
            expect(playing).not.toContain(round.bye);
            expect(playing.length).toBe(n - 1);
          } else {
            expect(round.bye).toBeNull();
            expect(playing.length).toBe(n);
          }
          for (const [h, a] of round.pairs) {
            const key = [h, a].sort().join('-');
            meetings.set(key, [...(meetings.get(key) ?? []), h]);
          }
        }
        // cada pareja se enfrenta exactamente una vez por vuelta
        expect(meetings.size).toBe((n * (n - 1)) / 2);
        for (const homes of meetings.values()) {
          expect(homes).toHaveLength(legs);
          // ida y vuelta: localía invertida
          if (legs === 2) expect(homes[0]).not.toBe(homes[1]);
        }
        // con impar, cada equipo descansa exactamente una vez por vuelta
        if (n % 2) {
          const byes = rounds.map((r) => r.bye);
          for (const id of ids) expect(byes.filter((b) => b === id)).toHaveLength(legs);
        }
        // localías: por vuelta, |local − visitante| ≤ 1 con par (n−1 partidos, impar) y = 0
        // con impar; ida y vuelta siempre equilibrada
        const firstLeg = rounds.slice(0, perLeg);
        for (const id of ids) {
          const balance = (list: typeof rounds) =>
            list.flatMap((r) => r.pairs).reduce((sum, [h, a]) => sum + (h === id ? 1 : a === id ? -1 : 0), 0);
          expect(Math.abs(balance(firstLeg))).toBe(n % 2 ? 0 : 1);
          if (legs === 2) expect(balance(rounds)).toBe(0);
        }
        // determinista: mismas entradas, mismo calendario
        expect(generateRoundRobin(ids, legs)).toEqual(rounds);
      });
    }
  }

  it('segunda vuelta = primera con localías invertidas, en el mismo orden', () => {
    const rounds = generateRoundRobin(teams(4), 2);
    for (let i = 0; i < 3; i++) {
      expect(rounds[i + 3].pairs).toEqual(rounds[i].pairs.map(([h, a]) => [a, h]));
    }
  });

  it('con impar, cada equipo alterna local/visitante jornada a jornada', () => {
    for (const n of [3, 5, 7, 9, 11]) {
      const ids = teams(n);
      const rounds = generateRoundRobin(ids, 1);
      for (const id of ids) {
        const sides = rounds
          .map((r) => r.pairs.find((p) => p.includes(id)))
          .filter((p) => p !== undefined)
          .map(([h]) => (h === id ? 'H' : 'A'))
          .join('');
        expect(sides).not.toMatch(/HH|AA/);
      }
    }
  });

  it('menos de 2 equipos → sin jornadas', () => {
    expect(generateRoundRobin([], 1)).toEqual([]);
    expect(generateRoundRobin(['t1'], 2)).toEqual([]);
  });

  it('fechas y horas', () => {
    expect(addDays('2027-02-25', 7)).toBe('2027-03-04');
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(addMinutes('18:00', 90)).toBe('19:30');
    expect(addMinutes('23:30', 60)).toBe('00:30');
  });
});
