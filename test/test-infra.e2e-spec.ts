/**
 * 5B (D5) — el arranque de la base de pruebas sobrevive a un choque de puerto. El choque real
 * ("Port … already in use", visto en las corridas completas de 4C y 4D) ocurre cuando otro proceso
 * toma el puerto entre que se elige y que `mongod` lo abre; no se puede provocar a voluntad, así que
 * el primer intento lanza el MISMO error de mongodb-memory-server y el segundo arranca de verdad.
 */
import { errors, MongoMemoryReplSet } from 'mongodb-memory-server';
import { startReplSet } from './utils/test-app.js';

const portInUse = () => new errors.StdoutInstanceError('Port "38671" already in use');

describe('D5 — arranque de la base de pruebas', () => {
  it('reintenta con otro puerto si el elegido ya está en uso, y arranca', async () => {
    let calls = 0;
    const replSet = await startReplSet(4, async () => {
      calls++;
      if (calls === 1) throw portInUse();
      return MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    });
    try {
      expect(calls).toBe(2);
      expect(replSet.getUri()).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\//);
    } finally {
      await replSet.stop();
    }
  });

  it('no reintenta otros errores y se rinde tras 4 choques seguidos', async () => {
    let calls = 0;
    await expect(startReplSet(4, async () => { calls++; throw new Error('binario no encontrado'); })).rejects.toThrow('binario no encontrado');
    expect(calls).toBe(1);
    calls = 0;
    await expect(startReplSet(4, async (): Promise<MongoMemoryReplSet> => { calls++; throw portInUse(); })).rejects.toThrow(/already in use/);
    expect(calls).toBe(4);
  });
});
