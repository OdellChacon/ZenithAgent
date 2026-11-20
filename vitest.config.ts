import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // Las pruebas de integración comparten una misma BD: se ejecutan en serie.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
