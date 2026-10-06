import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { MongoExceptionFilter } from './common/filters/mongo-exception.filter.js';
import { REFRESH_COOKIE } from './modules/auth/auth.types.js';

export const API_PREFIX = 'api';

/** Configuración HTTP común a main.ts y a los tests de integración. */
export function configureApp(
  app: INestApplication,
  options: { frontendUrl: string; swagger?: boolean },
) {
  app.setGlobalPrefix(API_PREFIX);
  (app as NestExpressApplication).useBodyParser('json', { limit: '100kb' });
  app.use(cookieParser());
  // Orígenes explícitos + credentials (cookie del refresh token). Nunca "*" con credenciales.
  app.enableCors({
    origin: options.frontendUrl.split(',').map((o) => o.trim()),
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new MongoExceptionFilter());

  if (options.swagger) {
    const config = new DocumentBuilder()
      .setTitle('Cancha API')
      .setDescription(
        'Torneo → Partido → Estadísticas → Perfil del jugador.\n\n' +
          'Lectura pública; escritura con JWT (Authorize → access token de /auth/login) y ' +
          'solo sobre torneos propios. El refresh token viaja en una cookie HttpOnly.',
      )
      .setVersion('0.2.0')
      .addBearerAuth()
      .addCookieAuth(REFRESH_COOKIE)
      .build();
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, () =>
      SwaggerModule.createDocument(app, config),
    );
  }
}
