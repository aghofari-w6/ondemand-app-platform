import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'apps/server/src/**/*.test.ts', 'templates/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
          globalSetup: ['apps/server/test/global-setup.ts'],
        },
      },
    ],
  },
});
