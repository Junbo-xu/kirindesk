import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll } from 'vitest';
import pg from 'pg';

// Local-only development credentials (also used by docker-compose). These are
// NOT production secrets. Tests run against an isolated kirindesk_test database.
const PG_HOST = 'localhost:5432';
const ADMIN_USER = 'kirindesk:kirindesk_dev_password';
const APP_USER = 'kirindesk_app:kirindesk_app_dev_password';
const TEST_DB = 'kirindesk_test';

const TEST_DATABASE_URL = `postgresql://${ADMIN_USER}@${PG_HOST}/${TEST_DB}`;
const TEST_APP_DATABASE_URL = `postgresql://${APP_USER}@${PG_HOST}/${TEST_DB}`;
const MAINTENANCE_URL = `postgresql://${ADMIN_USER}@${PG_HOST}/postgres`;

// Inject test env synchronously, before any test file imports AppModule.
// We do NOT load the real .env. DATABASE_URL is only for setup/migration;
// the API runtime reads APP_DATABASE_URL exclusively.
process.env.TENANT_JWT_SECRET = 'test-tenant-jwt-secret';
process.env.PLATFORM_JWT_SECRET = 'test-platform-jwt-secret';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_DATABASE_URL = TEST_APP_DATABASE_URL;

export { TEST_DB, TEST_DATABASE_URL };

async function createTestDatabaseIfMissing(): Promise<void> {
  const admin = new pg.Client({ connectionString: MAINTENANCE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (rows.length === 0) {
      // Identifier is a constant defined above, not user input.
      await admin.query(`CREATE DATABASE ${TEST_DB}`);
    }
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
  await createTestDatabaseIfMissing();
  await assertOnTestDatabase();
  // Apply migrations 000-023 to the test database via the existing runner.
  // DATABASE_URL is passed explicitly; dotenv inside the runner does not
  // override an already-set process.env value.
  execFileSync('pnpm', ['--filter', '@kirindesk/database', 'migrate'], {
    cwd: resolve(__dirname, '..', '..', '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}, 60000);
