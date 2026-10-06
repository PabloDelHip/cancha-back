/**
 * Ligas (2026-10-06): todo torneo pertenece a una liga. Los torneos creados antes de las ligas
 * (`leagueId` null) pasan a la liga por defecto de su organizador ("Liga de <nombre>"), que se crea
 * una sola vez y el organizador puede renombrar o repartir después. Idempotente: volver a correrlo
 * no crea ligas nuevas ni toca torneos que ya tienen liga.
 *
 *   npm run leagues:migrate
 *
 * ¡Cuidado! Escribe en la base a la que apunte MONGODB_URI.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { AppModule } from '../app.module.js';
import { Tournament } from '../modules/tournaments/schemas/tournament.schema.js';
import { LeagueAccessService } from '../common/authorization/league-access.service.js';

async function main() {
  const logger = new Logger('MigrateLeagues');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  Logger.overrideLogger(['log', 'error', 'warn']);
  try {
    const tournaments = app.get<Model<Tournament>>(getModelToken(Tournament.name));
    const leagues = app.get(LeagueAccessService);
    const organizers = (await tournaments.distinct('organizerId', { leagueId: null })) as Types.ObjectId[];
    let moved = 0;
    for (const organizerId of organizers) {
      const leagueId = await leagues.defaultLeagueId(organizerId);
      const r = await tournaments.updateMany({ organizerId, leagueId: null }, { $set: { leagueId } }, { timestamps: false });
      moved += r.modifiedCount;
      logger.log(`Organizador ${organizerId.toHexString()}: ${r.modifiedCount} torneos → liga ${leagueId.toHexString()}`);
    }
    logger.log(`Listo: ${moved} torneos asignados a ${organizers.length} ligas por defecto.`);
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
