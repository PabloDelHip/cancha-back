/**
 * 6C (§0) — destino real de MONGODB_URI y guardas para los comandos que escriben. Nunca se muestran
 * credenciales ni parámetros: solo `local|remota host/base`.
 *
 * - `assertDisposableDb` (seed, que BORRA colecciones): nunca con NODE_ENV=production ni contra
 *   MongoDB Atlas (`mongodb+srv://` o `*.mongodb.net`), sin excepción. Otro host remoto solo con
 *   SEED_ALLOW_REMOTE=true (una base de desarrollo en otra máquina).
 * - `assertConfirmedDb` (migraciones y scripts administrativos, que sí pueden correr en producción
 *   a propósito): contra un destino no local exige CONFIRM_DB=<nombre de la base> exacto.
 */
import { existsSync } from 'node:fs';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface DbTarget {
  local: boolean;
  atlas: boolean;
  hosts: string[];
  database: string | null;
  /** Para mostrar: sin usuario, contraseña ni parámetros. */
  label: string;
}

/** Oculta el identificador del clúster (`cluster0.abc12.mongodb.net` → `cluster0.…mongodb.net`). */
const maskHost = (h: string) => (h.endsWith('.mongodb.net') ? `${h.split('.')[0]}.…mongodb.net` : h);

export function describeDbTarget(uri: string): DbTarget {
  const srv = uri.startsWith('mongodb+srv://');
  const rest = uri.replace(/^mongodb(\+srv)?:\/\//, '');
  const authority = rest.split('/')[0].split('?')[0];
  const hostList = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const hostPorts = hostList.split(',').filter(Boolean);
  const hosts = hostPorts.map((h) => h.replace(/:\d+$/, ''));
  const path = rest.includes('/') ? rest.slice(rest.indexOf('/') + 1).split('?')[0] : '';
  const database = path ? decodeURIComponent(path) : null;
  const local = !srv && hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.has(h));
  const atlas = srv || hosts.some((h) => h.endsWith('.mongodb.net'));
  const shown = hostPorts.map((hp) => {
    const [h, port] = hp.split(/:(?=\d+$)/);
    return `${maskHost(h)}${port ? `:${port}` : ''}`;
  });
  return { local, atlas, hosts, database, label: `${local ? 'local' : 'remota'} ${shown.join(',')}/${database ?? '(sin base)'}` };
}

/** Las variables que usará la app: el entorno del proceso gana sobre el `.env` (como @nestjs/config). */
export function loadAppEnv(file = '.env') {
  if (existsSync(file)) process.loadEnvFile(file);
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Falta MONGODB_URI');
  return { uri, nodeEnv: process.env.NODE_ENV ?? 'development' };
}

/** Comandos que borran o recrean datos (seed): solo bases desechables. */
export function assertDisposableDb(uri: string, nodeEnv: string, what: string, env: NodeJS.ProcessEnv = process.env) {
  const t = describeDbTarget(uri);
  if (nodeEnv === 'production') throw new Error(`${what} no se ejecuta con NODE_ENV=production.`);
  if (t.atlas) throw new Error(`${what} nunca se ejecuta contra MongoDB Atlas (${t.label}): usa una base local o aislada.`);
  if (!t.local && env.SEED_ALLOW_REMOTE !== 'true') {
    throw new Error(`${what} solo se ejecuta contra MongoDB local (${t.label}). Usa SEED_ALLOW_REMOTE=true si realmente es una base de desarrollo.`);
  }
  return t;
}

/** Scripts que escriben y pueden correr en producción a propósito: destino remoto = confirmación explícita. */
export function assertConfirmedDb(uri: string, what: string, env: NodeJS.ProcessEnv = process.env) {
  const t = describeDbTarget(uri);
  if (!t.local && env.CONFIRM_DB !== t.database) {
    throw new Error(`${what} escribiría en una base ${t.label}. Si es lo que quieres, repite con CONFIRM_DB=${t.database ?? '<base>'}.`);
  }
  return t;
}
