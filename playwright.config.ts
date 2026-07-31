import { defineConfig, devices } from '@playwright/test';

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://kirindesk:kirindesk_dev_password@127.0.0.1:5432/kirindesk_test';
const testAppDatabaseUrl =
  process.env.TEST_APP_DATABASE_URL ??
  'postgresql://kirindesk_app:kirindesk_app_dev_password@127.0.0.1:5432/kirindesk_test';

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @kirindesk/api exec nest start',
      url: 'http://127.0.0.1:3101/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        API_PORT: '3101',
        DATABASE_URL: testDatabaseUrl,
        APP_DATABASE_URL: testAppDatabaseUrl,
        TENANT_JWT_SECRET: 'test-tenant-jwt-secret',
        PLATFORM_JWT_SECRET: 'test-platform-jwt-secret',
        REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1',
        LOGIN_RATE_LIMIT_MAX: '100',
        LOGIN_RATE_LIMIT_WINDOW_SEC: '900',
        TRUST_PROXY: 'true',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
        S3_REGION: 'us-east-1',
        S3_BUCKET: process.env.S3_BUCKET ?? 'kirindesk-files',
        S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'kirindesk',
        S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'kirindesk_dev_secret',
        NOTIFICATION_PROVIDER: 'mock',
        AI_OCR_PROVIDER: 'mock',
      },
    },
    {
      command: 'pnpm --filter @kirindesk/web exec vite --host 127.0.0.1 --port 4173',
      url: 'http://127.0.0.1:4173/login',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        API_PROXY_TARGET: 'http://127.0.0.1:3101',
      },
    },
  ],
});
