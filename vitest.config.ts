import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
