/**
 * 5C — informe de referencias huérfanas (jugadores, equipos, partidos y torneos que ya no existen).
 *
 *   npm run orphans:report            → resumen legible
 *   npm run orphans:report -- --json  → el informe completo en JSON
 *
 * SOLO LECTURA: se conecta con el driver (sin levantar la aplicación, que crearía índices), con
 * preferencia de lectura `secondaryPreferred`, y solo agrega. No modifica ni borra nada. Usa
 * MONGODB_URI (o el `.env` del backend).
 */
import mongoose from 'mongoose';
import { describeDbTarget, loadAppEnv } from '../common/utils/db-target.js';
import { orphanReport } from './orphan-report.js';

async function main() {
  // Solo lectura: se informa el destino (sin credenciales), sin exigir confirmación.
  const { uri } = loadAppEnv();
  console.error(`Base: ${describeDbTarget(uri).label}`);
  const conn = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, readPreference: 'secondaryPreferred' }).asPromise();
  try {
    const findings = await orphanReport(conn.db!);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ database: conn.name, findings }, null, 2));
      return;
    }
    const problems = findings.filter((f) => f.severity === 'problem');
    console.log(`Base ${conn.name}: ${problems.length} revisiones con problemas, ${findings.length - problems.length} con referencias históricas esperadas.`);
    for (const f of findings) {
      console.log(`${f.severity === 'problem' ? 'PROBLEMA' : 'esperada'}  ${f.collection}.${f.field} → ${f.target}: ${f.missingIds} ids inexistentes en ${f.documents} documentos. ${f.note}. Ej.: ${f.sample.join(', ')}`);
    }
  } finally {
    await conn.close();
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
