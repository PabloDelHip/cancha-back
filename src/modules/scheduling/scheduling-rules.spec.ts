import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  assertTeamRules,
  assertTournamentRules,
  DEFAULT_TEAM_RULES,
  DEFAULT_TOURNAMENT_RULES,
  evaluate,
  rulesOf,
  teamRulesOf,
  timeZoneOf,
  type Booked,
  type EvaluationContext,
  type Proposal,
  type TeamRules,
  type TournamentRules,
} from './scheduling-rules.js';
import { todayISODate } from '../../common/utils/dates.js';

const T = 'T1';
const A = 'A';
const B = 'B';
const C = 'C';
const D = 'D';
// 2027-01-10 es domingo; 2027-01-09, sábado.
const SUN = '2027-01-10';
const SAT = '2027-01-09';

function ctx(over: Partial<EvaluationContext> & { rules?: Partial<TournamentRules>; teams?: Record<string, Partial<TeamRules>> } = {}): EvaluationContext {
  const { rules, teams, ...rest } = over;
  return {
    tournamentId: T,
    duration: 60,
    rules: { ...DEFAULT_TOURNAMENT_RULES, ...rules },
    teamRules: new Map(Object.entries(teams ?? {}).map(([id, r]) => [id, { ...DEFAULT_TEAM_RULES, ...r }])),
    teamNames: new Map([[A, 'Tigres'], [B, 'Chivas'], [C, 'Leones'], [D, 'Halcones']]),
    tournamentMatches: [],
    otherFieldMatches: [],
    fields: new Map(),
    ...rest,
  };
}
const proposal = (date: string, time: string, extra: Partial<Proposal> = {}): Proposal => ({ key: 'p', matchId: null, homeTeamId: A, awayTeamId: B, date, time, fieldId: null, ...extra });
const booked = (id: string, date: string, time: string, extra: Partial<Booked> = {}): Booked => ({ id, tournamentId: T, homeTeamId: C, awayTeamId: D, date, time, fieldId: null, duration: 60, ...extra });
const one = (p: Proposal, c: EvaluationContext) => evaluate([p], c).get(p.key)!;
const codes = (p: Proposal, c: EvaluationContext) => {
  const e = one(p, c);
  return { errors: e.errors.map((v) => v.code), warnings: e.warnings.map((v) => v.code), valid: e.valid };
};

describe('6A — sin restricciones', () => {
  it('un torneo sin configurar acepta cualquier día y hora', () => {
    expect(codes(proposal(SUN, '03:00'), ctx())).toEqual({ errors: [], warnings: [], valid: true });
    expect(rulesOf({})).toEqual(DEFAULT_TOURNAMENT_RULES);
    expect(rulesOf({ scheduling: null })).toEqual(DEFAULT_TOURNAMENT_RULES);
    expect(teamRulesOf({ scheduling: null })).toEqual(DEFAULT_TEAM_RULES);
  });
});

describe('6A — días y horario del torneo', () => {
  const rules = { days: [6], startTime: '08:00', endTime: '22:00' };
  it('día permitido y prohibido', () => {
    expect(codes(proposal(SAT, '10:00'), ctx({ rules })).valid).toBe(true);
    const e = one(proposal(SUN, '10:00'), ctx({ rules }));
    expect(e.errors.map((v) => v.code)).toEqual(['DAY_NOT_ALLOWED']);
    expect(e.errors[0]).toMatchObject({ scope: 'TOURNAMENT', severity: 'ERROR' });
    expect(e.errors[0].message).toContain('domingo');
  });

  it('el partido completo cabe en el horario (inicio y fin)', () => {
    expect(codes(proposal(SAT, '07:59'), ctx({ rules })).errors).toEqual(['OUTSIDE_HOURS']);
    expect(codes(proposal(SAT, '08:00'), ctx({ rules })).valid).toBe(true);
    expect(codes(proposal(SAT, '21:00'), ctx({ rules })).valid).toBe(true); // termina 22:00 justo
    expect(codes(proposal(SAT, '21:01'), ctx({ rules })).errors).toEqual(['OUTSIDE_HOURS']);
    // La duración del torneo cuenta: con 90 min ya no cabe a las 21:00.
    expect(codes(proposal(SAT, '21:00'), ctx({ rules, duration: 90 })).errors).toEqual(['OUTSIDE_HOURS']);
  });

  it('cruce de medianoche: hasta 24:00 no admite un partido que termina al día siguiente', () => {
    const late = { endTime: '24:00' };
    expect(codes(proposal(SAT, '23:00'), ctx({ rules: late })).valid).toBe(true);
    const e = one(proposal(SAT, '23:30'), ctx({ rules: late }));
    expect(e.errors.map((v) => v.code)).toEqual(['OUTSIDE_HOURS']);
    expect(e.errors[0].message).toContain('00:30 del día siguiente');
    // Solo con inicio no hay tope: puede terminar después de medianoche.
    expect(codes(proposal(SAT, '23:30'), ctx({ rules: { startTime: '18:00' } })).valid).toBe(true);
  });
});

describe('6A — límites del torneo', () => {
  it('máximo de partidos por día (cuenta también las demás propuestas)', () => {
    const c = ctx({ rules: { maxMatchesPerDay: 2 }, tournamentMatches: [booked('m1', SAT, '10:00'), booked('m2', SAT, '12:00'), booked('m3', SUN, '10:00')] });
    const e = one(proposal(SAT, '16:00'), c);
    expect(e.errors.map((v) => v.code)).toEqual(['TOURNAMENT_DAILY_LIMIT']);
    expect(e.errors[0].relatedMatchIds.sort()).toEqual(['m1', 'm2']);
    expect(codes(proposal(SUN, '16:00'), c).valid).toBe(true);
    // Un calendario de 3 partidos en el mismo día con máximo 2: los tres incumplen.
    const plan = [proposal(SUN, '10:00', { key: '0' }), proposal(SUN, '12:00', { key: '1', homeTeamId: C, awayTeamId: D }), proposal(SUN, '14:00', { key: '2', homeTeamId: A, awayTeamId: C })];
    const r = evaluate(plan, ctx({ rules: { maxMatchesPerDay: 2 } }));
    expect([...r.values()].every((x) => x.errors[0]?.code === 'TOURNAMENT_DAILY_LIMIT')).toBe(true);
  });

  it('máximo de partidos simultáneos (solapes reales, no los consecutivos)', () => {
    const c = ctx({ rules: { maxSimultaneous: 2 }, tournamentMatches: [booked('m1', SAT, '10:00'), booked('m2', SAT, '10:30')] });
    expect(codes(proposal(SAT, '10:45'), c).errors).toEqual(['SIMULTANEOUS_LIMIT']);
    // m1 terminó a las 11:00: a las 11:00 solo sigue m2.
    expect(codes(proposal(SAT, '11:00'), c).valid).toBe(true);
    // Escalonados: 09:30 se solapa con m1 y con m2 pero nunca hay 3 a la vez.
    expect(codes(proposal(SAT, '09:15'), c).valid).toBe(true);
  });
});

describe('6A — canchas', () => {
  const field = new Map([['F1', { label: 'Deportiva · Cancha 1', availability: { weekly: [{ day: 6, from: '08:00', to: '14:00' }], closedDates: [] } }]]);
  it('separación mínima entre partidos de la misma cancha (también de otros torneos)', () => {
    const c = ctx({ rules: { fieldGapMinutes: 30 }, fields: field, otherFieldMatches: [booked('x1', SAT, '10:00', { tournamentId: 'T2', fieldId: 'F1', duration: 90 })] });
    // x1 termina 11:30: con 30 min de separación, el siguiente desde las 12:00.
    const e = one(proposal(SAT, '11:45', { fieldId: 'F1' }), c);
    expect(e.errors).toEqual([expect.objectContaining({ code: 'FIELD_GAP', scope: 'FIELD', fieldId: 'F1', relatedMatchIds: ['x1'] })]);
    expect(codes(proposal(SAT, '12:00', { fieldId: 'F1' }), c).valid).toBe(true);
    // Antes: el propuesto termina 09:30 y x1 empieza 10:00 → justo 30 min.
    expect(codes(proposal(SAT, '08:30', { fieldId: 'F1' }), c).valid).toBe(true);
    expect(codes(proposal(SAT, '08:31', { fieldId: 'F1' }), c).errors).toEqual(['FIELD_GAP']);
    // Otra cancha: no aplica.
    expect(codes(proposal(SAT, '11:45', { fieldId: 'F2' }), c).valid).toBe(true);
  });

  it('disponibilidad del catálogo: aviso por defecto, obligatoria si el torneo lo elige', () => {
    const p = proposal(SAT, '13:30', { fieldId: 'F1' });
    expect(codes(p, ctx({ fields: field }))).toEqual({ errors: [], warnings: ['FIELD_UNAVAILABLE'], valid: true });
    expect(codes(p, ctx({ fields: field, rules: { fieldAvailability: 'BLOCK' } }))).toEqual({ errors: ['FIELD_UNAVAILABLE'], warnings: [], valid: false });
  });
});

describe('6A — restricciones por equipo', () => {
  it('días y fechas no disponibles', () => {
    const c = ctx({ teams: { [A]: { unavailableDays: [0], unavailableDates: ['2027-01-16'] } } });
    const e = one(proposal(SUN, '10:00'), c);
    expect(e.errors).toEqual([expect.objectContaining({ code: 'TEAM_DAY', scope: 'TEAM', teamId: A })]);
    expect(e.errors[0].message).toBe('Tigres no puede jugar los domingos.');
    expect(codes(proposal('2027-01-16', '10:00'), c).errors).toEqual(['TEAM_DATE']);
    expect(codes(proposal(SAT, '10:00'), c).valid).toBe(true);
    // Solo el equipo con la restricción: Leones vs Chivas el domingo, sin problema.
    expect(codes(proposal(SUN, '10:00', { homeTeamId: C }), c).valid).toBe(true);
  });

  it('rangos horarios (de un día o de todos), también al cruzar la medianoche', () => {
    const c = ctx({ teams: { [B]: { unavailableTimes: [{ day: 6, from: '14:00', to: '18:00' }, { day: 0, from: '00:00', to: '08:00' }] } } });
    expect(codes(proposal(SAT, '13:30'), c).errors).toEqual(['TEAM_TIME']); // 13:30–14:30 toca 14:00
    expect(codes(proposal(SAT, '13:00'), c).valid).toBe(true); // termina 14:00 justo
    expect(codes(proposal(SAT, '18:00'), c).valid).toBe(true);
    // Sábado 23:30 → domingo 00:30: choca con el rango del domingo de madrugada.
    expect(codes(proposal(SAT, '23:30'), c).errors).toEqual(['TEAM_TIME']);
    const daily = ctx({ teams: { [B]: { unavailableTimes: [{ day: null, from: '06:00', to: '09:00' }] } } });
    expect(codes(proposal('2027-01-12', '08:00'), daily).errors).toEqual(['TEAM_TIME']);
  });

  it('descanso mínimo entre partidos del equipo (en ambos sentidos)', () => {
    const c = ctx({ teams: { [A]: { minRestHours: 48 } }, tournamentMatches: [booked('m1', SAT, '10:00', { homeTeamId: A, awayTeamId: C })] });
    // m1 termina el sábado 11:00: el siguiente desde el lunes 11:00.
    const e = one(proposal('2027-01-11', '10:59'), c);
    expect(e.errors).toEqual([expect.objectContaining({ code: 'TEAM_REST', teamId: A, relatedMatchIds: ['m1'] })]);
    expect(codes(proposal('2027-01-11', '11:00'), c).valid).toBe(true);
    // Antes del sábado: termina el jueves 10:00 → 48 h justas.
    expect(codes(proposal('2027-01-07', '09:00'), c).valid).toBe(true);
    expect(codes(proposal('2027-01-07', '09:30'), c).errors).toEqual(['TEAM_REST']);
  });

  it('máximo de partidos por día del equipo', () => {
    const c = ctx({ teams: { [A]: { maxMatchesPerDay: 1 } }, tournamentMatches: [booked('m1', SAT, '10:00', { awayTeamId: A })] });
    expect(codes(proposal(SAT, '18:00'), c).errors).toEqual(['TEAM_DAILY_LIMIT']);
    expect(codes(proposal(SUN, '18:00'), c).valid).toBe(true);
  });

  it('preferencia: avisa y permite continuar', () => {
    const c = ctx({ teams: { [A]: { unavailableDays: [0], strict: false } } });
    const e = one(proposal(SUN, '10:00'), c);
    expect(e.valid).toBe(true);
    expect(e.warnings).toEqual([expect.objectContaining({ code: 'TEAM_DAY', severity: 'WARNING' })]);
    expect(e.warnings[0].message).toContain('preferencia');
  });
});

describe('6A — configuraciones inválidas', () => {
  const rules = (r: Partial<TournamentRules>) => ({ ...DEFAULT_TOURNAMENT_RULES, ...r });
  it('horario incoherente o en el que no cabe un partido', () => {
    expect(() => assertTournamentRules(rules({ startTime: '20:00', endTime: '18:00' }), 60)).toThrow(BadRequestException);
    expect(() => assertTournamentRules(rules({ startTime: '18:00', endTime: '18:45' }), 60)).toThrow(/no cabe/);
    expect(() => assertTournamentRules(rules({ endTime: '00:30' }), 60)).toThrow(/no puede terminar/);
    expect(() => assertTournamentRules(rules({ timeZone: 'Marte/Olympus' }), 60)).toThrow(/Zona horaria/);
    expect(() => assertTournamentRules(rules({ startTime: '18:00', endTime: '24:00', timeZone: 'America/Mazatlan' }), 90)).not.toThrow();
  });

  it('un equipo obligado no puede quedar sin ningún día para jugar', () => {
    const t = rules({ days: [6, 0] });
    const team = (r: Partial<TeamRules>) => ({ ...DEFAULT_TEAM_RULES, ...r });
    expect(() => assertTeamRules(team({ unavailableDays: [6, 0] }), t, 'Tigres')).toThrow(/Tigres no podría jugar/);
    expect(() => assertTeamRules(team({ unavailableDays: [6], unavailableTimes: [{ day: 0, from: '00:00', to: '24:00' }] }), t)).toThrow(/ningún día/);
    expect(() => assertTeamRules(team({ unavailableDays: [6, 0], strict: false }), t)).not.toThrow();
    expect(() => assertTeamRules(team({ unavailableDays: [6] }), t)).not.toThrow();
    expect(() => assertTeamRules(team({ unavailableTimes: [{ day: null, from: '18:00', to: '18:00' }] }), t)).toThrow(/Rango inválido/);
  });
});

describe('6A — zona horaria', () => {
  it('la del torneo o, sin configurar, la de las ligas', () => {
    expect(timeZoneOf({ timeZone: 'America/Mazatlan' })).toBe('America/Mazatlan');
    expect(timeZoneOf({ timeZone: null })).toBe(process.env.APP_TIME_ZONE?.trim() || 'America/Cancun');
    // 2027-01-10 06:30 UTC: en Cancún (UTC−5) aún es el 10 a la 01:30; en Mazatlán (UTC−7) el 9 a las 23:30.
    const now = new Date('2027-01-10T06:30:00Z');
    expect(todayISODate(now, 'America/Cancun')).toBe('2027-01-10');
    expect(todayISODate(now, 'America/Mazatlan')).toBe('2027-01-09');
  });
});
