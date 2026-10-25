/**
 * Módulo 10C (2026-10-24): integridad histórica. Foto de nombres al finalizar (en la transacción del
 * cierre), consultas y reportes de un torneo finalizado tras renombrar equipo, jugador y liga,
 * compatibilidad con torneos sin foto, correcciones explícitas y auditadas, concurrencia, permisos,
 * privacidad y nuevas temporadas. Base en memoria (createTestApp): nunca producción.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Types, type Connection } from 'mongoose';
import { strFromU8, unzipSync } from 'fflate';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, OUT: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
const oid = (id: string) => new Types.ObjectId(id);
let seq = 0;

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const report = async (t: string, id: string, format: 'csv' | 'xlsx' | 'pdf') =>
  (await as(O).get(`/api/tournaments/${t}/reports/${id}`).query({ format }).buffer(true).parse(binary).expect(200)).body as Buffer;
const xlsxText = (b: Buffer) => Object.values(unzipSync(new Uint8Array(b))).map((v) => strFromU8(v)).join('\n');

/**
 * Liga con un torneo: Águilas gana 2-1 a Zorros (goles de «José Núñez» y «Luis Pérez»), Medios
 * inscrito, una amarilla, un cargo. Colaboradores: administrador y coordinador.
 */
async function season(opts: { finish?: boolean } = {}) {
  seq++;
  const league = (await as(O).post('/api/leagues').send({ name: `Liga Norte ${seq}` }).expect(201)).body.id as string;
  const t = (await as(O).post('/api/tournaments').send({ name: `Apertura ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE', leagueId: league }).expect(201)).body.id as string;
  const team = async (name: string, shortName: string) => {
    const id = (await as(O).post('/api/teams').send({ name, shortName }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    return id;
  };
  const A = await team(`Águilas ${seq}`, 'AGU');
  const Z = await team(`Zorros ${seq}`, 'ZOR');
  const M = await team(`Medios ${seq}`, 'MED');
  const player = async (firstName: string, lastName: string, teamId: string) => {
    const id = (await as(O).post('/api/players').send({ firstName, lastName, position: 'FORWARD', birthDate: '2011-05-01', confirmNew: true }).expect(201)).body.id as string;
    await as(O).put(`/api/tournaments/${t}/players/${id}`).send({ teamId }).expect(200);
    return id;
  };
  const pa = await player('José', `Núñez ${seq}`, A);
  const pz = await player('Luis', `Pérez ${seq}`, Z);
  for (const [u, role] of [[ADM, 'ADMIN'], [COO, 'COORDINATOR']] as const) {
    const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body.token;
    await as(u).post(`/api/invitations/${inv}/accept`).expect(200);
  }
  const m = (await as(O).post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: A, awayTeamId: Z, date: '2026-12-05', time: '10:00' }).expect(201)).body.id as string;
  await as(O).put(`/api/matches/${m}/result`).send({
    homeScore: 2,
    awayScore: 1,
    playerStats: [
      { playerId: pa, teamId: A, goals: 2, assists: 0, yellowCards: 1, redCards: 0, sendOff: null },
      { playerId: pz, teamId: Z, goals: 1, assists: 0, yellowCards: 0, redCards: 0, sendOff: null },
    ],
  }).expect(200);
  await as(O).post(`/api/tournaments/${t}/finance/entries`).send({ requestId: randomUUID(), teamId: A, kind: 'CHARGE', category: 'ENROLLMENT', amount: 20_000, concept: 'Inscripción', date: '2026-01-10' }).expect(201);
  if (opts.finish !== false) await as(O).post(`/api/tournaments/${t}/finish`).send({}).expect(200);
  return { league, t, A, Z, M, pa, pz, m, n: seq };
}
const rename = async (s: Awaited<ReturnType<typeof season>>) => {
  await as(O).patch(`/api/teams/${s.A}`).send({ name: `Águilas Renombradas ${s.n}`, shortName: 'ARE' }).expect(200);
  await as(O).patch(`/api/players/${s.pa}`).send({ firstName: 'Renombrado' }).expect(200);
  await as(O).patch(`/api/leagues/${s.league}`).send({ name: `Liga Renombrada ${s.n}` }).expect(200);
};
const identityOf = async (t: string) => (await db().collection('tournaments').findOne({ _id: oid(t) }))!.identity;

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, OUT] = await Promise.all(['DuenoHist', 'AdminHist', 'CoordHist', 'AjenoHist'].map((n) => registerOrganizer(http, n)));
});
afterAll(async () => ctx?.close());

describe('10C — foto de nombres al finalizar', () => {
  it('se toma en el cierre: liga, equipos (inscritos y con partidos) y jugadores; solo nombres deportivos; no sale en las respuestas', async () => {
    const s = await season({ finish: false });
    expect((await identityOf(s.t)) ?? null).toBeNull();
    const fin = await as(O).post(`/api/tournaments/${s.t}/finish`).send({}).expect(200);
    expect(fin.body.tournament.identity).toBeUndefined();
    const id = await identityOf(s.t);
    expect(id.leagueName).toBe(`Liga Norte ${s.n}`);
    expect(id.teams.map((x: { name: string }) => x.name).sort()).toEqual([`Medios ${s.n}`, `Zorros ${s.n}`, `Águilas ${s.n}`].sort());
    expect(id.players).toHaveLength(2);
    // Privacidad: solo nombre, apellido y apodo; nada de nacimiento, contacto, foto ni documentos.
    for (const p of id.players) expect(Object.keys(p).sort()).toEqual(['firstName', 'lastName', 'nickname', 'playerId']);
    for (const x of id.teams) expect(Object.keys(x).sort()).toEqual(['colors', 'logoUrl', 'name', 'shortName', 'teamId']);
    expect(JSON.stringify(id)).not.toMatch(/2011-05-01|birth|email|phone/i);
    // Sin datos deportivos duplicados: ni marcadores ni estadísticas.
    expect(JSON.stringify(id)).not.toMatch(/goals|score|points/i);
    expect((await as(O).get(`/api/tournaments/${s.t}`).expect(200)).body.identity).toBeUndefined();
    expect((await as(O).get(`/api/admin/tournaments/${s.t}`).expect(200)).body.identity).toBeUndefined();
  });

  it('cierres simultáneos: una sola foto; repetir el cierre no la cambia', async () => {
    const s = await season({ finish: false });
    const res = await Promise.all([O, ADM, O, ADM, O].map((u) => as(u).post(`/api/tournaments/${s.t}/finish`).send({})));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    const first = await identityOf(s.t);
    await as(O).patch(`/api/teams/${s.A}`).send({ name: 'Cambio tardío' }).expect(200);
    await as(O).post(`/api/tournaments/${s.t}/finish`).send({}).expect(409);
    const again = await identityOf(s.t);
    expect(again.takenAt).toEqual(first.takenAt);
    expect(again.teams.find((x: { teamId: Types.ObjectId }) => String(x.teamId) === s.A).name).toBe(`Águilas ${s.n}`);
  });
});

describe('10C — consultas de un torneo finalizado tras renombrar equipo, jugador y liga', () => {
  it('pantallas y API: nombres con que se jugó; identidades e ids intactos', async () => {
    const s = await season();
    await rename(s);
    const old = `Águilas ${s.n}`;
    const neu = `Águilas Renombradas ${s.n}`;
    // Las fichas cambian (la identidad es la misma, con el mismo id)…
    expect((await as(O).get(`/api/teams/${s.A}`).expect(200)).body.name).toBe(neu);
    // …pero el torneo finalizado conserva sus nombres.
    const standings = (await as(O).get(`/api/tournaments/${s.t}/standings`).expect(200)).body;
    expect(standings[0]).toMatchObject({ teamId: s.A, team: { id: s.A, name: old, shortName: 'AGU' }, points: 3 });
    const scorers = (await as(O).get(`/api/tournaments/${s.t}/top-scorers`).expect(200)).body;
    expect(scorers[0]).toMatchObject({ playerId: s.pa, goals: 2, player: { firstName: 'José' }, team: { name: old } });
    const structure = (await as(O).get(`/api/tournaments/${s.t}/structure`).expect(200)).body;
    expect(structure.teams[s.A].name).toBe(old);
    expect(structure.championTeamId).toBe(s.A);
    const teams = (await as(O).get(`/api/tournaments/${s.t}/teams`).expect(200)).body;
    expect(teams.find((x: { teamId: string }) => x.teamId === s.A).team.name).toBe(old);
    const roster = (await as(O).get(`/api/tournaments/${s.t}/players`).expect(200)).body;
    const row = roster.find((r: { player: { id: string } }) => r.player.id === s.pa);
    expect(row.player.firstName).toBe('José');
    expect(row.membership.team.name).toBe(old);
    // Historial de la liga: el campeón de esa temporada con su nombre de entonces.
    const history = (await as(O).get(`/api/leagues/${s.league}/history`).expect(200)).body;
    expect(history.champions[0].champion).toMatchObject({ id: s.A, name: old });
    expect(history.champions[0].topScorer.player.firstName).toBe('José');
    expect(history.records.biggestWin.homeTeam.name).toBe(old);
    // Perfiles: la temporada con el nombre de entonces.
    const profile = (await as(O).get(`/api/players/${s.pa}/profile`).expect(200)).body;
    expect(JSON.stringify(profile.competitions ?? profile)).toContain(old);
    const pm = (await as(O).get(`/api/players/${s.pa}/matches`).expect(200)).body.data[0];
    expect(pm.team.name).toBe(old);
    const tm = (await as(O).get(`/api/teams/${s.Z}/matches`).expect(200)).body.data[0];
    expect(tm.homeTeam.name).toBe(old);
    const stats = (await as(O).get(`/api/players/${s.pa}/stats`).expect(200)).body;
    expect(stats.byTournament[0].team.name).toBe(old);
    // Resumen del torneo finalizado (vista previa del cierre): campeón y goleador de entonces.
    const closure = (await as(O).get(`/api/tournaments/${s.t}/closure`).expect(200)).body;
    expect(closure.champion).toMatchObject({ teamId: s.A, name: old });
    expect(closure.topScorers[0]).toMatchObject({ playerId: s.pa, name: `José Núñez ${s.n}`, team: old });
    // Ficha técnica del partido e historial de plantillas.
    const sheet = (await as(O).get(`/api/matches/${s.m}/sheet`).expect(200)).body;
    expect(JSON.stringify(sheet)).toContain(old);
    expect(JSON.stringify(sheet)).not.toMatch(/Renombrad/);
    const rh = (await as(O).get(`/api/tournaments/${s.t}/roster-history`).expect(200)).body;
    expect(rh.refs.teams[s.A]).toBe(old);
    expect(rh.refs.players[s.pa]).toBe(`José Núñez ${s.n}`);
    // Disciplina y finanzas del torneo.
    const disc = (await as(O).get(`/api/tournaments/${s.t}/discipline`).expect(200)).body;
    expect(disc.refs.teams[s.A].name).toBe(old);
    expect(disc.refs.players[s.pa].firstName).toBe('José');
    const acc = (await as(O).get(`/api/tournaments/${s.t}/finance/accounts`).expect(200)).body;
    expect(acc.accounts.find((a: { teamId: string }) => a.teamId === s.A).teamName).toBe(old);
    // Partidos: ids de siempre (el front pone los nombres con GET /identity).
    const match = (await as(O).get(`/api/matches/${s.m}`).expect(200)).body;
    expect(match).toMatchObject({ homeTeamId: s.A, homeScore: 2, awayScore: 1 });
    const identity = (await request(http).get(`/api/tournaments/${s.t}/identity`).expect(200)).body;
    expect(identity).toMatchObject({ historical: true, leagueName: `Liga Norte ${s.n}`, corrections: 0 });
    expect(identity.teams.find((x: { id: string }) => x.id === s.A)).toMatchObject({ name: old, shortName: 'AGU' });
    expect(identity.players.find((x: { id: string }) => x.id === s.pa)).toEqual({ id: s.pa, firstName: 'José', lastName: `Núñez ${s.n}`, nickname: null });
    // Nada de lo renombrado aparece en el torneo finalizado.
    for (const body of [standings, scorers, structure, teams, history.champions, disc.refs, acc, identity, closure]) expect(JSON.stringify(body)).not.toMatch(/Renombrad/);
  });

  it('reportes PDF, Excel y CSV: nombres históricos, mismos totales, aviso de origen de los nombres', async () => {
    const s = await season();
    const before = new Map<string, string>();
    for (const r of ['standings', 'matches', 'players', 'rosters', 'discipline', 'finance', 'summary']) before.set(r, (await report(s.t, r, 'csv')).toString('utf8'));
    await rename(s);
    for (const r of ['standings', 'matches', 'players', 'rosters', 'discipline', 'finance', 'summary']) {
      const csv = (await report(s.t, r, 'csv')).toString('utf8');
      expect(csv).toBe(before.get(r)); // mismo contenido y totales: nada cambió por renombrar
      expect(csv).not.toMatch(/Renombrad/);
    }
    expect((await report(s.t, 'standings', 'csv')).toString('utf8')).toContain(`Águilas ${s.n}`);
    const xlsx = xlsxText(await report(s.t, 'summary', 'xlsx'));
    expect(xlsx).toContain(`Liga Norte ${s.n}`);
    expect(xlsx).toContain('tal como se jugó');
    expect(xlsx).not.toMatch(/Renombrad/);
    const pdf = await report(s.t, 'summary', 'pdf');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    // Permisos financieros sin cambios: el coordinador sigue sin acceso.
    await as(COO).get(`/api/tournaments/${s.t}/reports/finance`).query({ format: 'csv' }).expect(403);
    await as(COO).get(`/api/tournaments/${s.t}/finance/accounts`).expect(403);
  });

  it('la tabla histórica no se reordena al renombrar (desempate por nombre)', async () => {
    seq++;
    const t = (await as(O).post('/api/tournaments').send({ name: `Empate ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01', status: 'ACTIVE' }).expect(201)).body.id as string;
    const ids: string[] = [];
    for (const name of ['Alfa', 'Zeta']) {
      const id = (await as(O).post('/api/teams').send({ name: `${name} ${seq}` }).expect(201)).body.id as string;
      await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
      ids.push(id);
    }
    const m = (await as(O).post('/api/matches').send({ tournamentId: t, round: 1, homeTeamId: ids[0], awayTeamId: ids[1], date: '2026-12-05', time: '10:00' }).expect(201)).body.id;
    await as(O).put(`/api/matches/${m}/result`).send({ homeScore: 1, awayScore: 1, playerStats: [] }).expect(200);
    await as(O).post(`/api/tournaments/${t}/finish`).send({}).expect(200);
    const order = async () => (await as(O).get(`/api/tournaments/${t}/standings`).expect(200)).body.map((r: { teamId: string }) => r.teamId);
    const before = await order();
    expect(before).toEqual(ids);
    await as(O).patch(`/api/teams/${ids[0]}`).send({ name: `Zzz ${seq}` }).expect(200);
    expect(await order()).toEqual(before);
  });
});

describe('10C — torneos sin foto (finalizados antes de 10C) y datos faltantes', () => {
  it('siguen funcionando con los nombres actuales, y lo dicen', async () => {
    const s = await season();
    await db().collection('tournaments').updateOne({ _id: oid(s.t) }, { $unset: { identity: '' } });
    await rename(s);
    const neu = `Águilas Renombradas ${s.n}`;
    expect((await as(O).get(`/api/tournaments/${s.t}/standings`).expect(200)).body[0].team.name).toBe(neu);
    expect((await as(O).get(`/api/leagues/${s.league}/history`).expect(200)).body.champions[0].champion.name).toBe(neu);
    const identity = (await request(http).get(`/api/tournaments/${s.t}/identity`).expect(200)).body;
    expect(identity).toMatchObject({ status: 'FINISHED', historical: false, takenAt: null, teams: [], players: [] });
    expect(xlsxText(await report(s.t, 'summary', 'xlsx'))).toContain('Nombres actuales');
    for (const r of ['standings', 'matches', 'players', 'rosters', 'discipline', 'finance', 'summary']) await as(O).get(`/api/tournaments/${s.t}/reports/${r}`).query({ format: 'csv' }).expect(200);
    await as(O).post(`/api/tournaments/${s.t}/identity/corrections`).send({ kind: 'LEAGUE', name: 'X', reason: 'Acta oficial' }).expect(409);
  });

  it('un equipo o jugador que no está en la foto usa su nombre actual (sin romper la respuesta)', async () => {
    const s = await season();
    await db().collection('tournaments').updateOne({ _id: oid(s.t) }, { $pull: { 'identity.teams': { teamId: oid(s.Z) }, 'identity.players': { playerId: oid(s.pz) } } } as never);
    await as(O).patch(`/api/teams/${s.Z}`).send({ name: `Zorros Nuevos ${s.n}` }).expect(200);
    const standings = (await as(O).get(`/api/tournaments/${s.t}/standings`).expect(200)).body;
    expect(standings.find((r: { teamId: string }) => r.teamId === s.Z).team.name).toBe(`Zorros Nuevos ${s.n}`);
    expect(standings.find((r: { teamId: string }) => r.teamId === s.A).team.name).toBe(`Águilas ${s.n}`);
    await as(O).get(`/api/tournaments/${s.t}/top-scorers`).expect(200);
    await as(O).get(`/api/tournaments/${s.t}/reports/players`).query({ format: 'csv' }).expect(200);
  });

  it('torneos en curso y borradores: siempre nombres actuales; /identity sin datos', async () => {
    const s = await season({ finish: false });
    await rename(s);
    expect((await as(O).get(`/api/tournaments/${s.t}/standings`).expect(200)).body[0].team.name).toBe(`Águilas Renombradas ${s.n}`);
    expect((await request(http).get(`/api/tournaments/${s.t}/identity`).expect(200)).body).toMatchObject({ status: 'ACTIVE', historical: false });
  });
});

describe('10C — correcciones explícitas de nombres históricos', () => {
  it('quien puede finalizar corrige con motivo; queda auditado; la ficha del equipo no cambia', async () => {
    const s = await season();
    const body = { kind: 'TEAM', refId: s.A, name: `Águilas FC ${s.n}`, reason: 'El acta oficial dice «Águilas FC»' };
    await as(COO).post(`/api/tournaments/${s.t}/identity/corrections`).send(body).expect(403);
    await as(OUT).post(`/api/tournaments/${s.t}/identity/corrections`).send(body).expect(403);
    await request(http).post(`/api/tournaments/${s.t}/identity/corrections`).send(body).expect(401);
    await as(O).post(`/api/tournaments/${s.t}/identity/corrections`).send({ ...body, reason: 'x' }).expect(400);
    await as(O).post(`/api/tournaments/${s.t}/identity/corrections`).send({ ...body, refId: new Types.ObjectId().toHexString() }).expect(404);
    await as(O).post(`/api/tournaments/${s.t}/identity/corrections`).send({ kind: 'TEAM', refId: s.A, reason: 'Sin cambios' }).expect(400);
    await as(O).post(`/api/tournaments/${s.t}/identity/corrections`).send({ ...body, kind: 'OTRO' }).expect(400);
    const res = (await as(ADM).post(`/api/tournaments/${s.t}/identity/corrections`).send(body).expect(201)).body;
    expect(res).toMatchObject({ corrections: 1, before: { name: `Águilas ${s.n}` }, after: { name: `Águilas FC ${s.n}` } });
    await as(O).post(`/api/tournaments/${s.t}/identity/corrections`).send({ kind: 'PLAYER', refId: s.pa, firstName: 'José María', reason: 'Nombre completo en el acta' }).expect(201);
    await as(O).post(`/api/tournaments/${s.t}/identity/corrections`).send({ kind: 'LEAGUE', name: `Liga del Norte ${s.n}`, reason: 'Nombre oficial de la liga' }).expect(201);
    const audit = (await identityOf(s.t)).corrections;
    expect(audit).toHaveLength(3);
    expect(audit[0]).toMatchObject({ kind: 'TEAM', role: 'ADMIN', reason: body.reason, before: { name: `Águilas ${s.n}` } });
    expect(String(audit[0].by)).toBe(ADM.id);
    expect((await as(O).get(`/api/tournaments/${s.t}/standings`).expect(200)).body[0].team.name).toBe(`Águilas FC ${s.n}`);
    expect((await as(O).get(`/api/tournaments/${s.t}/top-scorers`).expect(200)).body[0].player.firstName).toBe('José María');
    expect((await request(http).get(`/api/tournaments/${s.t}/identity`).expect(200)).body).toMatchObject({ leagueName: `Liga del Norte ${s.n}`, corrections: 3 });
    // La ficha del equipo y los resultados no se tocan.
    expect((await as(O).get(`/api/teams/${s.A}`).expect(200)).body.name).toBe(`Águilas ${s.n}`);
    expect((await as(O).get(`/api/matches/${s.m}`).expect(200)).body).toMatchObject({ homeScore: 2, awayScore: 1 });
    // Solo en finalizados.
    const active = await season({ finish: false });
    await as(O).post(`/api/tournaments/${active.t}/identity/corrections`).send({ ...body, refId: active.A }).expect(409);
  });

  it('correcciones simultáneas: ninguna se pierde (cerrojo del torneo)', async () => {
    const s = await season();
    const res = await Promise.all(
      Array.from({ length: 5 }, (_, i) => as(O).post(`/api/tournaments/${s.t}/identity/corrections`).send({ kind: 'PLAYER', refId: s.pa, nickname: `Apodo ${i}`, reason: `Corrección número ${i}` })),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect((await identityOf(s.t)).corrections).toHaveLength(5);
  });
});

describe('10C — seguridad y aislamiento', () => {
  it('borradores ajenos ocultos; ids inválidos; nada financiero ni personal en /identity', async () => {
    const draft = (await as(OUT).post('/api/tournaments').send({ name: 'Borrador ajeno', format: 'FOOTBALL_7', category: 'Libre', startDate: '2026-01-01' }).expect(201)).body.id;
    await request(http).get(`/api/tournaments/${draft}/identity`).expect(404);
    await as(O).get(`/api/tournaments/${draft}/identity`).expect(404);
    await request(http).get('/api/tournaments/no-es-id/identity').expect(400);
    await request(http).get(`/api/tournaments/${new Types.ObjectId().toHexString()}/identity`).expect(404);
    const s = await season();
    const body = JSON.stringify((await request(http).get(`/api/tournaments/${s.t}/identity`).expect(200)).body);
    expect(body).not.toMatch(/amount|balance|due|birth|email|phone|age|photo/i);
    // Un ajeno no corrige ni crea temporadas de otro; tampoco finaliza.
    await as(OUT).post(`/api/tournaments/${s.t}/next-season`).send({ name: 'X', startDate: '2027-01-01' }).expect(403);
  });

  it('el torneo finalizado sigue protegido (partidos, plantillas, configuración)', async () => {
    const s = await season();
    await as(O).put(`/api/matches/${s.m}/result`).send({ homeScore: 0, awayScore: 0, playerStats: [] }).expect(409);
    await as(O).put(`/api/tournaments/${s.t}/players/${s.pa}`).send({ teamId: s.Z }).expect(409);
    await as(O).patch(`/api/tournaments/${s.t}`).send({ name: 'Otro nombre' }).expect(409);
    await as(ADM).post(`/api/tournaments/${s.t}/finish`).send({}).expect(409);
  });
});

describe('10C — nueva temporada e identidad de los equipos', () => {
  it('el mismo equipo juega varias temporadas sin duplicarse; cada una con sus nombres', async () => {
    const s = await season();
    const teamsBefore = await db().collection('teams').countDocuments();
    const next = (await as(O).post(`/api/tournaments/${s.t}/next-season`).send({ name: `Clausura ${s.n}`, startDate: '2026-08-01' }).expect(201)).body.tournament.id as string;
    expect(await db().collection('teams').countDocuments()).toBe(teamsBefore);
    expect(await db().collection('tournaments').findOne({ _id: oid(next) })).toMatchObject({ status: 'DRAFT', identity: null });
    await rename(s);
    const nextTeams = (await as(O).get(`/api/tournaments/${next}/teams`).expect(200)).body;
    expect(nextTeams.find((x: { teamId: string }) => x.teamId === s.A).team.name).toBe(`Águilas Renombradas ${s.n}`);
    const oldTeams = (await as(O).get(`/api/tournaments/${s.t}/teams`).expect(200)).body;
    expect(oldTeams.find((x: { teamId: string }) => x.teamId === s.A).team.name).toBe(`Águilas ${s.n}`);
    // Nada deportivo, disciplinario, de jugadores, colaboradores ni dinero en la nueva.
    for (const c of ['matches', 'rounds', 'team_memberships', 'finance_entries', 'sanctions', 'tournament_members']) expect(await db().collection(c).countDocuments({ tournamentId: oid(next) })).toBe(0);
    // El torneo anterior no cambió.
    expect((await identityOf(s.t)).teams).toHaveLength(3);
    expect((await as(O).get(`/api/tournaments/${s.t}/standings`).expect(200)).body[0]).toMatchObject({ points: 3, team: { name: `Águilas ${s.n}` } });
  });
});
