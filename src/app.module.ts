import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { validateEnv, type EnvConfig } from './config/env.validation.js';
import { HealthModule } from './modules/health/health.module.js';
import { TournamentsModule } from './modules/tournaments/tournaments.module.js';
import { TeamsModule } from './modules/teams/teams.module.js';
import { PlayersModule } from './modules/players/players.module.js';
import { MatchesModule } from './modules/matches/matches.module.js';
import { StatisticsModule } from './modules/statistics/statistics.module.js';
import { RoundsModule } from './modules/rounds/rounds.module.js';
import { CompetitionModule } from './modules/competition/competition.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { RegistrationModule } from './modules/registration/registration.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { MeModule } from './modules/me/me.module.js';
import { LeaguesModule } from './modules/leagues/leagues.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { AuthorizationModule } from './common/authorization/authorization.module.js';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      cache: true,
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        serverSelectionTimeoutMS: 5000,
        connectionFactory: (connection: Connection) => {
          const logger = new Logger('MongoDB');
          connection.on('disconnected', () => {
            // _closeCalled (interno de Mongoose) distingue un cierre intencional (shutdown) de una caída.
            if (
              !(connection as unknown as { _closeCalled?: boolean })
                ._closeCalled
            )
              logger.warn('Conexión con MongoDB perdida');
          });
          connection.on('reconnected', () =>
            logger.log('Reconectado a MongoDB'),
          );
          connection.on('error', (err: Error) => logger.error(err.message));
          return connection;
        },
      }),
    }),
    AuthorizationModule,
    MediaModule,
    UsersModule,
    RegistrationModule,
    MeModule,
    AuthModule,
    HealthModule,
    LeaguesModule,
    TournamentsModule,
    TeamsModule,
    PlayersModule,
    MatchesModule,
    RoundsModule,
    CompetitionModule,
    StatisticsModule,
  ],
  providers: [
    // Autenticación por defecto en TODAS las rutas; las de lectura pública usan @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
