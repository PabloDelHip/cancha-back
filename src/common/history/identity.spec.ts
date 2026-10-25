import { Types } from 'mongoose';
import { namesOf, playerMapWithNames, teamInWith, teamMapWithNames, withPlayerName, withTeamName } from './identity.js';

const A = new Types.ObjectId();
const P = new Types.ObjectId();
const identity = {
  takenAt: new Date('2026-10-24T12:00:00Z'),
  leagueName: 'Liga Norte',
  teams: [{ teamId: A, name: 'Halcones', shortName: 'HAL', logoUrl: 'https://x/l.png', colors: { primary: '#000', secondary: '#fff' } }],
  players: [{ playerId: P, firstName: 'José', lastName: 'Núñez', nickname: 'Pepe' }],
  corrections: [],
};

describe('nombres históricos (10C)', () => {
  it('sin foto no cambia nada', () => {
    expect(namesOf(null)).toBeNull();
    const team = { id: A.toHexString(), name: 'Halcones FC', shortName: 'HFC' };
    expect(withTeamName(team, A.toHexString(), null)).toBe(team);
  });

  it('sobrepone nombre, abreviatura, escudo y colores solo en los campos que el objeto ya tiene', () => {
    const n = namesOf(identity)!;
    const ref = { id: A.toHexString(), name: 'Halcones FC', shortName: 'HFC', logoUrl: null, colors: { primary: '#f00', secondary: '#0f0' }, city: 'Cancún' };
    expect(withTeamName(ref, A.toHexString(), n)).toEqual({ ...ref, name: 'Halcones', shortName: 'HAL', logoUrl: 'https://x/l.png', colors: { primary: '#000', secondary: '#fff' } });
    // Solo el nombre (reportes): no aparecen campos nuevos.
    expect(withTeamName({ name: 'Halcones FC' }, A.toHexString(), n)).toEqual({ name: 'Halcones' });
    // Un equipo que no está en la foto conserva su nombre actual.
    expect(withTeamName({ name: 'Otro' }, new Types.ObjectId().toHexString(), n)).toEqual({ name: 'Otro' });
  });

  it('jugadores: nombre deportivo; los demás campos (edad, foto) quedan como están', () => {
    const n = namesOf(identity)!;
    const p = { id: P.toHexString(), firstName: 'Josué', lastName: 'Nunez', nickname: null, age: 15, photoUrl: 'f.png' };
    expect(withPlayerName(p, P.toHexString(), n)).toEqual({ ...p, firstName: 'José', lastName: 'Núñez', nickname: 'Pepe' });
    expect(withPlayerName({ firstName: 'A', lastName: 'B' }, P.toHexString(), n)).toEqual({ firstName: 'José', lastName: 'Núñez' });
  });

  it('mapas y equipo por torneo: cada temporada con su foto', () => {
    const n = namesOf(identity)!;
    const teams = new Map([[A.toHexString(), { name: 'Halcones FC' }]]);
    expect(teamMapWithNames(teams, n).get(A.toHexString())).toEqual({ name: 'Halcones' });
    expect(teamMapWithNames(teams, null)).toBe(teams);
    expect(playerMapWithNames(new Map([[P.toHexString(), { firstName: 'X', lastName: 'Y' }]]), n).get(P.toHexString())).toEqual({ firstName: 'José', lastName: 'Núñez' });
    const teamIn = teamInWith(teams, new Map([['t1', n]]));
    expect(teamIn('t1', A.toHexString())).toEqual({ name: 'Halcones' });
    expect(teamIn('t2', A.toHexString())).toEqual({ name: 'Halcones FC' });
    expect(teamIn('t1', 'nope')).toBeNull();
  });
});
