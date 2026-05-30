import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    // setupFiles runs inside the worker process (unlike globalSetup, which runs
    // in a separate process), so the test env it sets reaches the app under test.
    setupFiles: ['./test/setup-integration.ts'],
    // Integration tests touch a shared database; run serially in a single fork
    // to keep setup/teardown deterministic and avoid connection contention.
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    teardownTimeout: 20000,
  },
});
