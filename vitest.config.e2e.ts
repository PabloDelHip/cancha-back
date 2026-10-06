import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // La primera ejecución descarga el binario de MongoDB para mongodb-memory-server.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
