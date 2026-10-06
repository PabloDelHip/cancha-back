/**
 * Asigna el PRIMER OWNER de un equipo. Operación administrativa interna: no existe endpoint
 * HTTP para esto (evita que cualquier usuario se apropie de un equipo sin OWNER). Solo quien
 * tiene acceso al servidor y a la base puede ejecutarla.
 *
 *   npm run team:assign-owner -- --team <teamId> --email <email>
 *   npm run team:assign-owner -- --team <teamId> --user <userId>
 *
 * Falla (409) si el equipo ya tiene OWNER distinto: cambiar de OWNER será la transferencia
 * (etapa futura), no esto. En producción, el primer OWNER llegará por el Claim Flow, que usará
 * la misma operación (TeamAdminsService.assignOwner) tras verificar al solicitante.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { TeamAdminsService } from '../modules/teams/team-admins.service.js';
import { User } from '../modules/users/schemas/user.schema.js';
import { normalizeEmail } from '../modules/users/users.service.js';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const logger = new Logger('AssignTeamOwner');
  const teamId = arg('team');
  const email = arg('email');
  let userId = arg('user');
  if (!teamId || !!email === !!userId) {
    logger.error('Uso: npm run team:assign-owner -- --team <teamId> (--email <email> | --user <userId>)');
    process.exitCode = 1;
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  Logger.overrideLogger(['log', 'error', 'warn']);
  try {
    if (email) {
      const users = app.get<Model<User>>(getModelToken(User.name));
      const found = await users.findOne({ email: normalizeEmail(email) }).select('_id').lean();
      if (!found) throw new Error(`No existe una cuenta con el email ${email}`);
      userId = found._id.toHexString();
    }
    const admins = await app.get(TeamAdminsService).assignOwner(teamId, userId!);
    logger.log(`OWNER de ${teamId}: ${admins.owner?.firstName} ${admins.owner?.lastName} (${admins.owner?.userId})`);
  } catch (e) {
    logger.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void main();
