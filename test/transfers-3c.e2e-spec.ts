/**
 * Módulo 3C (2026-10-16): transferencias de jugadores entre equipos de un torneo.
 * Lo que ya existía (cambio explícito con `fromTeamId`, retroactivas, MOVE_AFFECTS_PLAYED_MATCHES,
 * carreras) está en memberships-3a; la elegibilidad, en eligibility-3b. Aquí, lo nuevo de 3C: motivo
 * obligatorio, fecha límite, bloqueo desde la eliminatoria con excepción y anulación de una
 * transferencia errónea.
 */
import { getConnectionToken } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { authed, createTestApp, registerOrganizer, type Server, type TestApp } from './utils/test-app.js';
import { todayISODate } from '../src/common/utils/dates.js';

let ctx: TestApp;
let http: Server;
type U = Awaited<ReturnType<typeof registerOrganizer>>;
let O: U, ADM: U, COO: U, OUT: U;
const as = (u: U) => authed(http, u.token);
const db = () => ctx.app.get<Connection>(getConnectionToken());
let seq = 0;

async function tournament(names: string[], settings: Record<string, unknown> = {}) {
  seq++;
  const t = (await as(O).post('/api/tournaments').send({ name: `Transf ${seq}`, format: 'FOOTBALL_7', category: 'Libre', startDate: '2027-01-01', status: 'ACTIVE', settings }).expect(201)).body.id as string;
  const teams: string[] = [];
  for (const name of names) {
    const id = (await as(O).post('/api/teams').send({ name: `${name} T${seq}` }).expect(201)).body.id as string;
    await as(O).post(`/api/tournaments/${t}/teams/${id}`).expect(201);
    teams.push(id);
  }
  return { t, teams };
}
async function player(t: string, team: string, name: string, jerseyNumber: number | null = null, startDate = '2027-01-01') {
  const id = (await as(O).post('/api/players').send({ firstName: name, lastName: `T${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
  const retro = startDate < todayISODate() ? { retroactiveReason: 'Inscrito desde septiembre' } : {};
  await as(O).put(`/api/tournaments/${t}/players/${id}`).send({ teamId: team, jerseyNumber, startDate, ...retro }).expect(200);
  return id;
}
const move = (t: string, p: string, body: Record<string, unknown>, who = O) => as(who).put(`/api/tournaments/${t}/players/${p}`).send(body);
const annul = (t: string, p: string, body: Record<string, unknown> = { reason: 'Se cargó en el equipo equivocado' }, who = O) =>
  as(who).post(`/api/tournaments/${t}/players/${p}/annul-transfer`).send(body);
const settings = (t: string, body: Record<string, unknown>) => as(O).patch(`/api/tournaments/${t}/registration`).send(body).expect(200);
const row = (playerId: string, teamId: string) => ({ playerId, teamId, goals: 0, assists: 0, yellowCards: 0, redCards: 0, sendOff: null });
const result = (m: string, playerStats: unknown[]) => as(O).put(`/api/matches/${m}/result`).send({ homeScore: 0, awayScore: 0, status: 'FINISHED', playerStats });
const match = async (t: string, round: number, home: string, away: string, date = '2027-02-07') =>
  (await as(O).post('/api/matches').send({ tournamentId: t, round, homeTeamId: home, awayTeamId: away, date, time: '18:00' }).expect(201)).body.id as string;
const memberships = (t: string, p: string) =>
  db().collection('team_memberships').find({ tournamentId: new Types.ObjectId(t), playerId: new Types.ObjectId(p) }).sort({ _id: 1 }).toArray();
// 5B: «ayer» en la fecha LOCAL, como el servidor (todayISODate); en UTC fallaba de 19:00 a 24:00 (UTC−5).
const yesterday = () => todayISODate(new Date(Date.now() - 864e5));
async function join(t: string, u: U, role: string) {
  const inv = (await as(O).post(`/api/tournaments/${t}/invitations`).send({ kind: 'LINK', role }).expect(201)).body;
  await as(u).post(`/api/invitations/${inv.token}/accept`).expect(200);
}

beforeAll(async () => {
  ctx = await createTestApp();
  http = ctx.app.getHttpServer();
  [O, ADM, COO, OUT] = [await registerOrganizer(http, 'DueñoTransf'), await registerOrganizer(http, 'AdminTransf'), await registerOrganizer(http, 'CoordTransf'), await registerOrganizer(http, 'AjenoTransf')];
});
afterAll(async () => ctx?.close());

describe('motivo obligatorio (decisión 7)', () => {
  it('sin motivo → 400; con él se guarda en MOVED y REGISTERED; un alta normal no lo pide', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo');
    await move(t, p, { teamId: b, fromTeamId: a }).expect(400);
    await move(t, p, { teamId: b, fromTeamId: a, transferReason: 'x' }).expect(400); // mínimo 3
    await move(t, p, { teamId: b, fromTeamId: a, transferReason: 'Pidió cambio por horario' }).expect(200);
    const [old, now] = await memberships(t, p);
    expect(old.audit.at(-1)).toMatchObject({ action: 'MOVED', reason: 'Pidió cambio por horario', details: { toTeamId: b } });
    expect(now.audit[0]).toMatchObject({ action: 'REGISTERED', reason: 'Pidió cambio por horario', details: { fromTeamId: a } });
    // La primera alta no tenía motivo y se conserva así.
    expect(old.audit[0]).toMatchObject({ action: 'REGISTERED', reason: null });
  });
});

describe('fecha límite (decisión 1)', () => {
  it('sin configurar: como antes. Vencida → 409, aunque la fecha efectiva sea retroactiva; el día límite sí; el alta normal no se limita', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo');
    const r = await player(t, a, 'Ramiro', null, '2026-09-01');
    const reason = { transferReason: 'Cambio acordado' };
    await move(t, p, { teamId: b, fromTeamId: a, ...reason }).expect(200);

    await settings(t, { transferDeadline: yesterday() });
    // Ramiro: una fecha efectiva anterior al límite no lo evita (se compara con la fecha real de hoy).
    expect((await move(t, r, { teamId: b, fromTeamId: a, startDate: '2026-10-01', retroactiveReason: 'Se fue a inicios de octubre', ...reason }).expect(409)).body.error).toBe('TRANSFER_DEADLINE_PASSED');
    expect((await move(t, p, { teamId: a, fromTeamId: b, ...reason }).expect(409)).body).toMatchObject({ error: 'TRANSFER_DEADLINE_PASSED', deadline: yesterday() });
    await player(t, a, 'Nuevo'); // inscribir a alguien nuevo no es una transferencia

    await settings(t, { transferDeadline: todayISODate() }); // inclusiva
    await move(t, p, { teamId: a, fromTeamId: b, ...reason }).expect(200);
    await settings(t, { transferDeadline: null });
    await move(t, p, { teamId: b, fromTeamId: a, ...reason }).expect(200);
  });

  it('torneo anterior a 3C (sin los campos nuevos en la base): sin límite ni bloqueo', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo');
    await db().collection('tournaments').updateOne({ _id: new Types.ObjectId(t) }, { $unset: { 'registration.transferDeadline': '', 'registration.lockTransfersOnKnockout': '' } });
    await move(t, p, { teamId: b, fromTeamId: a, transferReason: 'Cambio acordado' }).expect(200);
    expect((await as(O).get(`/api/tournaments/${t}/registration`).expect(200)).body.registration).toMatchObject({ transferDeadline: null, lockTransfersOnKnockout: false });
  });
});

describe('bloqueo desde la eliminatoria (decisión 5)', () => {
  async function knockout() {
    const s = await tournament(['Águilas', 'Búhos', 'Cóndores', 'Delfines'], { system: 'KNOCKOUT' });
    await as(O).post(`/api/tournaments/${s.t}/schedule`).send({ manual: true, bracketSize: 4 }).expect(201);
    const tie = async (home: string, away: string) => {
      await as(O).post(`/api/tournaments/${s.t}/phases/0/ties`).send({ round: 0, homeTeamId: home, awayTeamId: away, legs: [{ date: '2027-05-01', time: '18:00' }] }).expect(201);
      const all = (await as(O).get(`/api/tournaments/${s.t}/matches`).expect(200)).body as { id: string; homeTeamId: string }[];
      return all.find((m) => m.homeTeamId === home)!.id;
    };
    return { ...s, tie };
  }

  it('desactivado por defecto: eliminatoria jugada y se transfiere igual', async () => {
    const { t, teams: [a, b, c, d], tie } = await knockout();
    const p = await player(t, a, 'Pablo');
    await result(await tie(a, b), []).expect(200);
    await tie(c, d);
    await move(t, p, { teamId: c, fromTeamId: a, transferReason: 'Cambio acordado' }).expect(200);
  });

  it('activado: el cuadro generado con partidos futuros no bloquea; el primer partido jugado sí; excepción con motivo; la retroactiva no lo evita', async () => {
    const { t, teams: [a, b, c, d], tie } = await knockout();
    await settings(t, { lockTransfersOnKnockout: true });
    const [p, q] = [await player(t, a, 'Pablo'), await player(t, a, 'Quique', null, '2026-09-01')];
    const semi = await tie(a, b);
    await tie(c, d);
    const reason = { transferReason: 'Cambio acordado' };
    await move(t, p, { teamId: c, fromTeamId: a, ...reason }).expect(200); // cuadro armado, nada jugado ni con fecha cumplida

    await result(semi, []).expect(200);
    expect((await move(t, q, { teamId: d, fromTeamId: a, ...reason }).expect(409)).body.error).toBe('TRANSFERS_LOCKED_KNOCKOUT');
    expect((await move(t, q, { teamId: d, fromTeamId: a, startDate: '2026-10-01', retroactiveReason: 'Se fue a inicios de octubre', ...reason }).expect(409)).body.error).toBe('TRANSFERS_LOCKED_KNOCKOUT');
    await join(t, ADM, 'ADMIN');
    await move(t, q, { teamId: d, fromTeamId: a, ...reason, knockoutReason: 'Lesión del portero, autorizado por la junta' }, ADM).expect(200);
    const [, now] = await memberships(t, q);
    expect(now.audit.map((e: { action: string }) => e.action)).toEqual(['REGISTERED', 'KNOCKOUT_EXCEPTION']);
    expect(now.audit[1]).toMatchObject({ reason: 'Lesión del portero, autorizado por la junta', role: 'ADMIN' });
  });

  it('activado: también cuenta un partido de eliminatoria cuya fecha ya llegó, aunque no se haya capturado', async () => {
    const { t, teams: [a, b, c], tie } = await knockout();
    await settings(t, { lockTransfersOnKnockout: true });
    const p = await player(t, a, 'Pablo');
    const semi = await tie(a, b);
    await db().collection('matches').updateOne({ _id: new Types.ObjectId(semi) }, { $set: { date: todayISODate() } });
    expect((await move(t, p, { teamId: c, fromTeamId: a, transferReason: 'Cambio acordado' }).expect(409)).body.error).toBe('TRANSFERS_LOCKED_KNOCKOUT');
    // Cancelado no cuenta.
    await db().collection('matches').updateOne({ _id: new Types.ObjectId(semi) }, { $set: { status: 'CANCELLED' } });
    await move(t, p, { teamId: c, fromTeamId: a, transferReason: 'Cambio acordado' }).expect(200);
  });
});

describe('anulación de una transferencia errónea (decisión 6)', () => {
  it('reabre la anterior tal como estaba; la anulada sale del perfil y de la plantilla y queda en la auditoría', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo', 9);
    await move(t, p, { teamId: b, fromTeamId: a, jerseyNumber: 4, transferReason: 'Cambio solicitado' }).expect(200);
    const roster = (await as(O).get(`/api/tournaments/${t}/players?teamId=${b}`).expect(200)).body as { membership: { transferredFrom: string | null } }[];
    expect(roster[0].membership.transferredFrom).toBe(a);

    await annul(t, p, {}).expect(400);
    const history = (await annul(t, p).expect(200)).body as { teamId: string; active: boolean; jerseyNumber: number | null; endDate: string | null }[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ teamId: a, active: true, jerseyNumber: 9, endDate: null });

    const docs = await memberships(t, p);
    expect(docs).toHaveLength(1);
    const last = docs[0].audit.at(-1);
    expect(last).toMatchObject({ action: 'TRANSFER_ANNULLED', reason: 'Se cargó en el equipo equivocado', role: 'OWNER', details: { annulled: { teamId: b, jerseyNumber: 4 } } });
    expect(last.details.annulled.audit.map((e: { action: string }) => e.action)).toEqual(['REGISTERED']);

    expect((await as(O).get(`/api/tournaments/${t}/players?teamId=${b}`).expect(200)).body).toEqual([]);
    const profile = (await as(O).get(`/api/players/${p}/profile`).expect(200)).body;
    expect(JSON.stringify(profile)).not.toContain(b);
    // Lo público nunca expone la auditoría.
    expect(JSON.stringify((await as(O).get(`/api/tournaments/${t}/players`).expect(200)).body)).not.toMatch(/"audit"|TRANSFER_ANNULLED/);
  });

  it('elegibilidad: tras anular, la participación restaurada vale en las fechas del cambio erróneo', async () => {
    const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
    const p = await player(t, a, 'Pablo');
    const v = await player(t, c, 'Visita');
    await move(t, p, { teamId: b, fromTeamId: a, startDate: '2027-02-01', transferReason: 'Cambio solicitado' }).expect(200);
    const m = await match(t, 1, a, c, '2027-02-07');
    await result(m, [row(p, a), row(v, c)]).expect(400); // con el cambio, en esa fecha era de Búhos
    await annul(t, p).expect(200);
    await result(m, [row(p, a), row(v, c)]).expect(200);
  });

  it('con participación deportiva con el equipo equivocado → 409 (estadísticas o ficha, aun de suplente); nada cambia', async () => {
    const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
    const [p, q] = [await player(t, a, 'Pablo'), await player(t, a, 'Quique')];
    const v = await player(t, c, 'Visita');
    for (const x of [p, q]) await move(t, x, { teamId: b, fromTeamId: a, transferReason: 'Cambio solicitado' }).expect(200);
    const m = await match(t, 1, b, c, '2027-02-07');
    await result(m, [row(p, b), row(v, c)]).expect(200);
    expect((await annul(t, p).expect(409)).body).toMatchObject({ error: 'TRANSFER_HAS_PARTICIPATION', message: expect.stringMatching(/estadísticas.*corrección administrativa distinta/) });

    const m2 = await match(t, 2, b, c, '2027-02-14');
    await as(O).put(`/api/matches/${m2}/sheet/teams/${b}`).send({ players: [{ playerId: p, starter: true }, { playerId: q, starter: false }], substitutions: [] }).expect(200);
    expect((await annul(t, q).expect(409)).body.message).toMatch(/alineaciones en la ficha/);
    expect((await memberships(t, q)).map((m) => [m.teamId.toHexString(), m.active])).toEqual([[a, false], [b, true]]);
  });

  it('no es una transferencia → 409 NOT_A_TRANSFER; sin participación → 404; dorsal ocupado al volver → vuelve sin dorsal', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo', 9);
    expect((await annul(t, p).expect(409)).body.error).toBe('NOT_A_TRANSFER');
    const libre = (await as(O).post('/api/players').send({ firstName: 'Libre', lastName: `T${seq}`, position: 'MIDFIELDER', confirmNew: true }).expect(201)).body.id as string;
    await annul(t, libre).expect(404);

    await move(t, p, { teamId: b, fromTeamId: a, transferReason: 'Cambio solicitado' }).expect(200);
    await player(t, a, 'Otro', 9); // alguien tomó su dorsal en Águilas
    const [restored] = (await annul(t, p).expect(200)).body as { jerseyNumber: number | null; active: boolean }[];
    expect(restored).toMatchObject({ active: true, jerseyNumber: null });
    expect((await memberships(t, p))[0].audit.at(-1).details.jerseyCleared).toBe(9);
  });

  it('anula solo la última; con la fecha límite vencida o la eliminatoria bloqueada también se puede corregir', async () => {
    const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
    const p = await player(t, a, 'Pablo');
    await move(t, p, { teamId: b, fromTeamId: a, transferReason: 'Primer cambio' }).expect(200);
    await move(t, p, { teamId: c, fromTeamId: b, transferReason: 'Segundo cambio' }).expect(200);
    await settings(t, { transferDeadline: yesterday(), lockTransfersOnKnockout: true });
    const history = (await annul(t, p).expect(200)).body as { teamId: string; active: boolean }[];
    expect(history.map((h) => [h.teamId, h.active]).sort()).toEqual([[a, false], [b, true]].sort());
  });

  it('permisos: solo propietario y administradores; anotador, coordinador y ajeno → 403; torneo finalizado → 409', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo');
    await move(t, p, { teamId: b, fromTeamId: a, transferReason: 'Cambio solicitado' }).expect(200);
    await join(t, COO, 'COORDINATOR');
    await annul(t, p, undefined, COO).expect(403);
    await annul(t, p, undefined, OUT).expect(403);
    await move(t, p, { teamId: a, fromTeamId: b, transferReason: 'Volver' }, COO).expect(403);
    await as(O).post(`/api/tournaments/${t}/finish`).send({ allowPendingMatches: true }).expect(200);
    await annul(t, p).expect(409);
  });
});

describe('concurrencia (carreras reales)', () => {
  it('anular mientras se captura un partido con el equipo nuevo → exactamente una de las dos pasa', async () => {
    for (let run = 0; run < 3; run++) {
      const { t, teams: [a, b, c] } = await tournament(['Águilas', 'Búhos', 'Cóndores']);
      const p = await player(t, a, 'Pablo');
      const v = await player(t, c, 'Visita');
      await move(t, p, { teamId: b, fromTeamId: a, startDate: '2027-01-01', transferReason: 'Cambio solicitado' }).expect(200);
      const m = await match(t, 1, b, c, '2027-02-07');
      const [capture, annulled] = await Promise.all([result(m, [row(p, b), row(v, c)]), annul(t, p)]);
      expect([capture.status, annulled.status].sort()).toEqual(annulled.status === 200 ? [200, 400] : [200, 409]);
      const docs = await memberships(t, p);
      // Integridad: si se capturó con Búhos, Búhos sigue siendo su participación; si se anuló, no hay estadísticas suyas con Búhos.
      if (capture.status === 200) expect(docs.find((d) => d.active)!.teamId.toHexString()).toBe(b);
      else expect(await db().collection('player_match_stats').countDocuments({ playerId: new Types.ObjectId(p), teamId: new Types.ObjectId(b) })).toBe(0);
    }
  });

  it('dos anulaciones simultáneas → una pasa, la otra 409; una sola participación activa', async () => {
    const { t, teams: [a, b] } = await tournament(['Águilas', 'Búhos']);
    const p = await player(t, a, 'Pablo');
    await move(t, p, { teamId: b, fromTeamId: a, transferReason: 'Cambio solicitado' }).expect(200);
    const res = await Promise.all([annul(t, p), annul(t, p)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await memberships(t, p)).filter((d) => d.active)).toHaveLength(1);
  });
});
