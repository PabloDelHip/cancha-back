import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { Models } from '../../common/models.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import type { EnvConfig } from '../../config/env.validation.js';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    // Los secretos y expiraciones se pasan explícitamente al firmar/verificar (access y refresh son distintos).
    JwtModule.register({}),
    MongooseModule.forFeature([Models.authSession]),
    // Rate limit en memoria para login/register/refresh. Con varias instancias del API
    // haría falta un storage compartido (p. ej. Redis) — ver README.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        // "credentials": login/registro (fuerza bruta). "refresh": más holgado, porque
        // cada carga de página restaura la sesión con un refresh.
        throttlers: [
          {
            name: 'credentials',
            ttl: config.get('AUTH_THROTTLE_TTL', { infer: true }) * 1000,
            limit: config.get('AUTH_THROTTLE_LIMIT', { infer: true }),
          },
          {
            name: 'refresh',
            ttl: config.get('AUTH_THROTTLE_TTL', { infer: true }) * 1000,
            limit: config.get('AUTH_REFRESH_THROTTLE_LIMIT', { infer: true }),
          },
        ],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
})
export class AuthModule {}
