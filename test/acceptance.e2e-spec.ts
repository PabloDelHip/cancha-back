/**
 * Flujo de aceptación del MVP contra MongoDB real (replica set en memoria):
 * torneo → equipos → jugadores → partido → resultado → tabla / goleadores → perfil,
 * corrección del resultado y cambio de equipo conservando historial.
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
/** Peticiones de escritura como el organizador del torneo. */
let token = '';
const auth = () => authed(http, token);

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  token = (await registerOrganizer(http, 'Liga')).token;
});
afterAll(async () => ctx?.close());

// Ids compartidos entre pasos (los tests de este archivo se ejecutan en orden).
const ids: Record<string, string> = {};

async function createPlayer(
  firstName: string,
  lastName: string,
  position = 'FORWARD',
) {
  const res = await auth()
    .post('/api/players')
    .send({ firstName, lastName, position })
    .expect(201);
  return res.body.id as string;
}

describe('Flujo de aceptación', () => {
  it('1-3. crea torneo, equipos y los inscribe (sin duplicados)', async () => {
    const t = await auth()
      .post('/api/tournaments')
      .send({
        name: 'Liga Test 2027',
        format: 'FOOTBALL_7',
        category: 'Libre',
        startDate: '2027-01-10',
        status: 'ACTIVE',
      })
      .expect(201);
    ids.tournament = t.body.id;
    expect(t.body).toMatchObject({
      name: 'Liga Test 2027',
      format: 'FOOTBALL_7',
      status: 'ACTIVE',
      endDate: null,
    });
    expect(t.body._id).toBeUndefined();

    ids.tigres = (
      await auth().post('/api/teams').send({ name: 'Tigres FC' }).expect(201)
    ).body.id;
    ids.halcones = (
      await auth()
        .post('/api/teams')
        .send({ name: 'Halcones FC', shortName: 'HAL' })
        .expect(201)
    ).body.id;

    await auth()
      .post(`/api/tournaments/${ids.tournament}/teams/${ids.tigres}`)
      .expect(201);
    await auth()
      .post(`/api/tournaments/${ids.tournament}/teams/${ids.halcones}`)
      .expect(201);
    const dup = await auth()
      .post(`/api/tournaments/${ids.tournament}/teams/${ids.tigres}`)
      .expect(409);
    expect(dup.body.message).toMatch(/ya está inscrito/);

    const teams = await api()
      .get(`/api/tournaments/${ids.tournament}/teams`)
      .expect(200);
    expect(
      teams.body.map((e: { team: { name: string } }) => e.team.name),
    ).toEqual(['Halcones FC', 'Tigres FC']);
  });

  it('4-5. crea jugadores y los asigna a equipos (dorsal único)', async () => {
    ids.a = await createPlayer('Jugador', 'A');
    ids.b = await createPlayer('Jugador', 'B');
    ids.c = await createPlayer('Jugador', 'C');
    ids.d = await createPlayer('Jugador', 'D');

    const assign = (player: string, teamId: string, jerseyNumber: number) =>
      auth()
        .put(`/api/tournaments/${ids.tournament}/players/${player}`)
        .send({ teamId, jerseyNumber, startDate: '2027-01-01' });

    await assign(ids.a, ids.tigres, 9).expect(200);
    await assign(ids.b, ids.tigres, 10).expect(200);
    await assign(ids.c, ids.halcones, 9).expect(200);
    await assign(ids.d, ids.halcones, 11).expect(200);
    await assign(ids.d, ids.halcones, 9).expect(409); // #9 ocupado por C

    const roster = await api()
      .get(`/api/teams/${ids.tigres}/roster`)
      .expect(200);
    expect(
      roster.body.map(
        (r: { membership: { jerseyNumber: number } }) =>
          r.membership.jerseyNumber,
      ),
    ).toEqual([9, 10]);
  });

  it('6. crea el partido (valida equipos distintos e inscritos)', async () => {
    const base = {
      tournamentId: ids.tournament,
      round: 1,
      date: '2027-01-16',
      time: '19:30',
    };
    await auth()
      .post('/api/matches')
      .send({ ...base, homeTeamId: ids.tigres, awayTeamId: ids.tigres })
      .expect(400);

    const outsider = (
      await auth()
        .post('/api/teams')
        .send({ name: 'Sin Torneo FC' })
        .expect(201)
    ).body.id;
    await auth()
      .post('/api/matches')
      .send({ ...base, homeTeamId: ids.tigres, awayTeamId: outsider })
      .expect(400);
    await auth()
      .post('/api/matches')
      .send({
        ...base,
        homeTeamId: ids.tigres,
        awayTeamId: ids.halcones,
        status: 'FINISHED',
      })
      .expect(400);

    const m = await auth()
      .post('/api/matches')
      .send({ ...base, homeTeamId: ids.tigres, awayTeamId: ids.halcones })
      .expect(201);
    ids.match = m.body.id;
    expect(m.body).toMatchObject({
      status: 'SCHEDULED',
      homeScore: null,
      awayScore: null,
      date: '2027-01-16',
      time: '19:30',
    });
  });

  it('rechaza goles individuales superiores al marcador y jugadores duplicados o ajenos', async () => {
    const stat = (playerId: string, teamId: string, goals: number) => ({
      playerId,
      teamId,
      goals,
      assists: 0,
      yellowCards: 0,
      redCards: 0,
    });

    const tooMany = await auth()
      .put(`/api/matches/${ids.match}/result`)
      .send({
        homeScore: 1,
        awayScore: 0,
        playerStats: [stat(ids.a, ids.tigres, 1), stat(ids.b, ids.tigres, 1)],
      })
      .expect(400);
    expect(JSON.stringify(tooMany.body.message)).toMatch(/superan su marcador/);

    await auth()
      .put(`/api/matches/${ids.match}/result`)
      .send({
        homeScore: 3,
        awayScore: 0,
        playerStats: [stat(ids.a, ids.tigres, 1), stat(ids.a, ids.tigres, 1)],
      })
      .expect(400);

    // C es de Halcones, no de Tigres
    await auth()
      .put(`/api/matches/${ids.match}/result`)
      .send({
        homeScore: 3,
        awayScore: 0,
        playerStats: [stat(ids.c, ids.tigres, 1)],
      })
      .expect(400);

    // Nada se guardó
    const m = await api().get(`/api/matches/${ids.match}`).expect(200);
    expect(m.body).toMatchObject({
      status: 'SCHEDULED',
      homeScore: null,
      playerStats: [],
    });
  });

  it('7-9. captura Tigres 3 - 2 Halcones con goles individuales y finaliza', async () => {
    const res = await auth()
      .put(`/api/matches/${ids.match}/result`)
      .send({
        homeScore: 3,
        awayScore: 2,
        status: 'FINISHED',
        playerStats: [
          {
            playerId: ids.a,
            teamId: ids.tigres,
            goals: 2,
            assists: 0,
            yellowCards: 1,
            redCards: 0,
          },
          {
            playerId: ids.b,
            teamId: ids.tigres,
            goals: 1,
            assists: 2,
            yellowCards: 0,
            redCards: 0,
          },
          {
            playerId: ids.c,
            teamId: ids.halcones,
            goals: 1,
            assists: 0,
            yellowCards: 0,
            redCards: 0,
          },
          {
            playerId: ids.d,
            teamId: ids.halcones,
            goals: 1,
            assists: 1,
            yellowCards: 0,
            redCards: 0,
          },
        ],
      })
      .expect(200);
    expect(res.body.match).toMatchObject({
      status: 'FINISHED',
      homeScore: 3,
      awayScore: 2,
    });
    expect(res.body.playerStats).toHaveLength(4);
  });

  it('10. la tabla refleja el resultado', async () => {
    const res = await api()
      .get(`/api/tournaments/${ids.tournament}/standings`)
      .expect(200);
    const [first, second] = res.body;
    expect(first).toMatchObject({
      position: 1,
      teamId: ids.tigres,
      played: 1,
      wins: 1,
      draws: 0,
      losses: 0,
      goalsFor: 3,
      goalsAgainst: 2,
      goalDifference: 1,
      points: 3,
    });
    expect(first.team.name).toBe('Tigres FC');
    expect(second).toMatchObject({
      position: 2,
      teamId: ids.halcones,
      played: 1,
      wins: 0,
      losses: 1,
      goalsFor: 2,
      goalsAgainst: 3,
      goalDifference: -1,
      points: 0,
    });
  });

  it('11. goleadores: Jugador A con 2 goles', async () => {
    const res = await api()
      .get(`/api/tournaments/${ids.tournament}/top-scorers`)
      .expect(200);
    expect(res.body[0]).toMatchObject({
      position: 1,
      playerId: ids.a,
      teamId: ids.tigres,
      goals: 2,
      matchesPlayed: 1,
    });
    expect(res.body[0].player.lastName).toBe('A');
    expect(res.body).toHaveLength(4);
  });

  it('12. perfil de Jugador A: 1 partido, 2 goles', async () => {
    const stats = await api().get(`/api/players/${ids.a}/stats`).expect(200);
    expect(stats.body.totals).toEqual({
      matchesPlayed: 1,
      goals: 2,
      assists: 0,
      yellowCards: 1,
      redCards: 0,
    });
    expect(stats.body.byTournament[0]).toMatchObject({
      goals: 2,
      matchesPlayed: 1,
    });
    expect(stats.body.byTournament[0].team.name).toBe('Tigres FC');

    const matches = await api()
      .get(`/api/players/${ids.a}/matches`)
      .expect(200);
    expect(matches.body.data[0]).toMatchObject({
      isHome: true,
      result: 'W',
      stats: { goals: 2 },
    });
    expect(matches.body.data[0].opponent.name).toBe('Halcones FC');

    const player = await api().get(`/api/players/${ids.a}`).expect(200);
    // Participaciones actuales en plural (el singular `currentMembership` se retiró).
    expect(player.body).not.toHaveProperty('currentMembership');
    expect(player.body.currentParticipations).toHaveLength(1);
    expect(player.body.currentParticipations[0]).toMatchObject({
      teamId: ids.tigres,
      jerseyNumber: 9,
      active: true,
    });
    expect(player.body).not.toHaveProperty('totalGoals');
  });

  it('13. corrige 3-2 → 2-2: todo se recalcula sin duplicados', async () => {
    await auth()
      .put(`/api/matches/${ids.match}/result`)
      .send({
        homeScore: 2,
        awayScore: 2,
        playerStats: [
          {
            playerId: ids.a,
            teamId: ids.tigres,
            goals: 1,
            assists: 0,
            yellowCards: 1,
            redCards: 0,
          },
          {
            playerId: ids.b,
            teamId: ids.tigres,
            goals: 1,
            assists: 1,
            yellowCards: 0,
            redCards: 0,
          },
          {
            playerId: ids.c,
            teamId: ids.halcones,
            goals: 1,
            assists: 0,
            yellowCards: 0,
            redCards: 0,
          },
          {
            playerId: ids.d,
            teamId: ids.halcones,
            goals: 1,
            assists: 1,
            yellowCards: 0,
            redCards: 0,
          },
        ],
      })
      .expect(200);

    const stats = await api()
      .get(`/api/matches/${ids.match}/stats`)
      .expect(200);
    expect(stats.body).toHaveLength(4); // reemplazadas, no acumuladas

    const table = await api()
      .get(`/api/tournaments/${ids.tournament}/standings`)
      .expect(200);
    for (const row of table.body)
      expect(row).toMatchObject({
        played: 1,
        draws: 1,
        points: 1,
        goalsFor: 2,
        goalsAgainst: 2,
        goalDifference: 0,
      });

    const a = await api().get(`/api/players/${ids.a}/stats`).expect(200);
    expect(a.body.totals).toMatchObject({ matchesPlayed: 1, goals: 1 });

    const scorers = await api()
      .get(`/api/tournaments/${ids.tournament}/top-scorers`)
      .expect(200);
    expect(scorers.body.every((s: { goals: number }) => s.goals === 1)).toBe(
      true,
    );
  });

  it('14. cambio de equipo: el historial conserva el equipo con el que jugó', async () => {
    const history = await auth()
      .put(`/api/tournaments/${ids.tournament}/players/${ids.a}`)
      .send({ teamId: ids.halcones, jerseyNumber: 7, startDate: '2027-02-01' })
      .expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body[0]).toMatchObject({
      teamId: ids.halcones,
      active: true,
      startDate: '2027-02-01',
      endDate: null,
    });
    expect(history.body[1]).toMatchObject({
      teamId: ids.tigres,
      active: false,
      startDate: '2027-01-01',
      endDate: '2027-02-01',
    });

    const stats = await api().get(`/api/players/${ids.a}/stats`).expect(200);
    expect(stats.body.byTournament[0].team.name).toBe('Tigres FC');
    const scorers = await api()
      .get(`/api/tournaments/${ids.tournament}/top-scorers`)
      .expect(200);
    expect(
      scorers.body.find((s: { playerId: string }) => s.playerId === ids.a).team
        .name,
    ).toBe('Tigres FC');

    const tigres = await api()
      .get(`/api/teams/${ids.tigres}/roster`)
      .expect(200);
    expect(
      tigres.body.map((r: { player: { id: string } }) => r.player.id),
    ).not.toContain(ids.a);
    const halcones = await api().get(`/api/teams/${ids.halcones}`).expect(200);
    // Plantillas actuales agrupadas por torneo (el `roster` sin contexto se retiró).
    expect(halcones.body).not.toHaveProperty('roster');
    expect(halcones.body.currentRosters).toHaveLength(1);
    expect(halcones.body.currentRosters[0].tournament.id).toBe(ids.tournament);
    expect(
      halcones.body.currentRosters[0].players.map((r: { player: { id: string } }) => r.player.id),
    ).toContain(ids.a);

    // Se puede recapturar el partido antiguo: A pertenecía a Tigres en esa fecha.
    await auth()
      .put(`/api/matches/${ids.match}/result`)
      .send({
        homeScore: 2,
        awayScore: 2,
        playerStats: [
          {
            playerId: ids.a,
            teamId: ids.tigres,
            goals: 2,
            assists: 0,
            yellowCards: 0,
            redCards: 0,
          },
        ],
      })
      .expect(200);
  });
});

describe('Integridad y validación', () => {
  it('protege eliminaciones que destruirían historia', async () => {
    await auth().delete(`/api/players/${ids.a}`).expect(409);
    await auth().delete(`/api/teams/${ids.tigres}`).expect(409);
    await auth().delete(`/api/tournaments/${ids.tournament}`).expect(409);
    await auth().delete(`/api/matches/${ids.match}`).expect(409);
    await auth()
      .delete(`/api/tournaments/${ids.tournament}/teams/${ids.tigres}`)
      .expect(409);

    const loose = await createPlayer('Sin', 'Partidos');
    await auth().delete(`/api/players/${loose}`).expect(204);
    await api().get(`/api/players/${loose}`).expect(404);
  });

  it('valida entradas: ObjectId, enums, fechas, campos extra y paginación', async () => {
    await api().get('/api/players/no-es-un-id').expect(400);
    await api().get('/api/players/64b000000000000000000000').expect(404);
    await auth()
      .post('/api/players')
      .send({ firstName: 'X', lastName: 'Y', position: 'STRIKER' })
      .expect(400);
    await auth()
      .post('/api/players')
      .send({
        firstName: 'X',
        lastName: 'Y',
        position: 'FORWARD',
        birthDate: '2001-02-30',
      })
      .expect(400);
    await auth()
      .post('/api/players')
      .send({
        firstName: 'X',
        lastName: 'Y',
        position: 'FORWARD',
        totalGoals: 99,
      })
      .expect(400);
    await api().get('/api/players?limit=500').expect(400);

    const page = await api().get('/api/players?limit=2&page=2').expect(200);
    expect(page.body.meta).toMatchObject({
      page: 2,
      limit: 2,
      total: 4,
      totalPages: 2,
    });
  });

  it('busca jugadores sin distinguir acentos', async () => {
    await createPlayer('Pablo', 'Hipólito');
    const res = await api().get('/api/players?search=hipolito').expect(200);
    expect(res.body.data.map((p: { lastName: string }) => p.lastName)).toEqual([
      'Hipólito',
    ]);
  });

  it('health comprueba MongoDB', async () => {
    await api()
      .get('/api/health')
      .expect(200, { status: 'ok', database: 'up' });
  });
});
