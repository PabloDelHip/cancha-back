/**
 * Identidad global de Player y Team entre organizadores.
 *
 * A crea a Juan Pérez (Player) y a Halcones FC (Team) y los usa en su liga.
 * B organiza la Copa Cancún y reutiliza ambas identidades sin duplicarlas, sin poder editar
 * sus fichas maestras y sin tocar nada de lo que administra A.
 */
import request from 'supertest';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
const api = () => request(http);

type Org = Awaited<ReturnType<typeof registerOrganizer>>;
let A: Org;
let B: Org;
const as = (org: Org) => authed(http, org.token);

const ids: Record<string, string> = {};

async function tournament(org: Org, name: string) {
  const res = await as(org)
    .post('/api/tournaments')
    .send({ name, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE' })
    .expect(201);
  return res.body.id as string;
}
async function team(org: Org, name: string, tournamentId: string) {
  const id = (await as(org).post('/api/teams').send({ name }).expect(201)).body.id as string;
  await as(org).post(`/api/tournaments/${tournamentId}/teams/${id}`).expect(201);
  return id;
}
async function player(org: Org, firstName: string, lastName: string) {
  return (await as(org).post('/api/players').send({ confirmNew: true, firstName, lastName, position: 'FORWARD' }).expect(201)).body
    .id as string;
}
const register = (org: Org, tournamentId: string, playerId: string, teamId: string, jerseyNumber: number) =>
  as(org).put(`/api/tournaments/${tournamentId}/players/${playerId}`).send({ teamId, jerseyNumber });

async function playedMatch(org: Org, tournamentId: string, home: string, away: string, scorer: string, goals: number) {
  const match = (
    await as(org)
      .post('/api/matches')
      .send({ tournamentId, round: 1, homeTeamId: home, awayTeamId: away, date: '2027-02-06', time: '18:00' })
      .expect(201)
  ).body.id as string;
  await as(org)
    .put(`/api/matches/${match}/result`)
    .send({
      homeScore: goals,
      awayScore: 0,
      playerStats: [{ playerId: scorer, teamId: home, goals, assists: 0, yellowCards: 0, redCards: 0 }],
    })
    .expect(200);
  return match;
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  A = await registerOrganizer(http, 'Pablo');
  B = await registerOrganizer(http, 'Carlos');

  // Contexto de A: su liga con Tigres FC y Juan Pérez, un partido jugado (Juan marca 2).
  ids.ligaA = await tournament(A, 'Liga Mazatlán');
  ids.tigres = await team(A, 'Tigres FC', ids.ligaA);
  ids.rivalA = await team(A, 'Atlas FC', ids.ligaA);
  ids.juan = await player(A, 'Juan', 'Pérez');
  await register(A, ids.ligaA, ids.juan, ids.tigres, 9).expect(200);
  ids.matchA = await playedMatch(A, ids.ligaA, ids.tigres, ids.rivalA, ids.juan, 2);
  ids.halcones = (await as(A).post('/api/teams').send({ name: 'Halcones FC' }).expect(201)).body.id;

  // Contexto de B: su copa con Tiburones.
  ids.copaB = await tournament(B, 'Copa Cancún');
  ids.tiburones = await team(B, 'Tiburones', ids.copaB);
});
afterAll(async () => ctx?.close());

describe('Player global', () => {
  it('1. A crea a Juan Pérez; la ficha no expone quién la creó', async () => {
    const res = await api().get(`/api/players/${ids.juan}`).expect(200);
    expect(res.body).toMatchObject({ firstName: 'Juan', lastName: 'Pérez' });
    expect(res.body).not.toHaveProperty('createdBy');
  });

  it('2. B encuentra a Juan Pérez con la búsqueda (sin acentos)', async () => {
    const res = await as(B).get('/api/players?search=juan perez').expect(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([ids.juan]);
  });

  it('3. B registra a Juan en SU torneo y captura un partido con él', async () => {
    await register(B, ids.copaB, ids.juan, ids.tiburones, 10).expect(200);
    ids.rivalB = await team(B, 'Mayas FC', ids.copaB);
    ids.matchB = await playedMatch(B, ids.copaB, ids.tiburones, ids.rivalB, ids.juan, 1);
  });

  it('4. B puede editar la ficha de Juan (juega con Tiburones, su equipo sin cuenta) pero NO borrarla', async () => {
    // Regla 2026-10-04: el organizador custodio de un equipo sin propietario edita a sus jugadores.
    await as(B).patch(`/api/players/${ids.juan}`).send({ nickname: 'Juancho' }).expect(200);
    await as(B).patch(`/api/players/${ids.juan}`).send({ nickname: null }).expect(200);
    await as(B).delete(`/api/players/${ids.juan}`).expect(403);
    const res = await api().get(`/api/players/${ids.juan}`).expect(200);
    expect(res.body.lastName).toBe('Pérez');
  });

  it('5. B NO puede modificar partidos, resultados ni estadísticas de A', async () => {
    await as(B)
      .put(`/api/matches/${ids.matchA}/result`)
      .send({
        homeScore: 5,
        awayScore: 0,
        playerStats: [{ playerId: ids.juan, teamId: ids.tigres, goals: 5, assists: 0, yellowCards: 0, redCards: 0 }],
      })
      .expect(403);
    await as(B).patch(`/api/matches/${ids.matchA}`).send({ reason: 'Motivo de prueba', status: 'CANCELLED' }).expect(403);
    const stats = await api().get(`/api/matches/${ids.matchA}/stats`).expect(200);
    expect(stats.body).toEqual([expect.objectContaining({ playerId: ids.juan, goals: 2 })]);
  });

  it('B NO puede cerrar ni cambiar la participación de Juan en el torneo de A', async () => {
    await as(B).delete(`/api/tournaments/${ids.ligaA}/players/${ids.juan}`).expect(403);
    await register(B, ids.ligaA, ids.juan, ids.tigres, 99).expect(403);
    // Y A no puede borrar la ficha: Juan ya participa en un torneo de B.
    await as(A).delete(`/api/players/${ids.juan}`).expect(409);
  });
});

describe('Team global', () => {
  it('6-7. A crea Halcones FC y B lo inscribe en SU torneo sin duplicarlo', async () => {
    await as(B).post(`/api/tournaments/${ids.copaB}/teams/${ids.halcones}`).expect(201);
    const teams = await api().get(`/api/tournaments/${ids.copaB}/teams`).expect(200);
    expect(teams.body.map((e: { teamId: string }) => e.teamId)).toContain(ids.halcones);
    const search = await api().get('/api/teams?search=halcones').expect(200);
    expect(search.body.meta.total).toBe(1);
  });

  it('8. B NO puede editar ni borrar la ficha maestra de Halcones FC', async () => {
    await as(B).patch(`/api/teams/${ids.halcones}`).send({ name: 'Halcones B' }).expect(403);
    await as(B).delete(`/api/teams/${ids.halcones}`).expect(403);
    // A tampoco puede borrarlo ya: está inscrito en un torneo de B.
    await as(A).delete(`/api/teams/${ids.halcones}`).expect(409);
  });
});

describe('Historial y listas', () => {
  it('9. Juan conserva el historial de ambos contextos, activo en los dos torneos a la vez', async () => {
    const profile = await api().get(`/api/players/${ids.juan}`).expect(200);
    const active = profile.body.memberships.filter((m: { active: boolean }) => m.active);
    expect(active.map((m: { tournament: { name: string }; team: { name: string }; jerseyNumber: number }) =>
      `${m.tournament.name}|${m.team.name}|${m.jerseyNumber}`).sort()).toEqual([
      'Copa Cancún|Tiburones|10',
      'Liga Mazatlán|Tigres FC|9',
    ]);

    const stats = await api().get(`/api/players/${ids.juan}/stats`).expect(200);
    expect(stats.body.totals).toMatchObject({ matchesPlayed: 2, goals: 3 });
    expect(stats.body.byTournament.map((t: { tournament: { name: string }; team: { name: string } }) =>
      `${t.tournament.name}|${t.team.name}`).sort()).toEqual(['Copa Cancún|Tiburones', 'Liga Mazatlán|Tigres FC']);

    const rosterA = await api().get(`/api/tournaments/${ids.ligaA}/players?teamId=${ids.tigres}`).expect(200);
    expect(rosterA.body.map((r: { player: { id: string } }) => r.player.id)).toEqual([ids.juan]);
  });

  it('10. reutilizar la identidad no crea duplicados', async () => {
    const res = await api().get('/api/players?search=juan perez').expect(200);
    expect(res.body.meta.total).toBe(1);
  });

  it('11. A y B tienen torneos independientes', async () => {
    const mineA = await as(A).get('/api/admin/tournaments').expect(200);
    const mineB = await as(B).get('/api/admin/tournaments').expect(200);
    expect(mineA.body.data.map((t: { name: string }) => t.name)).toEqual(['Liga Mazatlán']);
    expect(mineB.body.data.map((t: { name: string }) => t.name)).toEqual(['Copa Cancún']);
    await as(B).patch(`/api/tournaments/${ids.ligaA}`).send({ name: 'x' }).expect(403);
  });

  it('12. las listas del panel incluyen participantes de mis torneos aunque los haya creado otro', async () => {
    const playersB = await as(B).get('/api/admin/players').expect(200);
    expect(playersB.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ids.juan, canEdit: true })]), // juega con Tiburones (custodia de B)
    );
    const teamsB = await as(B).get('/api/admin/teams').expect(200);
    const byId = new Map(teamsB.body.data.map((t: { id: string; canEdit: boolean }) => [t.id, t.canEdit]));
    expect(byId.get(ids.halcones)).toBe(false);
    expect(byId.get(ids.tiburones)).toBe(true);
    expect(byId.has(ids.tigres)).toBe(false); // Tigres no juega en torneos de B

    const playersA = await as(A).get('/api/admin/players').expect(200);
    expect(playersA.body.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ids.juan, canEdit: true })]),
    );
    for (const item of [...playersB.body.data, ...teamsB.body.data]) expect(item).not.toHaveProperty('createdBy');
  });
});
