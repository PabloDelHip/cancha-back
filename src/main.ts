import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AppModule } from './app.module.js';
import { API_PREFIX, configureApp } from './setup.js';
import type { EnvConfig } from './config/env.validation.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  const config = app.get<ConfigService<EnvConfig, true>>(ConfigService);

  configureApp(app, {
    frontendUrl: config.get('FRONTEND_URL', { infer: true }),
    swagger: config.get('NODE_ENV', { infer: true }) !== 'production',
  });
  app.enableShutdownHooks();

  const connection = app.get<Connection>(getConnectionToken());
  logger.log(
    `MongoDB conectado: ${connection.host}:${connection.port}/${connection.name}`,
  );

  // Detrás de un proxy (Cloud Run): req.ip = cliente real (rate limit por IP). 0 = sin proxy.
  const trustProxyHops = config.get('TRUST_PROXY_HOPS', { infer: true });
  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);

  // PORT del entorno (Cloud Run lo inyecta; 3000 en local). 0.0.0.0: accesible desde fuera del contenedor.
  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  logger.log(`API escuchando en http://0.0.0.0:${port}/${API_PREFIX}`);
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    logger.log(`Swagger en http://localhost:${port}/${API_PREFIX}/docs`);
  }
}
await bootstrap();
