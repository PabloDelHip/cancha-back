/**
 * Carga los datos demo en la base de DESARROLLO.
 *
 *   npm run seed
 *
 * Es idempotente: borra y recrea SOLO las colecciones de esta app (incluidos usuarios y sesiones) en la base configurada
 * en MONGODB_URI. Por seguridad se niega a ejecutarse si NODE_ENV=production o si el host
 * no es local (localhost / 127.0.0.1 / ::1), salvo SEED_ALLOW_REMOTE=true explícito.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AppModule } from '../app.module.js';
import { validateEnv, type EnvConfig } from '../config/env.validation.js';
import {
  CompetitionSystem,
  MatchStatus,
  TeamAdminRole,
  TeamAdminSource,
  TeamAdminStatus,
  TeamRosterStatus,
  PlayerPosition,
  TournamentFormat,
  TournamentStatus,
} from '../common/enums/index.js';
import { Models } from '../common/models.js';
import { normalizeSearch } from '../modules/players/schemas/player.schema.js';
import { createSeed, DEMO_PASSWORD } from './demo-data.js';
import { UsersService } from '../modules/users/users.service.js';

/**
 * Organizadores demo. SOLO PARA DESARROLLO: credenciales públicas documentadas en el README.
 * - A: demo@cancha.local → ligas de Mazatlán (y custodio de sus equipos y jugadores).
 * - B: organizador2@cancha.local → Liga Cancún 2027.
 * Ambos con contraseña DEMO_PASSWORD (Demo12345). Salen del mismo generador que los mocks.
 */
export { DEMO_PASSWORD };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const POSITION = {
  GK: PlayerPosition.GOALKEEPER,
  DEF: PlayerPosition.DEFENDER,
  MID: PlayerPosition.MIDFIELDER,
  FWD: PlayerPosition.FORWARD,
};
const FORMAT = {
  F7: TournamentFormat.FOOTBALL_7,
  F11: TournamentFormat.FOOTBALL_11,
};
const T_STATUS = {
  draft: TournamentStatus.DRAFT,
  active: TournamentStatus.ACTIVE,
  finished: TournamentStatus.FINISHED,
};
const M_STATUS = {
  scheduled: MatchStatus.SCHEDULED,
  live: MatchStatus.LIVE,
  finished: MatchStatus.FINISHED,
  postponed: MatchStatus.POSTPONED,
  cancelled: MatchStatus.CANCELLED,
};

function assertSafeTarget(uri: string, nodeEnv: string) {
  if (nodeEnv === 'production')
    throw new Error('El seed no se ejecuta con NODE_ENV=production.');
  const hostList =
    uri
      .replace(/^mongodb(\+srv)?:\/\//, '')
      .split('/')[0]
      .split('@')
      .pop() ?? '';
  const hosts = hostList.split(',').map((h) => h.replace(/:\d+$/, ''));
  const remote = hosts.filter((h) => !LOCAL_HOSTS.has(h));
  if (remote.length && process.env.SEED_ALLOW_REMOTE !== 'true') {
    throw new Error(
      `El seed solo se ejecuta contra MongoDB local. Host(s) no local(es): ${remote.join(', ')}. Usa SEED_ALLOW_REMOTE=true si realmente es una base de desarrollo.`,
    );
  }
}

async function run() {
  const logger = new Logger('Seed');
  // Verifica el destino ANTES de conectar, con las mismas variables que usará la app.
  try {
    process.loadEnvFile('.env');
  } catch {
    // sin .env: se usan las variables del entorno
  }
  const env = validateEnv(process.env);
  assertSafeTarget(env.MONGODB_URI, env.NODE_ENV);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  Logger.overrideLogger(['log', 'error', 'warn']);
  try {
    const config = app.get<ConfigService<EnvConfig, true>>(ConfigService);
    const uri = config.get('MONGODB_URI', { infer: true });
    assertSafeTarget(uri, config.get('NODE_ENV', { infer: true }));

    const model = <T>(def: { name: string }) =>
      app.get<Model<T>>(getModelToken(def.name));
    const m = {
      tournaments: model(Models.tournament),
      enrollments: model(Models.tournamentTeam),
      teams: model(Models.team),
      players: model(Models.player),
      memberships: model(Models.membership),
      matches: model(Models.match),
      rounds: model(Models.round),
      stats: model(Models.playerMatchStats),
      users: model(Models.user),
      sessions: model(Models.authSession),
      // 6A/6B: si no se limpian, quedarían roles y plantillas apuntando a equipos/usuarios borrados.
      teamAdmins: model(Models.teamAdmin),
      teamRosters: model(Models.teamRoster),
      // Etapa 7: enlaces y solicitudes de inscripción (referencian torneos, equipos y jugadores).
      registrationLinks: model(Models.registrationLink),
      registrationRequests: model(Models.registrationRequest),
    };

    const all = Object.values(m) as Model<unknown>[];
    await Promise.all(all.map((x) => x.deleteMany({})));
    // syncIndexes (no solo init): elimina índices que ya no existen en los schemas, p. ej. el
    // antiguo "un equipo activo por jugador" global, sustituido por "uno por torneo".
    await Promise.all(all.map((x) => x.syncIndexes()));

    const data = createSeed();
    const ids = new Map<string, Types.ObjectId>();
    const oid = (key: string) => {
      if (!ids.has(key)) ids.set(key, new Types.ObjectId());
      return ids.get(key)!;
    };

    // Usuarios organizadores (contraseña hasheada con Argon2id por UsersService).
    const usersService = app.get(UsersService);
    for (const u of data.users) {
      const created = await usersService.create({
        email: u.email,
        password: DEMO_PASSWORD,
        firstName: u.firstName,
        lastName: u.lastName,
      });
      ids.set(u.id, new Types.ObjectId(created.id));
    }
    const owner = (key: string | null | undefined) => (key ? oid(key) : null);

    await m.teams.insertMany(
      data.teams.map((t) => ({
        _id: oid(t.id),
        name: t.name,
        shortName: t.shortName,
        logoUrl: t.logoUrl,
        colors: t.colors,
        city: t.city,
        createdBy: owner(t.createdBy),
      })),
    );
    await m.players.insertMany(
      data.players.map((p) => ({
        _id: oid(p.id),
        firstName: p.firstName,
        lastName: p.lastName,
        birthDate: p.birthDate,
        position: POSITION[p.position],
        photoUrl: p.photoUrl,
        searchName: normalizeSearch(`${p.firstName} ${p.lastName}`),
        createdBy: owner(p.createdBy),
      })),
    );
    await m.memberships.insertMany(
      data.memberships.map((ms) => ({
        playerId: oid(ms.playerId),
        tournamentId: oid(ms.tournamentId),
        teamId: oid(ms.teamId),
        jerseyNumber: ms.shirtNumber,
        startDate: ms.startDate,
        endDate: ms.endDate,
        active: ms.status === 'active',
      })),
    );
    await m.tournaments.insertMany(
      data.tournaments.map((t) => ({
        _id: oid(t.id),
        name: t.name,
        format: FORMAT[t.modality],
        category: t.category,
        startDate: t.startDate,
        endDate: t.endDate,
        status: T_STATUS[t.status],
        venue: t.venue,
        settings: {
          system: CompetitionSystem.LEAGUE,
          pointsForWin: t.settings.points.win,
          pointsForDraw: t.settings.points.draw,
          pointsForLoss: t.settings.points.loss,
        },
        organizerId: owner(t.organizerId),
      })),
    );
    await m.enrollments.insertMany(
      data.tournamentTeams.map((e) => ({
        tournamentId: oid(e.tournamentId),
        teamId: oid(e.teamId),
      })),
    );
    await m.matches.insertMany(
      data.matches.map((x) => ({
        _id: oid(x.id),
        tournamentId: oid(x.tournamentId),
        round: x.round,
        homeTeamId: oid(x.homeTeamId),
        awayTeamId: oid(x.awayTeamId),
        date: x.date,
        time: x.time,
        venue: x.venue,
        status: M_STATUS[x.status],
        homeScore: x.homeScore,
        awayScore: x.awayScore,
      })),
    );
    // Jornadas persistentes: una por cada (torneo, número) usado por sus partidos, con la fecha
    // de su primer partido como referencia (igual que las crea la generación de calendario).
    const roundKeys = new Map<string, { tournamentId: string; number: number; date: string }>();
    for (const x of data.matches) {
      const key = `${x.tournamentId}|${x.round}`;
      const prev = roundKeys.get(key);
      if (!prev || x.date < prev.date) roundKeys.set(key, { tournamentId: x.tournamentId, number: x.round, date: x.date });
    }
    await m.rounds.insertMany(
      [...roundKeys.values()].map((r) => ({ tournamentId: oid(r.tournamentId), number: r.number, name: null, date: r.date })),
    );
    await m.stats.insertMany(
      data.playerMatchStats.map((s) => ({
        matchId: oid(s.matchId),
        playerId: oid(s.playerId),
        teamId: oid(s.teamId),
        played: true,
        goals: s.goals,
        assists: s.assists,
        yellowCards: s.yellowCards,
        redCards: s.redCards,
      })),
    );

    // ── Etapa 6: roles de equipo y plantilla global (SOLO DESARROLLO) ──────────────────────────
    // Caso multirol: Pablo es propietario de Halcones y delegado de Tigres (propietaria: Laura, que
    // además organiza torneos). Carlos es delegado de Halcones y NO es jugador. La plantilla global
    // es explícita (nunca derivada de torneos): el jugador Pablo Hipólito pertenece a dos equipos.
    // Nota: la cuenta Pablo y el jugador Pablo Hipólito NO están vinculados (no existe Player claim).
    const pabloUser = await usersService.create({ email: 'pablo@cancha.local', password: DEMO_PASSWORD, firstName: 'Pablo', lastName: 'Hipólito' });
    const carlosUser = await usersService.create({ email: 'carlos@cancha.local', password: DEMO_PASSWORD, firstName: 'Carlos', lastName: 'López' });
    const laura = ids.get(data.users[0]!.id)!;
    const pabloId = new Types.ObjectId(pabloUser.id);
    const since = new Date('2027-01-10T18:00:00Z');
    const admin = (team: string, userId: Types.ObjectId, role: TeamAdminRole, grantedBy: Types.ObjectId | null) => ({
      teamId: oid(team),
      userId,
      role,
      status: TeamAdminStatus.ACTIVE,
      source: grantedBy ? TeamAdminSource.OWNER : TeamAdminSource.INTERNAL,
      grantedBy,
      createdAt: since,
      updatedAt: since,
    });
    await m.teamAdmins.insertMany([
      admin('team-halcones', pabloId, TeamAdminRole.OWNER, null),
      admin('team-halcones', new Types.ObjectId(carlosUser.id), TeamAdminRole.MANAGER, pabloId),
      admin('team-tigres', laura, TeamAdminRole.OWNER, null),
      admin('team-tigres', pabloId, TeamAdminRole.MANAGER, laura),
    ]);
    const rosterOf = (team: string, playerKeys: string[], addedBy: Types.ObjectId) =>
      playerKeys.map((k) => ({ teamId: oid(team), playerId: oid(k), status: TeamRosterStatus.ACTIVE, joinedAt: '2027-01-10', leftAt: null, addedBy }));
    const halconesSquad = [...new Set(data.memberships.filter((x) => x.teamId === 'team-halcones' && x.status === 'active').map((x) => x.playerId))].slice(0, 12);
    const pabloPlayer = data.players.find((p) => p.lastName === 'Hipólito')?.id;
    await m.teamRosters.insertMany([
      ...rosterOf('team-halcones', halconesSquad, pabloId),
      ...(pabloPlayer ? rosterOf('team-tigres', [pabloPlayer], laura) : []),
    ]);

    const dbName = uri.split('/').pop()?.split('?')[0];
    logger.log(
      `Base "${dbName}" lista: ${data.tournaments.length} torneos, ${data.teams.length} equipos, ${data.players.length} jugadores, ` +
        `${roundKeys.size} jornadas, ${data.matches.length} partidos, ${data.playerMatchStats.length} estadísticas.`,
    );
    const pablo = data.players.find((p) => p.lastName === 'Hipólito');
    // Por nombre completo: el apellido solo puede coincidir con otro jugador generado al azar.
    const diego = data.players.find((p) => p.firstName === 'Diego' && p.lastName === 'Ramírez Tirado');
    const apertura = data.tournaments.find((t) => t.status === 'active');
for (const u of data.users) {
      logger.log(`Cuenta demo (solo desarrollo): ${u.email} / ${DEMO_PASSWORD}`);
    }
    logger.log(`Cuenta demo (solo desarrollo): pablo@cancha.local / ${DEMO_PASSWORD} — propietario de Halcones, delegado de Tigres`);
    logger.log(`Cuenta demo (solo desarrollo): carlos@cancha.local / ${DEMO_PASSWORD} — delegado de Halcones, sin ficha de jugador`);
    if (pablo && diego && apertura) {
      logger.log(
        `Pablo Hipólito:  /api/players/${oid(pablo.id).toHexString()}`,
      );
      logger.log(
        `Diego Ramírez (transferido):  /api/players/${oid(diego.id).toHexString()}/stats`,
      );
      logger.log(
        `Tabla Apertura:  /api/tournaments/${oid(apertura.id).toHexString()}/standings`,
      );
    }
  } finally {
    await app.close();
  }
}

run().catch((err: Error) => {
  new Logger('Seed').error(err.message);
  process.exit(1);
});
