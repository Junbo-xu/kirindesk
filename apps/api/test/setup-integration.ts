import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll } from 'vitest';
import pg from 'pg';
import { seedFixture, TEST_DB } from './fixtures';

// ---------------------------------------------------------------------------
// DEV ONLY / local Docker Compose only.
// Connection config is env-first with a local-dev fallback. The fallback
// credentials match docker-compose and are NOT production secrets. They are
// only ever used to reach an isolated kirindesk_test database. We never load
// the real .env here.
//   - TEST_DATABASE_URL      : admin/superuser, for setup/migrate/verify-chain
//   - TEST_APP_DATABASE_URL  : restricted app role, for the API runtime
// ---------------------------------------------------------------------------
const DEV_FALLBACK_ADMIN_URL = `postgresql://kirindesk:kirindesk_dev_password@localhost:5432/${TEST_DB}`;
const DEV_FALLBACK_APP_URL = `postgresql://kirindesk_app:kirindesk_app_dev_password@localhost:5432/${TEST_DB}`;

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEV_FALLBACK_ADMIN_URL;
const TEST_APP_DATABASE_URL = process.env.TEST_APP_DATABASE_URL ?? DEV_FALLBACK_APP_URL;

// Maintenance connection (postgres db) for DROP/CREATE DATABASE, derived from
// the admin URL by swapping the database name.
const MAINTENANCE_URL = TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres');

// Inject test env synchronously, before any test file imports AppModule.
// DATABASE_URL is only for setup/migrate/verify-chain; the API runtime reads
// APP_DATABASE_URL exclusively.
process.env.TENANT_JWT_SECRET = 'test-tenant-jwt-secret';
process.env.PLATFORM_JWT_SECRET = 'test-platform-jwt-secret';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_DATABASE_URL = TEST_APP_DATABASE_URL;

export { TEST_DB, TEST_DATABASE_URL };

async function recreateTestDatabase(): Promise<void> {
  const admin = new pg.Client({ connectionString: MAINTENANCE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT current_database() AS db');
    if (rows[0]?.db === TEST_DB) {
      throw new Error(`Refusing to drop: maintenance connection is on "${TEST_DB}"`);
    }
    // Identifier is the constant TEST_DB defined in fixtures, not user input.
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
}

async function assertOnTestDatabase(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT current_database() AS db');
    if (rows[0]?.db !== TEST_DB) {
      throw new Error(`Refusing to run: connected to "${rows[0]?.db}", expected "${TEST_DB}"`);
    }
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await recreateTestDatabase();
  await assertOnTestDatabase();
  // Apply migrations 000-023 to the freshly created test database. DATABASE_URL
  // is passed explicitly; dotenv inside the runner does not override it.
  execFileSync('pnpm', ['--filter', '@kirindesk/database', 'migrate'], {
    cwd: resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
  await seedFixture(TEST_DATABASE_URL);
}, 120000);
