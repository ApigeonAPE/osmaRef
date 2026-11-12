import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  cacheDir: '.vitest-cache',
  resolve: {
    alias: {
      '@osmaref/contracts': r('./packages/contracts/src/index.ts'),
      '@osmaref/domain': r('./packages/domain/src/index.ts'),
      '@osmaref/adapters': r('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 10_000,
  },
});