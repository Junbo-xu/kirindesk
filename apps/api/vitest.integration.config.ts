import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC transforms the NestJS source, emitting the `design:paramtypes`
  // decorator metadata that constructor DI relies on. Vitest's default esbuild
  // transformer drops this metadata, leaving injected providers undefined.
  plugins: [swc.vite()],
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
