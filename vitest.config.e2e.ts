import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // La primera ejecución descarga el binario de MongoDB para mongodb-memory-server.
    hookTimeout: 180_000,
    testTimeout: 30_000,
    // 5B (D5): como mucho 4 archivos a la vez (cada uno arranca su propio mongod). Antes, uno por
    // núcleo menos uno: más arranques simultáneos = más choques de puerto y más carga en las
    // pruebas de carreras y rendimiento. El reintento de test-app.ts sigue cubriendo el choque.
    maxWorkers: 4,
  },
});
