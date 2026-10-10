/**
 * Limpieza segura de las fotografías de evidencia (Módulo 2D) en Cloudinary.
 *
 *   npm run evidence:cleanup             → solo muestra qué haría (no borra nada)
 *   npm run evidence:cleanup -- --apply  → borra
 *
 * - Huérfanos: archivos privados bajo `kikovo/evidence/` sin registro y con más de 24 h (subidas
 *   interrumpidas, registro fallido o torneo eliminado). Los recientes no se tocan.
 * - Retiradas hace más de 30 días: se borra el archivo y el registro queda con `purgedAt`.
 * Nunca toca una fotografía activa ni nada fuera de esa carpeta.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppModule } from '../app.module.js';
import { CloudinaryService } from '../modules/media/cloudinary.service.js';
import { MatchEvidence } from '../modules/match-sheet/schemas/match-evidence.schema.js';
import { cleanupPlan, EVIDENCE_FOLDER } from '../modules/match-sheet/evidence-rules.js';
import { EvidenceStatus } from '../common/enums/index.js';

async function main() {
  const logger = new Logger('EvidenceCleanup');
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  Logger.overrideLogger(['log', 'error', 'warn']);
  try {
    const cloudinary = app.get(CloudinaryService);
    const evidence = app.get<Model<MatchEvidence>>(getModelToken(MatchEvidence.name));
    if (!cloudinary.configured) {
      logger.warn('Cloudinary no está configurado: nada que limpiar.');
      return;
    }
    const resources: { publicId: string; createdAt: Date }[] = [];
    let cursor: string | undefined;
    do {
      const page = await cloudinary.listPrivate(`${EVIDENCE_FOLDER}/`, cursor);
      resources.push(...page.resources);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const records = (await evidence.find().select('publicId status removed purgedAt').lean()).map((r) => ({ publicId: r.publicId, status: r.status, removedAt: r.removed?.at ?? null, purgedAt: r.purgedAt }));
    const plan = cleanupPlan({ resources, records, now: new Date() });
    logger.log(`${resources.length} archivos · ${plan.orphans.length} huérfanos · ${plan.purge.length} retiradas por purgar${apply ? '' : ' (simulación: usa --apply para borrar)'}`);
    if (!apply) return;
    for (const id of plan.orphans) if (await cloudinary.destroyPrivate(id)) logger.log(`Huérfano borrado: ${id}`);
    for (const id of plan.purge) if (await cloudinary.destroyPrivate(id)) await evidence.updateOne({ publicId: id, status: EvidenceStatus.REMOVED }, { $set: { purgedAt: new Date() } });
  } finally {
    await app.close();
  }
}

void main().catch((e: unknown) => {
  new Logger('EvidenceCleanup').error(e);
  process.exitCode = 1;
});
