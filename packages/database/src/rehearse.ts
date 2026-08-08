import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { closePool, getPool } from './client.js';
import { migrate } from './migrate.js';
import { rollback } from './rollback.js';

const LEGACY_RELEASE_MIGRATION = '051_kir_21_p0_web_remediation.sql';
const CURRENT_RELEASE_MIGRATION = '052_backfill_inquiries_update_role_grants.sql';
const LEGACY_RELEASE_CHECKSUM = '4e697e314712a1796550ef7cf8a6852a75ef1d7296cf489b0ab9f0d5b4fd0992';

interface MigrationRow {
  filename: string;
  checksum: string;
}

interface MigrationLedgerRow extends MigrationRow {
  id: number;
  appliedAt: string;
  executionMs: number;
}

interface RoleFixture {
  tenantId: string;
  existingGrantRoleId: string;
  missingGrantRoleId: string;
}

async function latestMigration(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ filename: string }>(
    'SELECT filename FROM _migrations ORDER BY filename DESC LIMIT 1',
  );
  return result.rows[0]?.filename ?? null;
}

async function historicalLedger(pool: Pool): Promise<MigrationLedgerRow[]> {
  const result = await pool.query<MigrationLedgerRow>(
    `SELECT id,
            filename,
            checksum,
            applied_at::text AS "appliedAt",
            execution_ms AS "executionMs"
       FROM _migrations
      WHERE filename <= $1
      ORDER BY id`,
    [LEGACY_RELEASE_MIGRATION],
  );
  return result.rows;
}

async function createLegacyRoleFixtures(pool: Pool): Promise<RoleFixture> {
  const fixture: RoleFixture = {
    tenantId: randomUUID(),
    existingGrantRoleId: randomUUID(),
    missingGrantRoleId: randomUUID(),
  };
  const suffix = fixture.tenantId.slice(0, 8);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, name, slug)
       VALUES ($1, 'Migration rehearsal tenant', $2)`,
      [fixture.tenantId, `migration-rehearsal-${suffix}`],
    );
    await client.query(
      `INSERT INTO roles (id, tenant_id, name, description)
       VALUES ($1, $3, 'Existing update grant', 'Migration rehearsal fixture'),
              ($2, $3, 'Missing update grant', 'Migration rehearsal fixture')`,
      [fixture.existingGrantRoleId, fixture.missingGrantRoleId, fixture.tenantId],
    );
    await client.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
       SELECT $1, $2, permission.id, fixture.data_scope
         FROM (
           VALUES ('inquiries:create', 'all'),
                  ('inquiries:submit', 'all'),
                  ('inquiries:update', 'own')
         ) AS fixture(code, data_scope)
         JOIN permissions permission ON permission.code = fixture.code`,
      [fixture.tenantId, fixture.existingGrantRoleId],
    );
    await client.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
       SELECT $1, $2, permission.id, fixture.data_scope
         FROM (
           VALUES ('inquiries:create', 'all'),
                  ('inquiries:submit', 'assigned')
         ) AS fixture(code, data_scope)
         JOIN permissions permission ON permission.code = fixture.code`,
      [fixture.tenantId, fixture.missingGrantRoleId],
    );
    const grants = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM role_permissions WHERE tenant_id = $1',
      [fixture.tenantId],
    );
    if (grants.rows[0]?.count !== '5') {
      throw new Error('Legacy role fixture did not create all expected permission grants.');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return fixture;
}

async function removeLegacyRoleFixtures(pool: Pool, fixture: RoleFixture): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM role_permissions WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM roles WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertLegacyRoleUpgrade(pool: Pool, fixture: RoleFixture): Promise<void> {
  const roles = await pool.query<{ roleId: string; dataScope: string }>(
    `SELECT grant_record.role_id AS "roleId", grant_record.data_scope AS "dataScope"
       FROM role_permissions grant_record
       JOIN permissions permission ON permission.id = grant_record.permission_id
      WHERE grant_record.tenant_id = $1
        AND permission.code = 'inquiries:update'
      ORDER BY grant_record.role_id`,
    [fixture.tenantId],
  );
  const scopes = new Map(roles.rows.map((row) => [row.roleId, row.dataScope]));
  if (scopes.size !== 2) {
    throw new Error(`Expected two inquiries:update grants after upgrade; found ${scopes.size}.`);
  }
  if (scopes.get(fixture.existingGrantRoleId) !== 'own') {
    throw new Error('The pre-existing custom role grant was changed during upgrade.');
  }
  if (scopes.get(fixture.missingGrantRoleId) !== 'assigned') {
    throw new Error('The missing custom role grant was not backfilled with the narrowest scope.');
  }
}

async function rehearseLegacyUpgrade(pool: Pool): Promise<void> {
  if ((await latestMigration(pool)) !== CURRENT_RELEASE_MIGRATION) {
    throw new Error(`Legacy upgrade rehearsal must start at ${CURRENT_RELEASE_MIGRATION}.`);
  }
  await rollback();
  if ((await latestMigration(pool)) !== LEGACY_RELEASE_MIGRATION) {
    throw new Error(`Rollback did not produce a legacy ${LEGACY_RELEASE_MIGRATION} database.`);
  }

  const fixture = await createLegacyRoleFixtures(pool);
  try {
    const beforeLedger = await historicalLedger(pool);
    const legacyRow = beforeLedger.find((row) => row.filename === LEGACY_RELEASE_MIGRATION);
    if (legacyRow?.checksum !== LEGACY_RELEASE_CHECKSUM) {
      throw new Error(
        `${LEGACY_RELEASE_MIGRATION} checksum is ${legacyRow?.checksum ?? '<missing>'}; ` +
          `expected published checksum ${LEGACY_RELEASE_CHECKSUM}.`,
      );
    }

    await migrate();
    const afterLedger = await historicalLedger(pool);
    if (JSON.stringify(afterLedger) !== JSON.stringify(beforeLedger)) {
      throw new Error('Forward migration modified the legacy _migrations history.');
    }
    if ((await latestMigration(pool)) !== CURRENT_RELEASE_MIGRATION) {
      throw new Error(`Legacy upgrade did not reach ${CURRENT_RELEASE_MIGRATION}.`);
    }
    await assertLegacyRoleUpgrade(pool, fixture);
  } finally {
    await removeLegacyRoleFixtures(pool, fixture);
  }

  console.log(
    `Legacy forward migration passed: immutable ${LEGACY_RELEASE_MIGRATION}, custom grants preserved`,
  );
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
  await rehearseLegacyUpgrade(pool);
}

rehearse()
  .then(() => closePool())
  .catch((error: unknown) => {
    console.error(error);
    closePool().finally(() => process.exit(1));
  });
