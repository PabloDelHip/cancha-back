/**
 * Player Profile V1: GET /players/:id/profile (agregado público, fuente de verdad), paginación
 * de GET /players/:id/matches y privacidad de TODAS las respuestas públicas que contienen jugadores.
 * Todo contra la API real (sin frontend).
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { ageOn } from '../src/common/utils/dates.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);

type Org = Awaited<ReturnType<typeof registerOrganizer>>;
let A: Org;
let B: Org;
const as = (org: Org) => authed(http, org.token);

// ─── Helpers ────────────────────────────────────────────────────────────────

let seq = 0;
async function tournament(org: Org, startDate: string) {
  seq++;
  const res = await as(org)
    .post('/api/tournaments')
    .send({ name: `Torneo P${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate, status: 'ACTIVE' })
    .expect(201);
  return res.body.id as string;
}
async function team(org: Org, tournamentId: string, name?: string) {
  seq++;
  const id = (await as(org).post('/api/teams').send({ name: name ?? `Equipo P${seq}` }).expect(201)).body.id as string;
  await as(org).post(`/api/tournaments/${tournamentId}/teams/${id}`).expect(201);
  return id;
}
async function newPlayer(org: Org, extra: Record<string, unknown> = {}) {
  seq++;
  return (
    await as(org).post('/api/players').send({ confirmNew: true, firstName: 'Jugador', lastName: `P${seq}`, position: 'FORWARD', ...extra }).expect(201)
  ).body.id as string;
}
const registerIn = (org: Org, tournamentId: string, playerId: string, teamId: string, jerseyNumber: number) =>
  as(org).put(`/api/tournaments/${tournamentId}/players/${playerId}`).send({ teamId, jerseyNumber, startDate: '2027-01-01' }).expect(200);
async function match(org: Org, tournamentId: string, round: number, home: string, away: string, date: string) {
  return (
    await as(org)
      .post('/api/matches')
      .send({ tournamentId, round, homeTeamId: home, awayTeamId: away, date, time: '18:00' })
      .expect(201)
  ).body.id as string;
}
const line = (playerId: string, teamId: string, s: Partial<Record<'goals' | 'assists' | 'yellowCards' | 'redCards', number>> = {}, played = true) => ({
  playerId,
  teamId,
  played,
  goals: 0,
  assists: 0,
  yellowCards: 0,
  redCards: 0,
  ...s,
});
const result = (org: Org, matchId: string, homeScore: number, awayScore: number, playerStats: unknown[], status?: 'LIVE') =>
  as(org)
    .put(`/api/matches/${matchId}/result`)
    .send({ homeScore, awayScore, playerStats, ...(status ? { status } : {}) })
    .expect(200);
const profile = async (id: string) => (await api().get(`/api/players/${id}/profile`).expect(200)).body;

/** Recorre el JSON y devuelve las rutas de las claves prohibidas encontradas. */
const FORBIDDEN = ['birthDate', 'email', 'phone', 'password', 'passwordHash', 'createdBy', 'organizerId', 'searchName', 'writeSeq'];
function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(FORBIDDEN.includes(k) ? [`${path}.${k}`] : []),
    ...forbiddenKeys(v, `${path}.${k}`),
  ]);
}

// ─── Escenario: Pablo juega en tres competiciones de dos organizadores ───────

const x: Record<string, string> = {};

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Ana');
  B = await registerOrganizer(http, 'Beto');

  x.pablo = await newPlayer(A, { firstName: 'Pablo', lastName: 'Hipólito', birthDate: '2001-04-18' });
  x.fresh = await newPlayer(A, { firstName: 'Ana', lastName: 'Sin Partidos' });

  // Copa (A): Pablo con Tigres #14, 1 partido (1 gol). Después se FINALIZA.
  x.copa = await tournament(A, '2026-11-01');
  x.tigres = await team(A, x.copa, 'Tigres FC');
  x.rivalCopa = await team(A, x.copa);
  await registerIn(A, x.copa, x.pablo, x.tigres, 14);
  x.mCopa = await match(A, x.copa, 1, x.tigres, x.rivalCopa, '2026-11-07');
  await result(A, x.mCopa, 2, 1, [line(x.pablo, x.tigres, { goals: 1 })]);
  await as(A).post(`/api/tournaments/${x.copa}/finish`).send({}).expect(200);

  // Apertura (A): Pablo con Halcones #9.
  x.apertura = await tournament(A, '2027-01-10');
  x.halcones = await team(A, x.apertura, 'Halcones FC');
  x.rivalAp = await team(A, x.apertura, 'Venados del Puerto');
  await registerIn(A, x.apertura, x.pablo, x.halcones, 9);
  x.mFinished = await match(A, x.apertura, 1, x.halcones, x.rivalAp, '2027-01-16');
  await result(A, x.mFinished, 3, 1, [line(x.pablo, x.halcones, { goals: 2, yellowCards: 1 })]);
  // No cuentan: LIVE con marcador y estadísticas, programado, pospuesto, cancelado y played=false.
  x.mLive = await match(A, x.apertura, 2, x.rivalAp, x.halcones, '2027-01-23');
  await result(A, x.mLive, 0, 3, [line(x.pablo, x.halcones, { goals: 3, redCards: 1 })], 'LIVE');
  x.mScheduled = await match(A, x.apertura, 3, x.halcones, x.rivalAp, '2027-01-30');
  x.mPostponed = await match(A, x.apertura, 4, x.rivalAp, x.halcones, '2027-02-13');
  await as(A).patch(`/api/matches/${x.mPostponed}`).send({ reason: 'Motivo de prueba', status: 'POSTPONED' }).expect(200);
  x.mCancelled = await match(A, x.apertura, 5, x.halcones, x.rivalAp, '2027-02-20');
  await as(A).patch(`/api/matches/${x.mCancelled}`).send({ reason: 'Motivo de prueba', status: 'CANCELLED' }).expect(200);
  x.mBench = await match(A, x.apertura, 6, x.rivalAp, x.halcones, '2027-02-27');
  await result(A, x.mBench, 1, 1, [line(x.pablo, x.halcones, {}, false)]);

  // Liga de B: el MISMO Player, con otro equipo (#23) y otro organizador, a la vez.
  x.cancun = await tournament(B, '2027-02-01');
  x.jaguares = await team(B, x.cancun, 'Jaguares Cancún');
  x.rivalB = await team(B, x.cancun);
  await registerIn(B, x.cancun, x.pablo, x.jaguares, 23);
  x.mCancun = await match(B, x.cancun, 1, x.rivalB, x.jaguares, '2027-02-06');
  await result(B, x.mCancun, 0, 2, [line(x.pablo, x.jaguares, { goals: 1, assists: 1 })]);
});
afterAll(async () => ctx?.close());

describe('GET /players/:id/profile', () => {
  it('404 si el jugador no existe; 400 si el id no es válido', async () => {
    await api().get('/api/players/64b000000000000000000000/profile').expect(404);
    await api().get('/api/players/no-es-id/profile').expect(400);
  });

  it('jugador sin torneos: 200, todo en cero y vacío', async () => {
    const p = await profile(x.fresh);
    expect(p.player).toMatchObject({ id: x.fresh, firstName: 'Ana', age: null });
    expect(p.career).toEqual({ appearances: 0, goals: 0, assists: 0, yellowCards: 0, redCards: 0, goalsPerMatch: null, assistsPerMatch: null, competitions: 0, teams: 0, titles: 0 });
    expect(p).toMatchObject({ currentParticipations: [], competitions: [], recentMatches: [], history: [], form: [] });
  });

  it('carrera: solo partidos FINISHED y played=true (LIVE, programado, pospuesto, cancelado y banca no cuentan)', async () => {
    const p = await profile(x.pablo);
    expect(p.career).toMatchObject({ appearances: 3, goals: 4, assists: 1, yellowCards: 1, redCards: 0, goalsPerMatch: 1.33, assistsPerMatch: 0.33, competitions: 3, titles: 1 });
    // Copa: liga completa y finalizada, Tigres 1º sin empate y Pablo jugó con Tigres (y fue el único goleador).
    expect(p.honors.map((h: { type: string; tournament: { id: string } }) => [h.type, h.tournament.id])).toEqual([
      ['CHAMPION', x.copa],
      ['TOP_SCORER', x.copa],
    ]);
    const ids = p.recentMatches.map((m: { id: string }) => m.id);
    for (const excluded of [x.mLive, x.mScheduled, x.mPostponed, x.mCancelled, x.mBench]) expect(ids).not.toContain(excluded);
  });

  it('participaciones simultáneas de dos organizadores → dos actuales; la Copa FINISHED no es actual', async () => {
    const p = await profile(x.pablo);
    expect(
      p.currentParticipations.map((c: { tournament: { id: string }; team: { id: string }; jerseyNumber: number }) => [
        c.tournament.id,
        c.team.id,
        c.jerseyNumber,
      ]),
    ).toEqual([
      [x.cancun, x.jaguares, 23],
      [x.apertura, x.halcones, 9],
    ]);
    // La membership de la Copa sigue active en la base, pero el torneo terminó.
    const memberships = (await api().get(`/api/players/${x.pablo}/memberships`).expect(200)).body;
    expect(memberships.find((m: { tournamentId: string }) => m.tournamentId === x.copa).active).toBe(true);
  });

  it('competiciones: torneo → equipo(s) → stats; FINISHED queda en historia con su cierre', async () => {
    const p = await profile(x.pablo);
    const byT = Object.fromEntries(p.competitions.map((c: { tournament: { id: string } }) => [c.tournament.id, c]));
    expect(p.competitions.map((c: { tournament: { id: string } }) => c.tournament.id)).toEqual([x.cancun, x.apertura, x.copa]);
    expect(byT[x.apertura].teams).toEqual([
      expect.objectContaining({
        team: expect.objectContaining({ id: x.halcones, name: 'Halcones FC' }),
        jerseyNumber: 9,
        current: true,
        endDate: null,
        stats: { appearances: 1, goals: 2, assists: 0, yellowCards: 1, redCards: 0 },
      }),
    ]);
    expect(byT[x.copa]).toMatchObject({
      tournament: { status: 'FINISHED' },
      stats: { appearances: 1, goals: 1 },
      teams: [expect.objectContaining({ team: expect.objectContaining({ id: x.tigres }), jerseyNumber: 14, current: false })],
    });
    expect(byT[x.copa].teams[0].endDate).not.toBeNull();
    expect(byT[x.cancun].stats).toEqual({ appearances: 1, goals: 1, assists: 1, yellowCards: 0, redCards: 0 });
    expect(p.history.map((h: { year: string }) => h.year)).toEqual(['2027', '2026']);
    expect(p.history[1].participations[0]).toMatchObject({ tournament: { id: x.copa, status: 'FINISHED' }, current: false });
  });

  it('coincide con GET /players/:id/stats (global y por torneo+equipo)', async () => {
    const p = await profile(x.pablo);
    const s = (await api().get(`/api/players/${x.pablo}/stats`).expect(200)).body;
    expect(s.totals).toEqual({
      matchesPlayed: p.career.appearances,
      goals: p.career.goals,
      assists: p.career.assists,
      yellowCards: p.career.yellowCards,
      redCards: p.career.redCards,
    });
    const fromProfile = p.competitions
      .flatMap((c: { tournament: { id: string }; teams: { team: { id: string }; stats: { appearances: number; goals: number } }[] }) =>
        c.teams.filter((t) => t.stats.appearances).map((t) => `${c.tournament.id}|${t.team.id}|${t.stats.appearances}|${t.stats.goals}`),
      )
      .sort();
    const fromStats = s.byTournament
      .map((b: { tournament: { id: string }; team: { id: string }; matchesPlayed: number; goals: number }) => `${b.tournament.id}|${b.team.id}|${b.matchesPlayed}|${b.goals}`)
      .sort();
    expect(fromProfile).toEqual(fromStats);
  });

  it('partidos recientes: contexto completo para pintar, más reciente primero; forma coherente', async () => {
    const p = await profile(x.pablo);
    expect(p.recentMatches.map((m: { id: string }) => m.id)).toEqual([x.mCancun, x.mFinished, x.mCopa]);
    expect(p.recentMatches[0]).toMatchObject({
      date: '2027-02-06',
      status: 'FINISHED',
      tournament: { id: x.cancun },
      homeTeam: { id: x.rivalB },
      awayTeam: { id: x.jaguares, name: 'Jaguares Cancún' },
      homeScore: 0,
      awayScore: 2,
      playerTeamId: x.jaguares,
      result: 'W',
      stats: { goals: 1, assists: 1, yellowCards: 0, redCards: 0 },
    });
    expect(p.form).toEqual(['W', 'W', 'W']);
  });

  it('edad derivada de birthDate; nunca la fecha', async () => {
    const p = await profile(x.pablo);
    expect(p.player.age).toBe(ageOn('2001-04-18'));
    expect(p.player).not.toHaveProperty('birthDate');
  });
});

describe('Partidos recientes y paginación en base de datos', () => {
  const y: Record<string, string> = {};
  beforeAll(async () => {
    y.t = await tournament(A, '2027-03-01');
    y.home = await team(A, y.t);
    y.away = await team(A, y.t);
    y.p = await newPlayer(A);
    await registerIn(A, y.t, y.p, y.home, 10);
    // 7 partidos en orden de fechas desordenado a propósito
    const dates = ['2027-03-20', '2027-03-06', '2027-04-17', '2027-03-13', '2027-04-03', '2027-03-27', '2027-04-10'];
    for (const [i, date] of dates.entries()) {
      const m = await match(A, y.t, i + 1, y.home, y.away, date);
      await result(A, m, i, 0, i ? [line(y.p, y.home, { goals: i })] : [line(y.p, y.home)]);
      y[date] = m;
    }
  });

  it('el perfil trae los 5 más recientes, en orden', async () => {
    const p = await profile(y.p);
    expect(p.recentMatches.map((m: { date: string }) => m.date)).toEqual([
      '2027-04-17',
      '2027-04-10',
      '2027-04-03',
      '2027-03-27',
      '2027-03-20',
    ]);
    expect(p.career.appearances).toBe(7);
  });

  it('GET /players/:id/matches pagina en la base, con total y torneo embebido (forma V1 compatible)', async () => {
    const page2 = (await api().get(`/api/players/${y.p}/matches?page=2&limit=3`).expect(200)).body;
    expect(page2.meta).toMatchObject({ total: 7, page: 2, limit: 3 });
    expect(page2.data.map((r: { match: { date: string } }) => r.match.date)).toEqual(['2027-03-27', '2027-03-20', '2027-03-13']);
    expect(page2.data[0]).toMatchObject({
      isHome: true,
      result: 'W',
      tournament: { id: y.t },
      team: { id: y.home },
      opponent: { id: y.away },
      stats: { playerId: y.p },
    });
    const page3 = (await api().get(`/api/players/${y.p}/matches?page=3&limit=3`).expect(200)).body;
    expect(page3.data.map((r: { match: { date: string } }) => r.match.date)).toEqual(['2027-03-06']);
    // Solo partidos oficiales: el LIVE de Pablo no aparece en su listado.
    const pablo = (await api().get(`/api/players/${x.pablo}/matches`).expect(200)).body;
    expect(pablo.meta.total).toBe(3);
  });
});

describe('Privacidad: respuestas públicas sin datos personales ni administrativos', () => {
  it('ningún endpoint público de jugador expone birthDate, contacto, cuenta ni custodio', async () => {
    const publicUrls = [
      '/api/players?limit=100',
      `/api/players?search=pablo`,
      `/api/players/${x.pablo}`,
      `/api/players/${x.pablo}/profile`,
      `/api/players/${x.pablo}/memberships`,
      `/api/players/${x.pablo}/stats`,
      `/api/players/${x.pablo}/matches`,
      `/api/tournaments/${x.apertura}/players`,
      `/api/tournaments/${x.apertura}/top-scorers`,
      `/api/teams/${x.halcones}`,
      `/api/teams/${x.halcones}/roster`,
      `/api/teams/${x.halcones}/memberships`,
      `/api/memberships?playerId=${x.pablo}`,
      `/api/matches/${x.mFinished}`,
    ];
    for (const url of publicUrls) {
      const body = (await api().get(url).expect(200)).body;
      expect({ url, leaks: forbiddenKeys(body) }).toEqual({ url, leaks: [] });
    }
    // …y siguen trayendo lo que la UI necesita (edad en lugar de fecha).
    const list = (await api().get('/api/players?search=pablo').expect(200)).body.data;
    expect(list[0]).toMatchObject({ id: x.pablo, age: ageOn('2001-04-18') });
    const roster = (await api().get(`/api/tournaments/${x.apertura}/players`).expect(200)).body;
    expect(roster[0].player).toMatchObject({ id: x.pablo, age: ageOn('2001-04-18') });
    const one = (await api().get(`/api/players/${x.pablo}`).expect(200)).body;
    expect(one).not.toHaveProperty('currentMembership');
    expect(one.currentParticipations.map((m: { tournamentId: string }) => m.tournamentId).sort()).toEqual([x.apertura, x.cancun].sort());
  });

  it('administración: la fecha exacta solo llega al custodio de la ficha', async () => {
    const mineA = (await as(A).get('/api/admin/players?limit=100').expect(200)).body.data;
    expect(mineA.find((p: { id: string }) => p.id === x.pablo)).toMatchObject({ canEdit: true, birthDate: '2001-04-18' });
    // B usa a Pablo en su liga (con su equipo sin cuenta: puede editarlo) pero no registró la ficha: ve la edad, no la fecha.
    const mineB = (await as(B).get('/api/admin/players?limit=100').expect(200)).body.data;
    const seenByB = mineB.find((p: { id: string }) => p.id === x.pablo);
    expect(seenByB).toMatchObject({ age: ageOn('2001-04-18') });
    expect(seenByB).not.toHaveProperty('birthDate');
    // Crear/editar la ficha (custodio) sigue devolviendo la fecha para el formulario.
    const updated = await as(A).patch(`/api/players/${x.pablo}`).send({ birthDate: '2001-04-19' }).expect(200);
    expect(updated.body.birthDate).toBe('2001-04-19');
    await as(A).patch(`/api/players/${x.pablo}`).send({ birthDate: '2001-04-18' }).expect(200);
  });
});
