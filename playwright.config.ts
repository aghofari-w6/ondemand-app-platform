import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Reduced motion: no colour transitions, so axe never samples a half-faded button.
    contextOptions: { reducedMotion: 'reduce' },
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The real server: API + built SPA + in-process dispatcher and pg-boss workers.
    command: 'node apps/server/src/main.ts',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      PUBLIC_URL: `http://localhost:${PORT}`,
      LOG_LEVEL: 'warn',
      DEMO_MODE: 'true',
      // The e2e webhook receiver runs on localhost; production never allows this.
      HUB_ALLOW_PRIVATE_HOSTS: '127.0.0.1,localhost',
      HUB_BACKOFF_BASE_MS: '50',
      HUB_MAX_ATTEMPTS: '2',
      HUB_INTERVAL_MS: '200',
    },
  },
});
