import { describe, expect, it } from 'vitest';
import { assertConfirmedDb, assertDisposableDb, describeDbTarget } from './db-target.js';

const ATLAS = 'mongodb+srv://user:s3cr3t@cluster0.abc12.mongodb.net/football_app?retryWrites=true&w=majority';
const LOCAL = 'mongodb://localhost:27017/football_app?replicaSet=rs0&directConnection=true';
const ISOLATED = 'mongodb://127.0.0.1:27118/smoke_6c?replicaSet=testset';
const REMOTE = 'mongodb://admin:pw@db.example.com:27017,db2.example.com:27017/dev_app';

describe('6C — destino de la base', () => {
  it('describe sin credenciales ni parámetros', () => {
    const t = describeDbTarget(ATLAS);
    expect(t).toMatchObject({ local: false, atlas: true, database: 'football_app' });
    expect(t.label).toBe('remota cluster0.…mongodb.net/football_app');
    expect(t.label).not.toMatch(/user|s3cr3t|abc12|retryWrites/);
    expect(describeDbTarget(LOCAL)).toMatchObject({ local: true, atlas: false, label: 'local localhost:27017/football_app' });
    expect(describeDbTarget(ISOLATED).label).toBe('local 127.0.0.1:27118/smoke_6c');
    expect(describeDbTarget(REMOTE)).toMatchObject({ local: false, atlas: false, hosts: ['db.example.com', 'db2.example.com'], label: 'remota db.example.com:27017,db2.example.com:27017/dev_app' });
  });

  it('seed: nunca producción ni Atlas (ni con SEED_ALLOW_REMOTE); otro remoto solo con SEED_ALLOW_REMOTE', () => {
    expect(() => assertDisposableDb(ATLAS, 'development', 'El seed', {})).toThrow(/nunca se ejecuta contra MongoDB Atlas/);
    expect(() => assertDisposableDb(ATLAS, 'development', 'El seed', { SEED_ALLOW_REMOTE: 'true' })).toThrow(/Atlas/);
    expect(() => assertDisposableDb(LOCAL, 'production', 'El seed', {})).toThrow(/NODE_ENV=production/);
    expect(() => assertDisposableDb(REMOTE, 'development', 'El seed', {})).toThrow(/solo se ejecuta contra MongoDB local/);
    expect(assertDisposableDb(REMOTE, 'development', 'El seed', { SEED_ALLOW_REMOTE: 'true' }).database).toBe('dev_app');
    expect(assertDisposableDb(ISOLATED, 'test', 'El seed', {}).local).toBe(true);
  });

  it('scripts que escriben: un destino remoto exige CONFIRM_DB con el nombre exacto de la base', () => {
    expect(() => assertConfirmedDb(ATLAS, 'La migración', {})).toThrow(/CONFIRM_DB=football_app/);
    expect(() => assertConfirmedDb(ATLAS, 'La migración', { CONFIRM_DB: 'true' })).toThrow();
    expect(assertConfirmedDb(ATLAS, 'La migración', { CONFIRM_DB: 'football_app' }).atlas).toBe(true);
    expect(assertConfirmedDb(LOCAL, 'La migración', {}).local).toBe(true);
    try {
      assertConfirmedDb(ATLAS, 'La migración', {});
    } catch (e) {
      expect(String(e)).not.toMatch(/s3cr3t|user:|abc12/);
    }
  });
});
