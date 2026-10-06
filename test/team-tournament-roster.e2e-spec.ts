/**
 * Plantilla del equipo EN un torneo, administrada desde el equipo (OWNER/MANAGER): ve en qué torneos
 * juega y da de alta / baja a jugadores de su plantilla global, sin pasar por el organizador pero
 * dentro de sus reglas (inscrito, no finalizado, máximo de jugadores, dorsal libre, sin robar
 * jugadores de otro equipo). API real.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { TeamAdmin } from '../src/modules/teams/schemas/team-admin.schema.js';
import { TeamAdminRole, TeamAdminSource, TeamAdminStatus } from '../src/common/enums/index.js';

let ctx: TestApp;
let http: Server;
type Acc = { id: string; token: string; email?: string };
const as = (u: Acc) => authed(http, u.token);
let O: Acc;
let admins: Model<TeamAdmin>;
let seq = 0;

async function account(name: string): Promise<Acc> {
  const email = `${name.toLowerCase()}${++seq}@club.test`;
  const res = await request(http).post('/api/auth/register').send({ firstName: name, lastName: 'Club', email, password: 'password123' }).expect(201);
  return { id: res.body.user.id, token: res.body.accessToken, email };
}
async function ownTeam(u: Acc, name = `Equipo ${++seq}`) {
  return (await as(u).post('/api/me/teams').send({ name }).expect(201)).body.id as string;
}
async function newPlayer(u: Acc, team: string) {
  const r = await as(u).post(`/api/teams/${team}/global-roster/players`).send({ firstName: 'Jugador', lastName: `N${++seq}`, position: 'FORWARD', requestId: randomUUID(), confirmNew: true }).expect(201);
  return r.body.player.id as string;
}
async function tournamentWith(...teams: string[]) {
  const t = (await as(O).post('/api/tournaments').send({ name: `Liga ${++seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2099-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
  for (const team of teams) await as(O).post(`/api/tournaments/${t}/teams/${team}`).expect(201);
  return t;
}
const put = (u: Acc, team: string, t: string, p: string, body: object = {}) => as(u).put(`/api/teams/${team}/tournaments/${t}/players/${p}`).send(body);
const del = (u: Acc, team: string, t: string, p: string) => as(u).delete(`/api/teams/${team}/tournaments/${t}/players/${p}`);
const list = async (u: Acc, team: string) => (await as(u).get(`/api/teams/${team}/tournaments`).expect(200)).body;
const publicRoster = async (t: string, team: string) => (await request(http).get(`/api/tournaments/${t}/players?teamId=${team}`).expect(200)).body as { player: { id: string }; membership: { jerseyNumber: number | null } }[];

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  admins = ctx.app.get(getModelToken(TeamAdmin.name));
  const o = await registerOrganizer(http, 'Organiza');
  O = { id: o.id, token: o.token };
});
afterAll(async () => ctx?.close());

describe('Torneos de mi equipo', () => {
  it('lista los torneos donde está inscrito (en curso primero) con su plantilla; otro usuario → 403', async () => {
    const u = await account('Dueno');
    const team = await ownTeam(u);
    const p = await newPlayer(u, team);
    const t1 = await tournamentWith(team);
    const t2 = await tournamentWith(team);
    await tournamentWith(); // donde no juega
    await put(u, team, t1, p, { jerseyNumber: 9 }).expect(200);
    await as(O).post(`/api/tournaments/${t2}/finish`).send({ allowPendingMatches: true }).expect(200);

    const body = await list(u, team);
    expect(body.tournaments.map((x: { tournament: { id: string } }) => x.tournament.id)).toEqual([t1, t2]);
    expect(body.tournaments[0]).toMatchObject({ editable: true, maxPlayers: null, players: [{ player: { id: p }, membership: { jerseyNumber: 9 } }] });
    expect(body.tournaments[1]).toMatchObject({ editable: false, players: [] });

    await as(await account('Ajeno')).get(`/api/teams/${team}/tournaments`).expect(403);
    await as(O).get(`/api/teams/${team}/tournaments`).expect(403); // organizar no da acceso al equipo
  });
});

describe('Alta y baja desde el equipo', () => {
  it('alta de un jugador de la plantilla: aparece en la plantilla pública del torneo; repetir cambia el dorsal', async () => {
    const u = await account('Alta');
    const team = await ownTeam(u);
    const p = await newPlayer(u, team);
    const t = await tournamentWith(team);
    await put(u, team, t, p).expect(200);
    expect(await publicRoster(t, team)).toMatchObject([{ player: { id: p }, membership: { jerseyNumber: null } }]);
    await put(u, team, t, p, { jerseyNumber: 7 }).expect(200);
    expect(await publicRoster(t, team)).toMatchObject([{ player: { id: p }, membership: { jerseyNumber: 7 } }]);
  });

  it('un delegado (MANAGER) también puede', async () => {
    const u = await account('Owner');
    const m = await account('Delegado');
    const team = await ownTeam(u);
    await as(u).post(`/api/teams/${team}/managers`).send({ email: m.email }).expect(201);
    const p = await newPlayer(u, team);
    const t = await tournamentWith(team);
    await put(m, team, t, p).expect(200);
    await del(m, team, t, p).expect(204);
  });

  it('reglas: no inscrito → 404, fuera de la plantilla global → 409, dorsal ocupado → 409, máximo de jugadores → 409', async () => {
    const u = await account('Reglas');
    const team = await ownTeam(u);
    const [a, b, c] = [await newPlayer(u, team), await newPlayer(u, team), await newPlayer(u, team)];
    const notEnrolled = await tournamentWith();
    expect((await put(u, team, notEnrolled, a).expect(404)).body.message).toMatch(/no está inscrito/);

    const t = await tournamentWith(team);
    await as(u).delete(`/api/teams/${team}/global-roster/${c}`).expect(204);
    expect((await put(u, team, t, c).expect(409)).body.message).toMatch(/plantilla del equipo/);

    await put(u, team, t, a, { jerseyNumber: 10 }).expect(200);
    expect((await put(u, team, t, b, { jerseyNumber: 10 }).expect(409)).body.message).toMatch(/#10/);

    await as(O).patch(`/api/tournaments/${t}/registration`).send({ maxPlayers: 1 }).expect(200);
    expect((await put(u, team, t, b).expect(409)).body.message).toMatch(/como máximo 1/);
    expect(await publicRoster(t, team)).toHaveLength(1);
  });

  it('no puede quitarle un jugador a otro equipo del torneo, ni darlo de baja allí', async () => {
    const u1 = await account('Uno');
    const u2 = await account('Dos');
    const [team1, team2] = [await ownTeam(u1), await ownTeam(u2)];
    const p = await newPlayer(u1, team1);
    await as(u2).post(`/api/teams/${team2}/global-roster`).send({ playerId: p }).expect(201); // está en las dos plantillas
    const t = await tournamentWith(team1, team2);
    await put(u1, team1, t, p).expect(200);
    expect((await put(u2, team2, t, p).expect(409)).body.message).toMatch(/ya juega con/);
    await del(u2, team2, t, p).expect(404);
    expect(await publicRoster(t, team1)).toHaveLength(1);
  });

  it('baja: cierra la participación (el historial queda) y se puede volver a dar de alta', async () => {
    const u = await account('Baja');
    const team = await ownTeam(u);
    const p = await newPlayer(u, team);
    const t = await tournamentWith(team);
    await put(u, team, t, p).expect(200);
    await del(u, team, t, p).expect(204);
    expect(await publicRoster(t, team)).toHaveLength(0);
    const history = (await request(http).get(`/api/players/${p}/memberships`).expect(200)).body;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ active: false });
    await put(u, team, t, p).expect(200);
    expect(await publicRoster(t, team)).toHaveLength(1);
  });

  it('torneo finalizado → 409; usuario ajeno y organizador → 403', async () => {
    const u = await account('Fin');
    const team = await ownTeam(u);
    const p = await newPlayer(u, team);
    const t = await tournamentWith(team);
    await put(await account('Otro'), team, t, p).expect(403);
    await put(O, team, t, p).expect(403);
    expect(await publicRoster(t, team)).toHaveLength(0); // el 403 llega antes de escribir
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    await put(u, team, t, p).expect(409);
    await del(u, team, t, p).expect(409);
  });
});

describe('Editar la ficha desde el equipo', () => {
  async function playerCreatedBy(creator: Acc) {
    const r = await as(creator).post('/api/players').send({ firstName: 'Ficha', lastName: `Ajena ${++seq}`, position: 'DEFENDER', birthDate: '2000-05-06', confirmNew: true }).expect(201);
    return r.body.id as string;
  }

  it('OWNER/MANAGER edita datos y foto de un jugador de su plantilla actual aunque lo registrara otro', async () => {
    const u = await account('Edita');
    const team = await ownTeam(u);
    const p = await playerCreatedBy(O);
    await as(u).patch(`/api/players/${p}`).send({ nickname: 'Antes' }).expect(403); // aún no está en su plantilla
    await as(u).post(`/api/teams/${team}/global-roster`).send({ playerId: p }).expect(201);

    // Sin birthDate en el cuerpo (el equipo no la conoce: es privada) → se conserva.
    const r = await as(u).patch(`/api/players/${p}`).send({ nickname: 'Rayo' }).expect(200);
    expect(r.body).toMatchObject({ nickname: 'Rayo', birthDate: '2000-05-06' });
    await as(u).delete(`/api/players/${p}/photo`).expect(200);
    await as(u).delete(`/api/players/${p}`).expect(403); // borrar la ficha sigue siendo de quien la registró
  });

  it('al salir de la plantilla, o con el rol revocado, ya no puede editarla; un ajeno nunca', async () => {
    const u = await account('Sale');
    const team = await ownTeam(u);
    const p = await playerCreatedBy(O);
    await as(u).post(`/api/teams/${team}/global-roster`).send({ playerId: p }).expect(201);
    await as(await account('Extrano')).patch(`/api/players/${p}`).send({ nickname: 'X' }).expect(403);
    await as(u).patch(`/api/players/${p}`).send({ nickname: 'Dentro' }).expect(200);
    const m = await account('Revocado');
    await as(u).post(`/api/teams/${team}/managers`).send({ email: m.email }).expect(201);
    await as(m).patch(`/api/players/${p}`).send({ nickname: 'Delegado' }).expect(200);
    await as(u).delete(`/api/teams/${team}/managers/${m.id}`).expect(204);
    await as(m).patch(`/api/players/${p}`).send({ nickname: 'Revocado' }).expect(403);
    await as(u).delete(`/api/teams/${team}/global-roster/${p}`).expect(204);
    await as(u).patch(`/api/players/${p}`).send({ nickname: 'Fuera' }).expect(403);
  });
});

describe('Editar la ficha: organizador que dio de alta un equipo sin cuenta', () => {
  it('edita a los jugadores de ese equipo (aunque otro registrara la ficha) hasta que el equipo tiene propietario', async () => {
    const other = await account('OtroOrg');
    await as(other).post('/api/me/organizer').expect(200);
    const p = (await as(other).post('/api/players').send({ firstName: 'Ficha', lastName: `DeOtro ${++seq}`, position: 'GOALKEEPER', birthDate: '1999-01-02', confirmNew: true }).expect(201)).body.id as string;
    const team = (await as(O).post('/api/teams').send({ name: `Sin cuenta ${++seq}` }).expect(201)).body.id as string;
    const t = await tournamentWith(team);

    await as(O).patch(`/api/players/${p}`).send({ nickname: 'Antes' }).expect(403); // aún no juega con su equipo
    await as(O).put(`/api/tournaments/${t}/players/${p}`).send({ teamId: team }).expect(200);

    const mine = (await as(O).get('/api/admin/players?limit=100').expect(200)).body.data.find((x: { id: string }) => x.id === p);
    expect(mine).toMatchObject({ canEdit: true });
    expect(mine.birthDate).toBeUndefined(); // la fecha sigue siendo de quien registró la ficha
    const r = await as(O).patch(`/api/players/${p}`).send({ nickname: 'Muro' }).expect(200);
    expect(r.body).toMatchObject({ nickname: 'Muro', birthDate: '1999-01-02' });
    await as(O).delete(`/api/players/${p}`).expect(403); // borrar: solo quien la registró

    // Otro organizador sin relación con el equipo: no.
    const third = await account('Tercero');
    await as(third).patch(`/api/players/${p}`).send({ nickname: 'X' }).expect(403);

    // El equipo pasa a tener cuenta (OWNER): se acaba la custodia del organizador.
    await admins.create({ teamId: new Types.ObjectId(team), userId: new Types.ObjectId(third.id), role: TeamAdminRole.OWNER, status: TeamAdminStatus.ACTIVE, source: TeamAdminSource.INTERNAL, grantedBy: null });
    await as(O).patch(`/api/players/${p}`).send({ nickname: 'Despues' }).expect(403);
    expect((await as(O).get('/api/admin/players?limit=100').expect(200)).body.data.find((x: { id: string }) => x.id === p)).toMatchObject({ canEdit: false });
  });

  it('un torneo finalizado no da permiso: la custodia cuenta solo mientras se juega', async () => {
    const other = await account('OrgFin');
    await as(other).post('/api/me/organizer').expect(200);
    const p = (await as(other).post('/api/players').send({ firstName: 'Ficha', lastName: `Fin ${++seq}`, position: 'FORWARD', confirmNew: true }).expect(201)).body.id as string;
    const team = (await as(O).post('/api/teams').send({ name: `Sin cuenta ${++seq}` }).expect(201)).body.id as string;
    const t = await tournamentWith(team);
    await as(O).put(`/api/tournaments/${t}/players/${p}`).send({ teamId: team }).expect(200);
    await as(O).patch(`/api/players/${p}`).send({ nickname: 'Jugando' }).expect(200);
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    await as(O).patch(`/api/players/${p}`).send({ nickname: 'Terminado' }).expect(403);
  });

  it('el OWNER de un equipo NO edita por jugar en un torneo: solo por su plantilla actual', async () => {
    const u = await account('SoloTorneo');
    const team = await ownTeam(u);
    const p = (await as(O).post('/api/players').send({ firstName: 'Ficha', lastName: `Org ${++seq}`, position: 'FORWARD', confirmNew: true }).expect(201)).body.id as string;
    const t = await tournamentWith(team);
    await as(O).put(`/api/tournaments/${t}/players/${p}`).send({ teamId: team }).expect(200); // lo inscribe el organizador
    await as(u).patch(`/api/players/${p}`).send({ nickname: 'X' }).expect(403);
  });
});
