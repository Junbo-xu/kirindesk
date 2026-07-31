import { closePool, getPool } from './client.js';
import { migrate } from './migrate.js';
import { rollback } from './rollback.js';

interface MigrationRow {
  filename: string;
  checksum: string;
}

async function rehearse(): Promise<void> {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL;
  if (!testDatabaseUrl) {
    throw new Error('TEST_DATABASE_URL is required for migration rehearsal.');
  }

  const databaseName = new URL(testDatabaseUrl).pathname.slice(1);
  if (databaseName !== 'kirindesk_test') {
    throw new Error(`Refusing migration rehearsal on database "${databaseName}".`);
  }

  process.env.DATABASE_URL = testDatabaseUrl;
  const pool = getPool();
  const before = await pool.query<MigrationRow>(
    'SELECT filename, checksum FROM _migrations ORDER BY filename DESC LIMIT 2',
  );
  const rehearsed = before.rows;
  if (rehearsed.length !== 2) {
    throw new Error('Two applied migrations are required; run integration tests first.');
  }

  for (const migration of rehearsed) {
    await rollback();
    const removed = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM _migrations WHERE filename = $1',
      [migration.filename],
    );
    if (removed.rows[0].count !== '0') {
      throw new Error(`Rollback did not remove ${migration.filename}.`);
    }
  }

  await migrate();
  const restored = await pool.query<MigrationRow>(
    'SELECT filename, checksum FROM _migrations ORDER BY filename DESC LIMIT 2',
  );
  for (const [index, migration] of rehearsed.entries()) {
    if (
      restored.rows[index]?.filename !== migration.filename ||
      restored.rows[index]?.checksum !== migration.checksum
    ) {
      throw new Error(`Migration ${migration.filename} did not round-trip with the same checksum.`);
    }
  }

  console.log(`Migration round-trip passed: ${rehearsed.map((row) => row.filename).join(', ')}`);
}

rehearse()
  .then(() => closePool())
  .catch((error: unknown) => {
    console.error(error);
    closePool().finally(() => process.exit(1));
  });
