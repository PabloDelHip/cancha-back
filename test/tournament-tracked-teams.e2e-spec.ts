/**
 * Etapa 6G — Equipos en seguimiento (Tournament.trackedTeamIds) de un torneo PARTIAL. Participar
 * (TournamentTeam) ≠ estar seguido. Solo el organizador los elige, solo entre los inscritos; en FULL
 * siempre vacío. GET /tournaments/:id/tracked-summary arma todas las tarjetas en consultas fijas.
 * Nunca se borran partidos ni estadísticas al cambiar el seguimiento. API real.
 */
import request from 'supertest';
import mongoose, { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { Tournament } from '../src/modules/tournaments/schemas/tournament.schema.js';
import { Match } from '../src/modules/matches/schemas/match.schema.js';
import { PlayerMatchStats } from '../src/modules/matches/schemas/player-match-stats.schema.js';
import { TeamAdmin } from '../src/modules/teams/schemas/team-admin.schema.js';
import { TeamRoster } from '../src/modules/teams/schemas/team-roster.schema.js';
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
let teamAdmins: Model<TeamAdmin>;
let rosters: Model<TeamRoster>;
let users: Model<User>;
let O: U, otro: U, duenio: U;
let seq = 0;

const team = async (name: string) => (await as(O).post('/api/teams').send({ name: `${name} ${++seq}` }).expect(201)).body.id as string;
const player = async (firstName: string) =>
  (await as(O).post('/api/players').send({ confirmNew: true, firstName, lastName: `Seguido ${++seq}`, position: 'FORWARD', birthDate: '2000-05-05' }).expect(201)).body.id as string;
const tournament = async (name: string, extra: Record<string, unknown> = {}) =>
  (await as(O).post('/api/tournaments').send({ name, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', ...extra }).expect(201)).body;
const enroll = async (t: string, ...ids: string[]) => {
  for (const x of ids) await as(O).post(`/api/tournaments/${t}/teams/${x}`).expect(201);
};
const track = (t: string, ids: string[], by: U = O) => as(by).patch(`/api/tournaments/${t}`).send({ trackedTeamIds: ids });
type Line = { playerId: string; teamId: string; goals?: number; assists?: number };
let day = 0;
const play = async (t: string, home: string, away: string, hs: number, as_: number, lines: Line[] = []) => {
  const id = (await as(O).post('/api/matches').send({ tournamentId: t, round: ++day, homeTeamId: home, awayTeamId: away, date: `2027-02-${String(day).padStart(2, '0')}`, time: '18:00' }).expect(201)).body.id as string;
  await as(O)
    .put(`/api/matches/${id}/result`)
    .send({ homeScore: hs, awayScore: as_, playerStats: lines.map((l) => ({ played: true, goals: 0, assists: 0, yellowCards: 0, redCards: 0, ...l })) })
    .expect(200);
  return id;
};
const summary = async (t: string) => (await api().get(`/api/tournaments/${t}/tracked-summary`).expect(200)).body;
const snapshot = async (t: string) => {
  const tid = new Types.ObjectId(t);
  const ids = (await matchesModel.distinct('_id', { tournamentId: tid })) as Types.ObjectId[];
  return { matches: ids.length, finished: await matchesModel.countDocuments({ tournamentId: tid, status: MatchStatus.FINISHED }), stats: await statsModel.countDocuments({ matchId: { $in: ids } }) };
};

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  tournaments = ctx.app.get(getModelToken(Tournament.name));
  matchesModel = ctx.app.get(getModelToken(Match.name));
  statsModel = ctx.app.get(getModelToken(PlayerMatchStats.name));
  teamAdmins = ctx.app.get(getModelToken(TeamAdmin.name));
  rosters = ctx.app.get(getModelToken(TeamRoster.name));
  users = ctx.app.get(getModelToken(User.name));
  [O, otro, duenio] = [await registerOrganizer(http, 'Organizador'), await registerOrganizer(http, 'Otro'), await registerOrganizer(http, 'Duenio')];
});
afterAll(async () => ctx?.close());

describe('Modelo, validaciones y autorización', () => {
  let t: string, a: string, b: string, fuera: string;
  beforeAll(async () => {
    t = (await tournament('Liga Config 6G', { dataCoverage: 'PARTIAL' })).id;
    [a, b, fuera] = [await team('A'), await team('B'), await team('No inscrito')];
    await enroll(t, a, b);
  });

  it('FULL: trackedTeamIds vacío en todas las respuestas; enviarlos con FULL → 400; resumen vacío', async () => {
    const f = await tournament('Liga Completa 6G');
    expect(f.trackedTeamIds).toEqual([]);
    const x = await team('Full X');
    await enroll(f.id, x);
    await track(f.id, [x]).expect(400);
    expect((await api().get(`/api/tournaments/${f.id}`).expect(200)).body.trackedTeamIds).toEqual([]);
    expect((await summary(f.id)).trackedTeams).toEqual([]);
    await api().get(`/api/tournaments/${f.id}/standings`).expect(200);
  });

  it('PARTIAL: el organizador elige equipos inscritos; se reemplaza la lista completa', async () => {
    expect((await track(t, [a, b]).expect(200)).body.trackedTeamIds).toEqual([a, b]);
    expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.trackedTeamIds).toEqual([a, b]);
    expect((await track(t, [b]).expect(200)).body.trackedTeamIds).toEqual([b]);
    const list = (await api().get('/api/tournaments?limit=100').expect(200)).body.data as { id: string; trackedTeamIds: string[] }[];
    expect(list.find((x) => x.id === t)!.trackedTeamIds).toEqual([b]);
  });

  it('equipo no inscrito o inexistente → 409 TRACKED_TEAM_NOT_ENROLLED, sin inscribirlo ni cambiar nada', async () => {
    const r = await track(t, [a, fuera]).expect(409);
    expect(r.body).toMatchObject({ code: 'TRACKED_TEAM_NOT_ENROLLED', teamIds: [fuera] });
    expect((await track(t, ['000000000000000000000000']).expect(409)).body.code).toBe('TRACKED_TEAM_NOT_ENROLLED');
    expect((await api().get(`/api/tournaments/${t}/teams`).expect(200)).body).toHaveLength(2);
    expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.trackedTeamIds).toEqual([b]);
  });

  it('repetidos o ids inválidos → 400 (determinista); al crear no se aceptan (aún no hay inscritos)', async () => {
    await track(t, [a, a]).expect(400);
    await track(t, ['no-es-id']).expect(400);
    await as(O).post('/api/tournaments').send({ name: 'X', format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', dataCoverage: 'PARTIAL', trackedTeamIds: [a] }).expect(400);
  });

  it('solo el organizador: otro usuario, OWNER de un equipo inscrito y User.role legacy → 403; sin sesión 401', async () => {
    await users.updateOne({ _id: new Types.ObjectId(duenio.id) }, { $set: { role: UserRole.ORGANIZER } });
    await teamAdmins.create({ teamId: new Types.ObjectId(a), userId: new Types.ObjectId(duenio.id), role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE, source: TeamAdminSource.INTERNAL, grantedBy: null });
    await track(t, [a], otro).expect(403);
    await track(t, [a], duenio).expect(403); // el OWNER no decide que su equipo sea seguido
    await api().patch(`/api/tournaments/${t}`).send({ trackedTeamIds: [a] }).expect(401);
    expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.trackedTeamIds).toEqual([b]);
  });

  it('FINISHED: no se cambian los equipos seguidos ni la cobertura (409)', async () => {
    const f = (await tournament('Liga Cerrada 6G', { dataCoverage: 'PARTIAL' })).id;
    const x = await team('Cerrada X');
    await enroll(f, x);
    await track(f, [x]).expect(200);
    await as(O).post(`/api/tournaments/${f}/finish`).send({}).expect(200);
    await track(f, []).expect(409);
    await as(O).patch(`/api/tournaments/${f}`).send({ dataCoverage: 'FULL' }).expect(409);
    expect((await api().get(`/api/tournaments/${f}`).expect(200)).body).toMatchObject({ status: 'FINISHED', trackedTeamIds: [x] });
  });

  it('PARTIAL de 6F sin el campo en Mongo: carga con [], resumen vacío y se puede configurar', async () => {
    const legacy = (await tournament('Liga 6F antigua', { dataCoverage: 'PARTIAL' })).id;
    const x = await team('Antigua X');
    await enroll(legacy, x);
    await tournaments.collection.updateOne({ _id: new Types.ObjectId(legacy) }, { $unset: { trackedTeamIds: '' } });
    expect(await tournaments.collection.findOne({ _id: new Types.ObjectId(legacy) })).not.toHaveProperty('trackedTeamIds');
    expect((await api().get(`/api/tournaments/${legacy}`).expect(200)).body).toMatchObject({ dataCoverage: 'PARTIAL', trackedTeamIds: [] });
    expect((await summary(legacy)).trackedTeams).toEqual([]);
    await api().get(`/api/tournaments/${legacy}/standings`).expect(409); // nunca pasa a FULL solo
    await track(legacy, [x]).expect(200);
    expect((await summary(legacy)).trackedTeams).toHaveLength(1);
  });
});

describe('Caso principal: Liga Piloto (PARTIAL, 2 seguidos de 6)', () => {
  let liga: string, azul: string, rojo: string, verde: string, toros: string, halcones: string, caribe: string;
  let juan: string, carlos: string, pedro: string, luis: string;
  const visibles: string[] = [];
  const ocultos: string[] = [];

  beforeAll(async () => {
    liga = (await tournament('Liga Piloto', { dataCoverage: 'PARTIAL' })).id;
    [azul, rojo, verde, toros, halcones, caribe] = [
      await team('Atlético Azul'), await team('Deportivo Rojo'), await team('Real Verde'), await team('Toros FC'), await team('Halcones'), await team('Caribe'),
    ];
    await enroll(liga, azul, rojo, verde, toros, halcones, caribe);
    await track(liga, [azul, rojo]).expect(200);
    [juan, carlos, pedro, luis] = [await player('Juan'), await player('Carlos'), await player('Pedro'), await player('Luis')];
    for (const [p, t] of [[juan, azul], [carlos, azul], [pedro, rojo], [luis, rojo]]) {
      await as(O).put(`/api/tournaments/${liga}/players/${p}`).send({ teamId: t, startDate: '2027-01-01' }).expect(200);
    }
    // Atlético: Juan 4 G · 2 A, Carlos 2 G · 1 A. Deportivo (marca 3 goles en total): Pedro 2 G · 1 A, Luis 1 G · 2 A.
    visibles.push(await play(liga, azul, verde, 3, 1, [{ playerId: juan, teamId: azul, goals: 2, assists: 1 }, { playerId: carlos, teamId: azul, goals: 1, assists: 1 }]));
    visibles.push(await play(liga, toros, azul, 2, 2, [{ playerId: juan, teamId: azul, goals: 1, assists: 1 }, { playerId: carlos, teamId: azul, goals: 1 }]));
    visibles.push(await play(liga, rojo, halcones, 2, 0, [{ playerId: pedro, teamId: rojo, goals: 2 }, { playerId: luis, teamId: rojo, assists: 2 }]));
    visibles.push(await play(liga, caribe, rojo, 1, 1, [{ playerId: luis, teamId: rojo, goals: 1 }, { playerId: pedro, teamId: rojo, assists: 1 }]));
    visibles.push(await play(liga, azul, rojo, 1, 0, [{ playerId: juan, teamId: azul, goals: 1 }, { playerId: luis, teamId: rojo }]));
    ocultos.push(await play(liga, verde, toros, 2, 1));
    ocultos.push(await play(liga, halcones, caribe, 0, 0));
  });

  it('el resumen trae solo las 2 tarjetas seguidas, con datos de SUS partidos en este torneo', async () => {
    const s = await summary(liga);
    expect(s.dataCoverage).toBe('PARTIAL');
    expect(s.trackedTeams.map((c: { team: { id: string } }) => c.team.id)).toEqual([azul, rojo]); // por nombre
    const [a, r] = s.trackedTeams;
    expect(a.record).toMatchObject({ matchesPlayed: 3, wins: 2, draws: 1, losses: 0, goalsFor: 6, goalsAgainst: 3 });
    expect(a.form).toEqual(['W', 'D', 'W']);
    expect(a.lastMatch).toMatchObject({ homeTeam: { id: azul }, awayTeam: { id: rojo }, homeScore: 1, awayScore: 0, result: 'W' });
    expect(a.topScorer).toMatchObject({ player: { id: juan }, goals: 4 });
    expect(a.topAssist).toMatchObject({ player: { id: juan }, assists: 2 });
    expect(a.squadSize).toBe(2);
    expect(r.record).toMatchObject({ matchesPlayed: 3, wins: 1, draws: 1, losses: 1, goalsFor: 3, goalsAgainst: 2 });
    expect(r.topScorer).toMatchObject({ player: { id: pedro }, goals: 2 });
    expect(r.topAssist).toMatchObject({ player: { id: luis }, assists: 2 });
    expect(r.lastMatch).toMatchObject({ result: 'L' }); // el 1–0 de Atlético desde el lado de Deportivo
    // A vs B se cuenta una vez por equipo, nunca duplicado dentro de una misma tarjeta.
    expect(a.record.matchesPlayed + r.record.matchesPlayed).toBe(6);
  });

  it('partidos entre no seguidos: existen y el admin los ve; no forman parte del seguimiento', async () => {
    const all = (await api().get(`/api/matches?tournamentId=${liga}&limit=100`).expect(200)).body.data as { id: string; homeTeamId: string; awayTeamId: string }[];
    expect(all.map((m) => m.id).sort()).toEqual([...visibles, ...ocultos].sort());
    const tracked = new Set([azul, rojo]);
    const relevant = all.filter((m) => tracked.has(m.homeTeamId) || tracked.has(m.awayTeamId)).map((m) => m.id);
    expect(relevant.sort()).toEqual([...visibles].sort());
    // Siguen siendo partidos normales: el organizador los edita.
    await as(O).patch(`/api/matches/${ocultos[1]}`).send({ venue: 'Cancha 2' }).expect(200);
  });

  it('rivales sin OWNER, sin MANAGER y sin plantilla participan y juegan', async () => {
    for (const x of [verde, toros, halcones, caribe]) {
      expect(await teamAdmins.countDocuments({ teamId: new Types.ObjectId(x) })).toBe(0);
      expect(await rosters.countDocuments({ teamId: new Types.ObjectId(x) })).toBe(0);
      expect((await api().get(`/api/teams/${x}/profile`).expect(200)).body.career.matchesPlayed).toBe(2);
    }
  });

  it('tabla, goleadores y estructura generales siguen bloqueados (409) aunque haya equipos seguidos', async () => {
    for (const p of ['standings', 'top-scorers', 'structure']) {
      expect((await api().get(`/api/tournaments/${liga}/${p}`).expect(409)).body.code).toBe('TOURNAMENT_PARTIAL_COVERAGE');
    }
  });

  it('Team Profile y Player Profile cuentan todos los partidos registrados (también los de no seguidos)', async () => {
    const p = (await api().get(`/api/teams/${azul}/profile`).expect(200)).body;
    expect(p.career).toMatchObject({ matchesPlayed: 3, goalsFor: 6, goalsAgainst: 3 });
    expect(p.topScorers.map((x: { player: { id: string }; goals: number }) => [x.player.id, x.goals])).toEqual([[juan, 4], [carlos, 2]]);
    expect(p.topAssists.map((x: { player: { id: string }; assists: number }) => [x.player.id, x.assists])).toEqual([[juan, 2], [carlos, 1]]);
    expect((await api().get(`/api/players/${juan}/profile`).expect(200)).body.career).toMatchObject({ appearances: 3, goals: 4, assists: 2 });
    expect((await api().get(`/api/players/${luis}/profile`).expect(200)).body.career).toMatchObject({ appearances: 3, goals: 1, assists: 2 });
    // Un no seguido conserva su perfil global y sus partidos.
    expect((await api().get(`/api/teams/${verde}/profile`).expect(200)).body.career).toMatchObject({ matchesPlayed: 2, wins: 1, losses: 1 });
  });

  it('cambiar [Azul, Rojo] → [Azul, Verde]: Rojo deja de aparecer, nada se borra ni se recalcula', async () => {
    const before = await snapshot(liga);
    const rojoProfile = (await api().get(`/api/teams/${rojo}/profile`).expect(200)).body;
    const pedroProfile = (await api().get(`/api/players/${pedro}/profile`).expect(200)).body;
    await track(liga, [azul, verde]).expect(200);
    const s = await summary(liga);
    expect(s.trackedTeams.map((c: { team: { id: string } }) => c.team.id)).toEqual([azul, verde]);
    expect(s.trackedTeams[1].record).toMatchObject({ matchesPlayed: 2, wins: 1, losses: 1 }); // Verde: sus partidos ya registrados
    expect(s.trackedTeams[1].squadSize).toBe(0);
    expect(await snapshot(liga)).toEqual(before);
    expect((await api().get(`/api/teams/${rojo}/profile`).expect(200)).body).toEqual(rojoProfile);
    expect((await api().get(`/api/players/${pedro}/profile`).expect(200)).body).toEqual(pedroProfile);
    await track(liga, [azul, rojo]).expect(200);
  });

  it('rendimiento: el resumen hace las mismas consultas (≤ 6) con 2 que con 6 equipos seguidos', async () => {
    const calls: string[] = [];
    mongoose.set('debug', (collection: string) => void calls.push(collection));
    await summary(liga);
    const two = calls.length;
    mongoose.set('debug', false);
    await track(liga, [azul, rojo, verde, toros, halcones, caribe]).expect(200);
    calls.length = 0;
    mongoose.set('debug', (collection: string) => void calls.push(collection));
    const s = await summary(liga);
    const six = calls.length;
    mongoose.set('debug', false);
    await track(liga, [azul, rojo]).expect(200);
    expect(s.trackedTeams).toHaveLength(6);
    expect(two).toBeGreaterThanOrEqual(4);
    expect(six).toBe(two);
    expect(six).toBeLessThanOrEqual(6);
  });

  it('privacidad: el resumen y el torneo no exponen datos internos', async () => {
    const FORBIDDEN = ['organizerId', 'writeSeq', 'createdBy', 'email', 'passwordHash', 'birthDate', 'addedBy', 'searchName', 'creationRequestId', 'userId'];
    const walk = (v: unknown): string[] =>
      Array.isArray(v) ? v.flatMap(walk) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN.includes(k) ? [k] : []), ...walk(x)]) : [];
    for (const b of [await summary(liga), (await api().get(`/api/tournaments/${liga}`).expect(200)).body]) {
      expect(walk(b)).toEqual([]);
      expect(JSON.stringify(b)).not.toContain(O.id);
    }
  });

  it('PARTIAL → FULL vacía trackedTeamIds y conserva todo; FULL → PARTIAL arranca sin seguidos', async () => {
    const t = (await tournament('Liga ida y vuelta 6G', { dataCoverage: 'PARTIAL' })).id;
    const [a, b] = [await team('IV A'), await team('IV B')];
    await enroll(t, a, b);
    await track(t, [a]).expect(200);
    await play(t, a, b, 2, 0);
    const before = await snapshot(t);
    expect((await as(O).patch(`/api/tournaments/${t}`).send({ dataCoverage: 'FULL' }).expect(200)).body.trackedTeamIds).toEqual([]);
    expect(await snapshot(t)).toEqual(before);
    expect((await tournaments.findById(t).lean())!.trackedTeamIds).toEqual([]);
    const back = (await as(O).patch(`/api/tournaments/${t}`).send({ dataCoverage: 'PARTIAL', trackedTeamIds: [b] }).expect(200)).body;
    expect(back).toMatchObject({ dataCoverage: 'PARTIAL', trackedTeamIds: [b] });
    expect(await snapshot(t)).toEqual(before);
  });
});

describe('Retirar o eliminar un equipo seguido', () => {
  it('retirar del torneo a un equipo seguido (sin partidos) lo quita también de trackedTeamIds', async () => {
    const t = (await tournament('Liga Bajas 6G', { dataCoverage: 'PARTIAL' })).id;
    const [a, b] = [await team('Baja A'), await team('Baja B')];
    await enroll(t, a, b);
    await track(t, [a, b]).expect(200);
    await as(O).delete(`/api/tournaments/${t}/teams/${b}`).expect(204);
    expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.trackedTeamIds).toEqual([a]);
    expect((await summary(t)).trackedTeams.map((c: { team: { id: string } }) => c.team.id)).toEqual([a]);
  });

  it('con partidos no se puede retirar (regla de siempre) y sigue seguido', async () => {
    const t = (await tournament('Liga Bajas 2 6G', { dataCoverage: 'PARTIAL' })).id;
    const [a, b] = [await team('Baja C'), await team('Baja D')];
    await enroll(t, a, b);
    await track(t, [a]).expect(200);
    await play(t, a, b, 1, 0);
    await as(O).delete(`/api/tournaments/${t}/teams/${a}`).expect(409);
    expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.trackedTeamIds).toEqual([a]);
  });

  it('eliminar un equipo sin historia lo quita de los torneos donde estaba seguido', async () => {
    const t = (await tournament('Liga Borrado 6G', { dataCoverage: 'PARTIAL' })).id;
    const [a, b] = [await team('Borra A'), await team('Borra B')];
    await enroll(t, a, b);
    await track(t, [a, b]).expect(200);
    await as(O).delete(`/api/teams/${b}`).expect(204);
    expect((await api().get(`/api/tournaments/${t}`).expect(200)).body.trackedTeamIds).toEqual([a]);
  });
});
