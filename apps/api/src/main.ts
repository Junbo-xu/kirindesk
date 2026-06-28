import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

// In a container, configuration comes from injected environment variables. Only
// load the repo .env when it exists, and never let it override an already-set
// process.env value — injected env is the source of truth in production
// (Phase 3A). For local `pnpm dev` the repo .env is still picked up transparently.
const envPath = resolve(__dirname, '..', '..', '..', '.env');
if (existsSync(envPath)) {
  config({ path: envPath, override: false });
}

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { APP_POOL } from './database/database.module';
import { assertNonSuperuserRole } from './database/role-self-check';
import { assertRequiredEnv } from './common/startup-env';
import type { Pool } from 'pg';

async function bootstrap() {
  // Fail fast with a single aggregated message if the environment is incomplete.
  assertRequiredEnv();

  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // CORS is OFF by default: the production topology serves the web app and the
  // API from the same origin behind nginx, so no cross-origin access is needed.
  // Enable explicitly (CORS_ENABLED=true) with an allow-list (CORS_ORIGINS,
  // comma-separated) only when the web app is served from a different origin.
  if (process.env.CORS_ENABLED === 'true') {
    const origins = (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    app.enableCors({ origin: origins.length > 0 ? origins : false, credentials: true });
  }

  const pool = app.get<Pool>(APP_POOL);
  await assertNonSuperuserRole(pool);

  const port = process.env.API_PORT || 3001;
  // Bind on all interfaces so the container is reachable from the reverse proxy.
  await app.listen(port, '0.0.0.0');
}
bootstrap();
