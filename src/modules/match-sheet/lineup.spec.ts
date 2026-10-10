import { describe, expect, it } from 'vitest';
import { checkLineup, participationMismatch, type LineupPlayer } from './lineup.js';

const p = (playerId: string, starter: boolean, extra: Partial<LineupPlayer> = {}): LineupPlayer => ({ playerId, jerseyNumber: null, starter, captain: false, ...extra });
const base = [p('a', true, { jerseyNumber: 1, captain: true }), p('b', true, { jerseyNumber: 2 }), p('c', false, { jerseyNumber: 3 }), p('d', false, { jerseyNumber: 4 })];

describe('alineación', () => {
  it('válida: titulares participan; el suplente que entró también; el que nunca entró no', () => {
    const { errors, participation } = checkLineup(base, [{ outPlayerId: 'b', inPlayerId: 'c', minute: 30 }]);
    expect(errors).toEqual([]);
    expect([...participation.participants].sort()).toEqual(['a', 'b', 'c']);
    expect(participation.entered.get('c')).toBe(30);
    expect(participation.left.get('b')).toBe(30);
    expect(participation.participants.has('d')).toBe(false);
  });

  it('duplicados, dorsal repetido y dos capitanes', () => {
    const { errors } = checkLineup([...base, p('a', false), p('e', false, { jerseyNumber: 2, captain: true })], []);
    expect(errors).toEqual(['El jugador a aparece dos veces en la alineación', 'El dorsal 2 está repetido', 'Solo puede haber un capitán por equipo']);
  });

  it('sustituciones inconsistentes: sale quien no está, entra quien ya está, mismo jugador, ajeno a la alineación', () => {
    const errors = (subs: { outPlayerId: string; inPlayerId: string; minute: number }[]) => checkLineup(base, subs).errors;
    expect(errors([{ outPlayerId: 'c', inPlayerId: 'd', minute: 10 }])[0]).toMatch(/no está en la cancha/);
    expect(errors([{ outPlayerId: 'a', inPlayerId: 'b', minute: 10 }])[0]).toMatch(/ya está en la cancha/);
    expect(errors([{ outPlayerId: 'a', inPlayerId: 'a', minute: 10 }])[0]).toMatch(/mismo jugador/);
    expect(errors([{ outPlayerId: 'a', inPlayerId: 'zz', minute: 10 }])[0]).toMatch(/en la alineación/);
    // Entrar dos veces sin haber salido.
    expect(errors([{ outPlayerId: 'a', inPlayerId: 'c', minute: 10 }, { outPlayerId: 'b', inPlayerId: 'c', minute: 20 }])[0]).toMatch(/ya está en la cancha/);
  });

  it('orden por minuto (no por captura) y reingreso permitido tras salir; sin límite universal de cambios', () => {
    const subs = [
      { outPlayerId: 'c', inPlayerId: 'a', minute: 40 },
      { outPlayerId: 'a', inPlayerId: 'c', minute: 20 },
      { outPlayerId: 'b', inPlayerId: 'd', minute: 25 },
      { outPlayerId: 'd', inPlayerId: 'b', minute: 30 },
      { outPlayerId: 'b', inPlayerId: 'd', minute: 35 },
    ];
    const { errors, participation } = checkLineup(base, subs);
    expect(errors).toEqual([]);
    expect(participation.entered.get('c')).toBe(20);
    expect(participation.left.get('a')).toBe(20);
    expect([...participation.participants].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('coherencia con las estadísticas: faltantes y sobrantes', () => {
    expect(participationMismatch(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'd']))).toEqual({ missing: ['c'], extra: ['d'] });
    expect(participationMismatch(new Set(['a']), new Set(['a']))).toEqual({ missing: [], extra: [] });
  });
});
