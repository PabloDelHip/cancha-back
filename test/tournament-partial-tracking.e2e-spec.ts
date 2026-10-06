/**
 * Etapa 6F — Cobertura de datos del torneo (FULL | PARTIAL). En PARTIAL Cancha solo sigue a algunos
 * equipos: no publica tabla, goleadores ni estructura/campeón globales (409
 * TOURNAMENT_PARTIAL_COVERAGE), pero los partidos registrados siguen alimentando partidos, balance,
 * goleadores y asistidores del equipo y el perfil del jugador. API real contra replica set en memoria.
 */
import request from 'supertest';
import mongoose, { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { Tournament } from '../src/modules/tournaments/schemas/tournament.schema.js';
import { Match } from '../src/modules/matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../src/modules/matches/schemas/player-match-stats.schema.js';
import { TeamMembership } from '../src/modules/players/schemas/team-membership.schema.js';
import { TournamentTeam } from '../src/modules/tournaments/schemas/tournament-team.schema.js';
import { TeamAdmin } from '../src/modules/teams/schemas/team-admin.schema.js';
import { User } from '../src/modules/users/schemas/user.schema.js';
import { MatchStatus, TeamAdminRole, TeamAdminSource, TeamAdminStatus, UserRole } from '../src/common/enums/index.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);
type U = Awaited<ReturnType<typeof registerOrganizer>>;
const as = (u: U) => authed(http, u.token);
let tournaments: Model<Tournament>;
let matchesModel: Model<Match>;
let statsModel: Model<PlayerMatchStats>;
let membershipsModel: Model<TeamMembership>;
let enrollmentsModel: Model<TournamentTeam>;
let teamAdmins: Model<TeamAdmin>;
let users: Model<User>;

/** O organiza la Liga Piloto; intruso es otro usuario (también con User.role legacy). */
let O: U, intruso: U;
let seq = 0;
const PARTIAL_CODE = 'TOURNAMENT_PARTIAL_COVERAGE';

const team = async (name: string) => (await as(O).post('/api/teams').send({ name: `${name} ${++seq}` }).expect(201)).body.id as string;
const player = async (firstName: string) =>
  (await as(O).post('/api/players').send({ confirmNew: true, firstName, lastName: `Piloto ${++seq}`, position: 'FORWARD', birthDate: '2000-05-05' }).expect(201)).body.id as string;
const tournament = async (name: string, extra: Record<string, unknown> = {}) =>
  (await as(O).post('/api/tournaments').send({ name, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', ...extra }).expect(201)).body;
type Line = { playerId: string; teamId: string; goals?: number; assists?: number };
const play = async (t: string, round: number, home: string, away: string, hs: number, as_: number, lines: Line[] = []) => {
  const id = (await as(O).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date: `2027-01-${String(9 + round).padStart(2, '0')}`, time: '18:00' }).expect(201)).body.id as string;
  await as(O)
    .put(`/api/matches/${id}/result`)
    .send({ homeScore: hs, awayScore: as_, playerStats: lines.map((l) => ({ played: true, goals: 0, assists: 0, yellowCards: 0, redCards: 0, ...l })) })
    .expect(200);
  return id;
};
const counts = async (t: string) => {
  const tid = new Types.ObjectId(t);
  const matchIds = (await matchesModel.distinct('_id', { tournamentId: tid })) as Types.ObjectId[];
  return {
    matches: matchIds.length,
    finished: await matchesModel.countDocuments({ tournamentId: tid, status: MatchStatus.FINISHED }),
    stats: await statsModel.countDocuments({ matchId: { $in: matchIds } }),
    memberships: await membershipsModel.countDocuments({ tournamentId: tid }),
    enrollments: await enrollmentsModel.countDocuments({ tournamentId: tid }),
  };
};

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  tournaments = ctx.app.get(getModelToken(Tournament.name));
  matchesModel = ctx.app.get(getModelToken(Match.name));
  statsModel = ctx.app.get(getModelToken(PlayerMatchStats.name));
  membershipsModel = ctx.app.get(getModelToken(TeamMembership.name));
  enrollmentsModel = ctx.app.get(getModelToken(TournamentTeam.name));
  teamAdmins = ctx.app.get(getModelToken(TeamAdmin.name));
  users = ctx.app.get(getModelToken(User.name));
  O = await registerOrganizer(http, 'Organizador');
  intruso = await registerOrganizer(http, 'Intruso');
});
afterAll(async () => ctx?.close());

describe('Modelo, compatibilidad y configuración', () => {
  it('un torneo nuevo es FULL por defecto (crear, leer, listar)', async () => {
    const t = await tournament('Liga Default');
    expect(t.dataCoverage).toBe('FULL');
    expect((await api().get(`/api/tournaments/${t.id}`).expect(200)).body.dataCoverage).toBe('FULL');
    const list = (await api().get('/api/tournaments?limit=100').expect(200)).body.data as { id: string; dataCoverage: string }[];
    expect(list.find((x) => x.id === t.id)!.dataCoverage).toBe('FULL');
  });

  it('un torneo anterior a 6F (sin el campo en Mongo) se comporta como FULL', async () => {
    const t = await tournament('Liga Antigua');
    await tournaments.collection.updateOne({ _id: new Types.ObjectId(t.id) }, { $unset: { dataCoverage: '' } });
    expect((await tournaments.collection.findOne({ _id: new Types.ObjectId(t.id) }))).not.toHaveProperty('dataCoverage');
    expect((await api().get(`/api/tournaments/${t.id}`).expect(200)).body.dataCoverage).toBe('FULL');
    await api().get(`/api/tournaments/${t.id}/standings`).expect(200);
    await api().get(`/api/tournaments/${t.id}/top-scorers`).expect(200);
    await api().get(`/api/tournaments/${t.id}/structure`).expect(200);
  });

  it('el organizador crea en PARTIAL y cambia la cobertura; valores inválidos → 400', async () => {
    const t = await tournament('Liga Config', { dataCoverage: 'PARTIAL' });
    expect(t.dataCoverage).toBe('PARTIAL');
    expect((await as(O).patch(`/api/tournaments/${t.id}`).send({ dataCoverage: 'FULL' }).expect(200)).body.dataCoverage).toBe('FULL');
    expect((await as(O).patch(`/api/tournaments/${t.id}`).send({ dataCoverage: 'PARTIAL' }).expect(200)).body.dataCoverage).toBe('PARTIAL');
    await as(O).patch(`/api/tournaments/${t.id}`).send({ dataCoverage: 'partial' }).expect(400);
    await as(O).patch(`/api/tournaments/${t.id}`).send({ dataCoverage: 'MIXED' }).expect(400);
  });

  it('otro usuario (aunque tenga User.role legacy u OWNER de un equipo inscrito) no cambia la cobertura: 403; sin sesión 401', async () => {
    const t = await tournament('Liga Ajena');
    const eq = await team('Equipo Inscrito');
    await as(O).post(`/api/tournaments/${t.id}/teams/${eq}`).expect(201);
    await users.updateOne({ _id: new Types.ObjectId(intruso.id) }, { $set: { role: UserRole.ORGANIZER } });
    await teamAdmins.create({ teamId: new Types.ObjectId(eq), userId: new Types.ObjectId(intruso.id), role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE, source: TeamAdminSource.INTERNAL, grantedBy: null });
    await as(intruso).patch(`/api/tournaments/${t.id}`).send({ dataCoverage: 'PARTIAL' }).expect(403);
    await api().patch(`/api/tournaments/${t.id}`).send({ dataCoverage: 'PARTIAL' }).expect(401);
    expect((await api().get(`/api/tournaments/${t.id}`).expect(200)).body.dataCoverage).toBe('FULL');
  });

  it('cobertura y estado son independientes; un torneo FINISHED no cambia de cobertura (inmutable)', async () => {
    const draft = await tournament('Liga Borrador', { status: 'DRAFT', dataCoverage: 'PARTIAL' });
    expect(draft).toMatchObject({ status: 'DRAFT', dataCoverage: 'PARTIAL' });
    const t = await tournament('Liga Cerrada', { dataCoverage: 'PARTIAL' });
    const fin = (await as(O).post(`/api/tournaments/${t.id}/finish`).send({}).expect(200)).body.tournament;
    expect(fin).toMatchObject({ status: 'FINISHED', dataCoverage: 'PARTIAL' });
    await as(O).patch(`/api/tournaments/${t.id}`).send({ dataCoverage: 'FULL' }).expect(409);
    await as(O).patch(`/api/tournaments/${t.id}`).send({ name: 'Otro' }).expect(409); // la misma regla de siempre
    expect((await api().get(`/api/tournaments/${t.id}`).expect(200)).body.dataCoverage).toBe('PARTIAL');
    // FINISHED + PARTIAL: las vistas globales siguen sin publicarse.
    expect((await api().get(`/api/tournaments/${t.id}/standings`).expect(409)).body.code).toBe(PARTIAL_CODE);
  });
});

describe('Caso obligatorio: Liga Piloto (PARTIAL)', () => {
  let liga: string, azul: string, rojo: string, verde: string, toros: string;
  let juan: string, carlos: string, pedro: string, luis: string;

  beforeAll(async () => {
    liga = (await tournament('Liga Piloto', { dataCoverage: 'PARTIAL' })).id;
    [azul, rojo, verde, toros] = [await team('Atlético Azul'), await team('Deportivo Rojo'), await team('Real Verde'), await team('Toros FC')];
    for (const x of [azul, rojo, verde, toros]) await as(O).post(`/api/tournaments/${liga}/teams/${x}`).expect(201);
    [juan, carlos, pedro, luis] = [await player('Juan'), await player('Carlos'), await player('Pedro'), await player('Luis')];
    for (const [p, t] of [[juan, azul], [carlos, azul], [pedro, rojo], [luis, rojo]]) {
      await as(O).put(`/api/tournaments/${liga}/players/${p}`).send({ teamId: t, startDate: '2027-01-01' }).expect(200);
    }
    await play(liga, 1, azul, verde, 3, 1, [
      { playerId: juan, teamId: azul, goals: 2, assists: 1 },
      { playerId: carlos, teamId: azul, goals: 1, assists: 1 },
    ]);
    await play(liga, 2, toros, azul, 2, 2, [
      { playerId: juan, teamId: azul, goals: 1 },
      { playerId: carlos, teamId: azul, goals: 1 },
    ]);
    await play(liga, 3, rojo, verde, 2, 0, [
      { playerId: pedro, teamId: rojo, goals: 2 },
      { playerId: luis, teamId: rojo, assists: 2 },
    ]);
    await play(liga, 4, rojo, toros, 1, 1, [{ playerId: luis, teamId: rojo, goals: 1 }]);
  });

  it('partidos creados, finalizados y con goles/asistencias como siempre', async () => {
    expect(await counts(liga)).toMatchObject({ matches: 4, finished: 4, stats: 7, memberships: 4, enrollments: 4 });
  });

  it('tabla general, goleadores generales y estructura/campeón: 409 TOURNAMENT_PARTIAL_COVERAGE (nunca una lista)', async () => {
    for (const path of ['standings', 'top-scorers', 'structure']) {
      const res = await api().get(`/api/tournaments/${liga}/${path}`).expect(409);
      expect(res.body).toMatchObject({ statusCode: 409, code: PARTIAL_CODE });
      expect(res.body.message).toMatch(/seguimiento parcial/);
    }
    // Generar la eliminatoria desde la tabla tampoco (saldría de una tabla incompleta).
    const ko = (await tournament('Liga Piloto Playoffs', { dataCoverage: 'PARTIAL', settings: { system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 } })).id;
    expect((await as(O).post(`/api/tournaments/${ko}/phases/advance`).send({ startDate: '2027-02-01' }).expect(409)).body.code).toBe(PARTIAL_CODE);
  });

  it('el torneo sigue legible: detalle, equipos inscritos y partidos', async () => {
    expect((await api().get(`/api/tournaments/${liga}`).expect(200)).body).toMatchObject({ name: 'Liga Piloto', dataCoverage: 'PARTIAL' });
    expect((await api().get(`/api/tournaments/${liga}/teams`).expect(200)).body).toHaveLength(4);
    const ms = (await api().get(`/api/matches?tournamentId=${liga}&limit=100`).expect(200)).body.data;
    expect(ms).toHaveLength(4);
  });

  it('Team Profile de Atlético Azul: 2 partidos, balance, goleadores y asistidores; sin posición ni título', async () => {
    const p = (await api().get(`/api/teams/${azul}/profile`).expect(200)).body;
    expect(p.career).toMatchObject({ matchesPlayed: 2, wins: 1, draws: 1, losses: 0, goalsFor: 5, goalsAgainst: 3, goalDifference: 2, competitions: 1 });
    expect(p.recentMatches).toHaveLength(2);
    expect(p.recentMatches.map((m: { homeScore: number; awayScore: number }) => `${m.homeScore}-${m.awayScore}`).sort()).toEqual(['2-2', '3-1']);
    expect(p.topScorers.map((s: { player: { id: string }; goals: number }) => [s.player.id, s.goals])).toEqual([[juan, 3], [carlos, 2]]);
    expect(p.topAssists.map((s: { player: { id: string }; assists: number }) => [s.player.id, s.assists])).toEqual([[juan, 1], [carlos, 1]]);
    expect(p.competitions[0]).toMatchObject({ tournament: { id: liga, dataCoverage: 'PARTIAL' }, standing: null, finalStanding: null, record: { matchesPlayed: 2 } });
    expect(p.currentParticipations).toEqual([expect.objectContaining({ standing: null })]);
    expect(p.honors).toEqual([]);
    const page = (await api().get(`/api/teams/${azul}/matches?limit=10`).expect(200)).body;
    expect(page.data).toHaveLength(2);
  });

  it('Team Profile de Deportivo Rojo: 2 partidos, balance, goleadores y asistidores', async () => {
    const p = (await api().get(`/api/teams/${rojo}/profile`).expect(200)).body;
    expect(p.career).toMatchObject({ matchesPlayed: 2, wins: 1, draws: 1, losses: 0, goalsFor: 3, goalsAgainst: 1 });
    expect(p.recentMatches).toHaveLength(2);
    expect(p.topScorers.map((s: { player: { id: string }; goals: number }) => [s.player.id, s.goals])).toEqual([[pedro, 2], [luis, 1]]);
    expect(p.topAssists.map((s: { player: { id: string }; assists: number }) => [s.player.id, s.assists])).toEqual([[luis, 2]]);
  });

  it('Player Profile de Juan y Pedro: estadísticas completas aunque el torneo sea PARTIAL', async () => {
    const j = (await api().get(`/api/players/${juan}/profile`).expect(200)).body;
    expect(j.career).toMatchObject({ appearances: 2, goals: 3, assists: 1, competitions: 1, teams: 1, titles: 0 });
    expect(j.competitions[0]).toMatchObject({ tournament: { id: liga, dataCoverage: 'PARTIAL' }, stats: { appearances: 2, goals: 3, assists: 1 }, topScorer: null });
    const pe = (await api().get(`/api/players/${pedro}/profile`).expect(200)).body;
    expect(pe.career).toMatchObject({ appearances: 1, goals: 2, assists: 0 }); // solo jugó el 2-0
    const st = (await api().get(`/api/players/${luis}/stats`).expect(200)).body;
    expect(st.totals).toMatchObject({ goals: 1, assists: 2 });
    expect(st.byTournament[0].tournament).toMatchObject({ id: liga, dataCoverage: 'PARTIAL' });
  });

  it('Real Verde y Toros existen como rivales sin OWNER ni MANAGER ni plantilla', async () => {
    for (const t of [verde, toros]) {
      expect(await teamAdmins.countDocuments({ teamId: new Types.ObjectId(t) })).toBe(0);
      const p = (await api().get(`/api/teams/${t}/profile`).expect(200)).body;
      expect(p.currentRoster).toEqual([]);
      expect(p.career.matchesPlayed).toBe(2);
    }
  });

  it('FULL → PARTIAL → FULL: no se pierde nada; las vistas globales vuelven con los mismos datos', async () => {
    const before = await counts(liga);
    const full = (await as(O).patch(`/api/tournaments/${liga}`).send({ dataCoverage: 'FULL' }).expect(200)).body;
    expect(full.dataCoverage).toBe('FULL');
    expect(await counts(liga)).toEqual(before);
    const table = (await api().get(`/api/tournaments/${liga}/standings`).expect(200)).body as { teamId: string; points: number; played: number }[];
    expect(table).toHaveLength(4);
    expect(table.find((r) => r.teamId === azul)).toMatchObject({ played: 2, points: 4 });
    const scorers = (await api().get(`/api/tournaments/${liga}/top-scorers`).expect(200)).body as { playerId: string; goals: number }[];
    expect(scorers[0]).toMatchObject({ playerId: juan, goals: 3 });
    await api().get(`/api/tournaments/${liga}/structure`).expect(200);
    // En FULL el perfil del equipo vuelve a tener posición en la tabla.
    expect((await api().get(`/api/teams/${azul}/profile`).expect(200)).body.currentParticipations[0].standing).toMatchObject({ teams: 4 });

    await as(O).patch(`/api/tournaments/${liga}`).send({ dataCoverage: 'PARTIAL' }).expect(200);
    expect(await counts(liga)).toEqual(before);
    await api().get(`/api/tournaments/${liga}/standings`).expect(409);
    expect((await api().get(`/api/players/${juan}/profile`).expect(200)).body.career).toMatchObject({ appearances: 2, goals: 3, assists: 1 });
  });

  it('rendimiento: la cobertura no añade consultas (perfil del equipo igual en FULL y PARTIAL; standings PARTIAL = 1 consulta)', async () => {
    const calls: string[] = [];
    mongoose.set('debug', (collection: string) => void calls.push(collection));
    await api().get(`/api/teams/${azul}/profile`).expect(200);
    const partialProfile = calls.length;
    calls.length = 0;
    await api().get(`/api/tournaments/${liga}/standings`).expect(409);
    const partialStandings = calls.length;
    mongoose.set('debug', false);
    await as(O).patch(`/api/tournaments/${liga}`).send({ dataCoverage: 'FULL' }).expect(200);
    mongoose.set('debug', (collection: string) => void calls.push(collection));
    calls.length = 0;
    await api().get(`/api/teams/${azul}/profile`).expect(200);
    const fullProfile = calls.length;
    mongoose.set('debug', false);
    await as(O).patch(`/api/tournaments/${liga}`).send({ dataCoverage: 'PARTIAL' }).expect(200);
    expect(partialProfile).toBeGreaterThan(3);
    expect(partialProfile).toBe(fullProfile);
    expect(partialStandings).toBe(1);
  });

  it('privacidad: dataCoverage no arrastra datos internos (organizador, cerrojo, cuentas)', async () => {
    const FORBIDDEN = ['organizerId', 'writeSeq', 'createdBy', 'email', 'passwordHash', 'birthDate', 'addedBy', 'searchName'];
    const walk = (v: unknown): string[] =>
      Array.isArray(v) ? v.flatMap(walk) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) ? [k] : []), ...walk(x)]) : [];
    const bodies = [
      (await api().get(`/api/tournaments/${liga}`).expect(200)).body,
      (await api().get('/api/tournaments?limit=100').expect(200)).body,
      (await api().get(`/api/teams/${azul}/profile`).expect(200)).body,
      (await api().get(`/api/teams/${azul}`).expect(200)).body,
      (await api().get(`/api/players/${juan}/profile`).expect(200)).body,
      (await api().get(`/api/players/${juan}/stats`).expect(200)).body,
      (await api().get(`/api/players/${juan}/memberships`).expect(200)).body,
      (await api().get(`/api/tournaments/${liga}/standings`).expect(409)).body,
    ];
    for (const b of bodies) {
      expect(walk(b)).toEqual([]);
      expect(JSON.stringify(b)).not.toContain(O.id);
    }
  });

  it('finalizar un PARTIAL con formato de eliminatoria no exige un campeón que Cancha no conoce (FULL sí)', async () => {
    const make = async (dataCoverage: string) => {
      const t = (await tournament(`Copa ${dataCoverage}`, { dataCoverage, settings: { system: 'LEAGUE_PLAYOFFS', playoffTeams: 2 } })).id;
      for (const x of [await team('Copa A'), await team('Copa B')]) await as(O).post(`/api/tournaments/${t}/teams/${x}`).expect(201);
      return t;
    };
    await as(O).post(`/api/tournaments/${await make('FULL')}/finish`).send({}).expect(409); // regla de siempre
    await as(O).post(`/api/tournaments/${await make('PARTIAL')}/finish`).send({}).expect(200);
  });

  it('un PARTIAL finalizado conserva partidos y estadísticas, y no inventa campeón ni goleador', async () => {
    const before = await counts(liga);
    await as(O).post(`/api/tournaments/${liga}/finish`).send({}).expect(200);
    expect(await counts(liga)).toEqual(before);
    const p = (await api().get(`/api/teams/${azul}/profile`).expect(200)).body;
    expect(p.honors).toEqual([]);
    expect(p.competitions[0]).toMatchObject({ finalStanding: null, record: { matchesPlayed: 2, wins: 1 } });
    const j = (await api().get(`/api/players/${juan}/profile`).expect(200)).body;
    expect(j.honors).toEqual([]); // sería "goleador del torneo" con datos incompletos
    expect(j.competitions[0].teams[0].outcome).toBeNull();
    expect(j.career).toMatchObject({ appearances: 2, goals: 3, assists: 1, titles: 0 });
  });
});

describe('Partidos a mano en cualquier formato con seguimiento parcial', () => {
  for (const system of ['LEAGUE_PLAYOFFS', 'KNOCKOUT', 'GROUPS_KNOCKOUT'] as const) {
    it(`${system}: PARTIAL permite programar, capturar y finalizar partidos a mano (sin estructura)`, async () => {
      const settings =
        system === 'LEAGUE_PLAYOFFS' ? { system, playoffTeams: 2 } : system === 'GROUPS_KNOCKOUT' ? { system, groupCount: 2, qualifiersPerGroup: 1 } : { system };
      const [a, b] = [await team(`${system} A`), await team(`${system} B`)];
      const goleador = await player('Manual');

      const full = (await tournament(`Copa ${system} completa`, { settings })).id;
      for (const x of [a, b]) await as(O).post(`/api/tournaments/${full}/teams/${x}`).expect(201);
      // En FULL el partido a mano cae en su lugar de la estructura (ver manual-schedule.e2e-spec.ts):
      // fase regular → su tabla; grupos → exige grupos armados; eliminación → se arma por cruces.
      const res = await as(O).post('/api/matches').send({ tournamentId: full, round: 1, homeTeamId: a, awayTeamId: b, date: '2027-01-10', time: '18:00' });
      if (system === 'LEAGUE_PLAYOFFS') expect(res.body.stage).toEqual({ phase: 0, group: null, tie: null });
      else expect(res.body.message).toMatch(system === 'KNOCKOUT' ? /se arman por cruces/ : /Primero arma los grupos/);

      const t = (await tournament(`Copa ${system} parcial`, { settings, dataCoverage: 'PARTIAL' })).id;
      for (const x of [a, b]) await as(O).post(`/api/tournaments/${t}/teams/${x}`).expect(201);
      await as(O).put(`/api/tournaments/${t}/players/${goleador}`).send({ teamId: a, startDate: '2027-01-01' }).expect(200);
      await play(t, 1, a, b, 2, 1, [{ playerId: goleador, teamId: a, goals: 2, assists: 0 }]);
      await play(t, 2, b, a, 0, 0);
      expect(await counts(t)).toMatchObject({ matches: 2, finished: 2, stats: 1 });

      const tp = (await api().get(`/api/teams/${a}/profile`).expect(200)).body;
      const comp = tp.competitions.find((c: { tournament: { id: string } }) => c.tournament.id === t);
      expect(comp).toMatchObject({ standing: null, finalStanding: null, record: { matchesPlayed: 2, wins: 1, draws: 1, goalsFor: 2, goalsAgainst: 1 } });
      expect((await api().get(`/api/players/${goleador}/profile`).expect(200)).body.career).toMatchObject({ appearances: 1, goals: 2 });
      await api().get(`/api/tournaments/${t}/standings`).expect(409);

      // Volver a FULL con partidos sueltos en este formato: no (entrarían en su estructura).
      const back = await as(O).patch(`/api/tournaments/${t}`).send({ dataCoverage: 'FULL' }).expect(409);
      expect(back.body.message).toMatch(/cambia antes el formato a Liga/);
      expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.dataCoverage).toBe('PARTIAL');
      // Y con partidos jugados el formato ya no puede cambiar (regla de siempre): sigue PARTIAL, sin perder nada.
      const before = await counts(t);
      await as(O).patch(`/api/tournaments/${t}`).send({ dataCoverage: 'FULL', settings: { system: 'LEAGUE' } }).expect(409);
      expect(await counts(t)).toEqual(before);

      await as(O).post(`/api/tournaments/${t}/finish`).send({}).expect(200);
    });
  }

  it('PARTIAL en Liga con partidos a mano puede volver a FULL (sin estructura que corromper)', async () => {
    const t = (await tournament('Liga ida y vuelta', { dataCoverage: 'PARTIAL' })).id;
    const [a, b] = [await team('Ida A'), await team('Ida B')];
    for (const x of [a, b]) await as(O).post(`/api/tournaments/${t}/teams/${x}`).expect(201);
    await play(t, 1, a, b, 1, 0);
    await as(O).patch(`/api/tournaments/${t}`).send({ dataCoverage: 'FULL' }).expect(200);
    await api().get(`/api/tournaments/${t}/standings`).expect(200);
  });

  it('PARTIAL sin partidos sueltos (solo los generados) puede volver a FULL en cualquier formato', async () => {
    const t = (await tournament('Copa sin sueltos', { dataCoverage: 'PARTIAL', settings: { system: 'KNOCKOUT' } })).id;
    await as(O).patch(`/api/tournaments/${t}`).send({ dataCoverage: 'FULL' }).expect(200);
  });
});

describe('FULL sin cambios', () => {
  it('tabla, goleadores, estructura y perfil con posición, como antes de 6F', async () => {
    const t = (await tournament('Liga Completa')).id;
    const [a, b] = [await team('Full A'), await team('Full B')];
    for (const x of [a, b]) await as(O).post(`/api/tournaments/${t}/teams/${x}`).expect(201);
    const goleador = await player('Goleador');
    await as(O).put(`/api/tournaments/${t}/players/${goleador}`).send({ teamId: a, startDate: '2027-01-01' }).expect(200);
    await play(t, 1, a, b, 2, 0, [{ playerId: goleador, teamId: a, goals: 2 }]);
    const table = (await api().get(`/api/tournaments/${t}/standings`).expect(200)).body;
    expect(table[0]).toMatchObject({ teamId: a, points: 3, position: 1 });
    expect((await api().get(`/api/tournaments/${t}/top-scorers`).expect(200)).body[0]).toMatchObject({ playerId: goleador, goals: 2 });
    expect((await api().get(`/api/tournaments/${t}/structure`).expect(200)).body.phases[0].type).toBe('LEAGUE');
    const p = (await api().get(`/api/teams/${a}/profile`).expect(200)).body;
    expect(p.currentParticipations[0].standing).toMatchObject({ position: 1, teams: 2, points: 3 });
    expect(p.competitions[0].tournament.dataCoverage).toBe('FULL');
    await as(O).post(`/api/tournaments/${t}/finish`).send({}).expect(200);
    const after = (await api().get(`/api/teams/${a}/profile`).expect(200)).body;
    expect(after.honors).toEqual([expect.objectContaining({ type: 'CHAMPION', decidedBy: 'LEAGUE_TABLE' })]);
    const pp = (await api().get(`/api/players/${goleador}/profile`).expect(200)).body;
    expect(pp.honors.map((h: { type: string }) => h.type).sort()).toEqual(['CHAMPION', 'TOP_SCORER']);
  });
});
