/**
 * Autorización por ownership: dos organizadores con un torneo cada uno.
 * Conocer un ObjectId ajeno nunca permite modificar el recurso.
 */
import request from 'supertest';
import {
  authed,
  createTestApp,
  registerOrganizer,
  type Server,
  type TestApp,
} from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);

type Org = Awaited<ReturnType<typeof registerOrganizer>>;
interface League {
  org: Org;
  tournament: string;
  home: string;
  away: string;
  homePlayer: string;
  awayPlayer: string;
  match: string;
}

let A: League;
let B: League;
const as = (league: League) => authed(http, league.org.token);

/** Crea torneo + 2 equipos inscritos + 1 jugador por equipo + 1 partido, todo como `org`. */
async function buildLeague(name: string): Promise<League> {
  const org = await registerOrganizer(http, name);
  const w = authed(http, org.token);
  const tournament = (
    await w
      .post('/api/tournaments')
      .send({
        name: `Liga ${name}`,
        format: 'FOOTBALL_7',
        category: 'Libre',
        startDate: '2027-01-01',
        status: 'ACTIVE',
      })
      .expect(201)
  ).body;
  // organizerId ya no se expone: se comprueba por "mis torneos".
  const mine = await w.get('/api/admin/tournaments').expect(200);
  expect(mine.body.data.map((t: { id: string }) => t.id)).toContain(tournament.id);
  expect(tournament).not.toHaveProperty('organizerId');

  const team = async (suffix: string) =>
    (
      await w
        .post('/api/teams')
        .send({ name: `${name} ${suffix}` })
        .expect(201)
    ).body.id as string;
  const home = await team('Local');
  const away = await team('Visita');
  await w.post(`/api/tournaments/${tournament.id}/teams/${home}`).expect(201);
  await w.post(`/api/tournaments/${tournament.id}/teams/${away}`).expect(201);

  const player = async (teamId: string, n: number) => {
    const id = (
      await w
        .post('/api/players')
        .send({ firstName: name, lastName: `J${n}`, position: 'FORWARD' })
        .expect(201)
    ).body.id as string;
    await w
      .put(`/api/tournaments/${tournament.id}/players/${id}`)
      .send({ teamId, jerseyNumber: n, startDate: '2027-01-01' })
      .expect(200);
    return id;
  };
  const homePlayer = await player(home, 9);
  const awayPlayer = await player(away, 10);

  const match = (
    await w
      .post('/api/matches')
      .send({
        tournamentId: tournament.id,
        round: 1,
        homeTeamId: home,
        awayTeamId: away,
        date: '2027-01-10',
        time: '18:00',
      })
      .expect(201)
  ).body.id as string;

  return {
    org,
    tournament: tournament.id,
    home,
    away,
    homePlayer,
    awayPlayer,
    match,
  };
}

const result = (l: League, homeScore = 1, awayScore = 0) => ({
  homeScore,
  awayScore,
  playerStats: [
    {
      playerId: l.homePlayer,
      teamId: l.home,
      goals: homeScore,
      assists: 0,
      yellowCards: 0,
      redCards: 0,
    },
  ],
});

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await buildLeague('Pablo');
  B = await buildLeague('Carlos');
});
afterAll(async () => ctx?.close());

describe('Torneos', () => {
  it('cada organizador edita su torneo y recibe 403 en el ajeno', async () => {
    await as(A)
      .patch(`/api/tournaments/${A.tournament}`)
      .send({ category: 'Varonil' })
      .expect(200);
    await as(A)
      .patch(`/api/tournaments/${B.tournament}`)
      .send({ name: 'Hackeada' })
      .expect(403);
    await as(B)
      .patch(`/api/tournaments/${B.tournament}`)
      .send({ category: 'Libre B' })
      .expect(200);
    await as(B)
      .patch(`/api/tournaments/${A.tournament}`)
      .send({ name: 'Hackeada' })
      .expect(403);
    await as(A).delete(`/api/tournaments/${B.tournament}`).expect(403);

    const b = await api().get(`/api/tournaments/${B.tournament}`).expect(200);
    expect(b.body.name).toBe('Liga Carlos');
  });

  it('organizerId lo pone el backend: enviarlo desde el cliente se rechaza', async () => {
    await as(A)
      .post('/api/tournaments')
      .send({
        name: 'Suplantada',
        format: 'FOOTBALL_7',
        category: 'X',
        startDate: '2027-01-01',
        organizerId: B.org.id,
      })
      .expect(400);
    await as(A)
      .patch(`/api/tournaments/${A.tournament}`)
      .send({ organizerId: B.org.id })
      .expect(400);
  });

  it('/admin/tournaments devuelve solo los torneos propios', async () => {
    const mine = await as(A).get('/api/admin/tournaments').expect(200);
    expect(mine.body.data.map((t: { id: string }) => t.id)).toEqual([
      A.tournament,
    ]);
    const all = await api().get('/api/tournaments').expect(200);
    expect(all.body.meta.total).toBe(2);
  });

  it('inscripciones de un torneo ajeno → 403', async () => {
    await as(A)
      .post(`/api/tournaments/${B.tournament}/teams/${A.home}`)
      .expect(403);
    await as(A)
      .delete(`/api/tournaments/${B.tournament}/teams/${B.home}`)
      .expect(403);
  });
});

describe('Partidos y resultados', () => {
  it('no se programan partidos en torneos ajenos', async () => {
    await as(A)
      .post('/api/matches')
      .send({
        tournamentId: B.tournament,
        round: 2,
        homeTeamId: B.home,
        awayTeamId: B.away,
        date: '2027-01-17',
        time: '18:00',
      })
      .expect(403);
  });

  it('editar, borrar o mover un partido ajeno → 403', async () => {
    await as(A)
      .patch(`/api/matches/${B.match}`)
      .send({ time: '20:00' })
      .expect(403);
    await as(A)
      .patch(`/api/matches/${B.match}`)
      .send({ status: 'CANCELLED' })
      .expect(403);
    await as(A).delete(`/api/matches/${B.match}`).expect(403);
    // Mover mi partido al torneo de otro también exige ser dueño del destino.
    await as(A)
      .patch(`/api/matches/${A.match}`)
      .send({ tournamentId: B.tournament })
      .expect(403);
    await as(A)
      .patch(`/api/matches/${A.match}`)
      .send({ time: '19:30' })
      .expect(200);
  });

  it('capturar resultado: solo el organizador del torneo del partido', async () => {
    await as(A)
      .put(`/api/matches/${B.match}/result`)
      .send(result(B))
      .expect(403);
    await as(B)
      .put(`/api/matches/${A.match}/result`)
      .send(result(A))
      .expect(403);
    await as(A)
      .put(`/api/matches/${A.match}/result`)
      .send(result(A, 2, 0))
      .expect(200);
    await as(B)
      .put(`/api/matches/${B.match}/result`)
      .send(result(B, 1, 0))
      .expect(200);

    // Un intento ajeno no alteró nada.
    const a = await api().get(`/api/matches/${A.match}`).expect(200);
    expect(a.body).toMatchObject({
      homeScore: 2,
      awayScore: 0,
      status: 'FINISHED',
    });
    expect(a.body.playerStats).toHaveLength(1);
  });

  it('corregir el resultado ajeno ya capturado → 403', async () => {
    await as(A)
      .put(`/api/matches/${B.match}/result`)
      .send(result(B, 5, 0))
      .expect(403);
    const b = await api().get(`/api/matches/${B.match}`).expect(200);
    expect(b.body.homeScore).toBe(1);
  });
});

describe('Equipos y jugadores (globales)', () => {
  it('solo quien registró la ficha puede editarla o borrarla', async () => {
    await as(A)
      .patch(`/api/teams/${B.home}`)
      .send({ name: 'Renombrado' })
      .expect(403);
    await as(A).delete(`/api/teams/${B.home}`).expect(403);
    await as(A)
      .patch(`/api/players/${B.homePlayer}`)
      .send({ lastName: 'Cambiado' })
      .expect(403);
    await as(A).delete(`/api/players/${B.homePlayer}`).expect(403);
    await as(B)
      .patch(`/api/teams/${B.home}`)
      .send({ city: 'Mazatlán' })
      .expect(200);
  });

  it('no se pueden registrar, mover ni dar de baja jugadores en el torneo de otro', async () => {
    await as(A)
      .put(`/api/tournaments/${B.tournament}/players/${B.homePlayer}`)
      .send({ teamId: B.away, jerseyNumber: 30 })
      .expect(403);
    await as(A)
      .put(`/api/tournaments/${B.tournament}/players/${A.homePlayer}`)
      .send({ teamId: B.home, jerseyNumber: 30 })
      .expect(403);
    await as(A)
      .delete(`/api/tournaments/${B.tournament}/players/${B.homePlayer}`)
      .expect(403);
    const roster = await api().get(`/api/teams/${B.home}/roster`).expect(200);
    expect(
      roster.body.map((r: { player: { id: string } }) => r.player.id),
    ).toEqual([B.homePlayer]);
  });

  it('un equipo global puede participar en el torneo de otro organizador', async () => {
    // A inscribe el equipo de B en SU torneo, registra a su jugador (identidad global) y
    // captura un partido con él. La participación de ese jugador en el torneo de B no cambia.
    await as(A)
      .post(`/api/tournaments/${A.tournament}/teams/${B.home}`)
      .expect(201);
    await as(A)
      .put(`/api/tournaments/${A.tournament}/players/${B.homePlayer}`)
      .send({ teamId: B.home, jerseyNumber: 9 })
      .expect(200);
    const friendly = (
      await as(A)
        .post('/api/matches')
        .send({
          tournamentId: A.tournament,
          round: 2,
          homeTeamId: A.home,
          awayTeamId: B.home,
          date: '2027-02-01',
          time: '18:00',
        })
        .expect(201)
    ).body.id;
    await as(A)
      .put(`/api/matches/${friendly}/result`)
      .send({
        homeScore: 0,
        awayScore: 1,
        playerStats: [
          {
            playerId: B.homePlayer,
            teamId: B.home,
            goals: 1,
            assists: 0,
            yellowCards: 0,
            redCards: 0,
          },
        ],
      })
      .expect(200);

    // El historial del jugador de B acumula ambos torneos.
    const stats = await api()
      .get(`/api/players/${B.homePlayer}/stats`)
      .expect(200);
    expect(stats.body.totals).toMatchObject({ matchesPlayed: 2, goals: 2 });
    expect(
      stats.body.byTournament
        .map((t: { tournament: { name: string } }) => t.tournament.name)
        .sort(),
    ).toEqual(['Liga Carlos', 'Liga Pablo']);

    // Sigue activo en el torneo de B con su equipo: A no lo "robó".
    const bRoster = await api()
      .get(`/api/tournaments/${B.tournament}/players?teamId=${B.home}`)
      .expect(200);
    expect(bRoster.body.map((r: { player: { id: string } }) => r.player.id)).toContain(B.homePlayer);
  });
});

describe('Sin autenticación', () => {
  it('toda escritura → 401', async () => {
    await api().post('/api/tournaments').send({}).expect(401);
    await api()
      .patch(`/api/tournaments/${A.tournament}`)
      .send({ name: 'x' })
      .expect(401);
    await api().delete(`/api/tournaments/${A.tournament}`).expect(401);
    await api()
      .post(`/api/tournaments/${A.tournament}/teams/${B.home}`)
      .expect(401);
    await api().post('/api/teams').send({ name: 'x' }).expect(401);
    await api()
      .patch(`/api/players/${A.homePlayer}`)
      .send({ lastName: 'x' })
      .expect(401);
    await api()
      .put(`/api/tournaments/${A.tournament}/players/${A.homePlayer}`)
      .send({ teamId: A.home })
      .expect(401);
    await api()
      .patch(`/api/matches/${A.match}`)
      .send({ time: '10:00' })
      .expect(401);
    await api()
      .put(`/api/matches/${A.match}/result`)
      .send(result(A))
      .expect(401);
    await api().delete(`/api/matches/${A.match}`).expect(401);
    await api().get('/api/admin/tournaments').expect(401);
  });

  it('la lectura pública sigue funcionando sin cuenta', async () => {
    const paths = [
      '/api/health',
      '/api/tournaments',
      `/api/tournaments/${A.tournament}`,
      `/api/tournaments/${A.tournament}/standings`,
      `/api/tournaments/${A.tournament}/top-scorers`,
      `/api/tournaments/${A.tournament}/matches`,
      `/api/tournaments/${A.tournament}/teams`,
      '/api/teams',
      `/api/teams/${A.home}`,
      '/api/players?search=pablo',
      `/api/players/${A.homePlayer}`,
      `/api/players/${A.homePlayer}/stats`,
      `/api/players/${A.homePlayer}/matches`,
      '/api/matches',
      `/api/matches/${A.match}`,
      '/api/player-match-stats',
      '/api/memberships',
      '/api/tournament-teams',
    ];
    for (const path of paths) await api().get(path).expect(200);
  });

  it('un recurso inexistente sigue siendo 404 (no 403)', async () => {
    await as(A)
      .patch('/api/tournaments/64b000000000000000000000')
      .send({ name: 'x' })
      .expect(404);
  });
});
