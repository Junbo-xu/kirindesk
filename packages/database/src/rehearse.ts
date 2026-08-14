import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { closePool, getPool } from './client.js';
import { migrate } from './migrate.js';
import { rollback } from './rollback.js';

const LEGACY_RELEASE_MIGRATION = '051_kir_21_p0_web_remediation.sql';
const MAIN_STAGE_A_MIGRATION = '054_kir_33_stage_a_quote_order_link.sql';
const CURRENT_RELEASE_MIGRATION = '057_customs_declarations.sql';
const LEGACY_RELEASE_CHECKSUM = '4e697e314712a1796550ef7cf8a6852a75ef1d7296cf489b0ab9f0d5b4fd0992';
const MAIN_STAGE_A_CHECKSUM = '7e8690c1c017d14a56839cd51bc20541f21b040a7a8272eb020d43492760f347';

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

interface MainStageAFixture {
  tenantId: string;
  userId: string;
  documentSetId: string;
  salesOrderId: string;
  quoteNumber: string;
  idempotencyKey: string;
}

async function latestMigration(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ filename: string }>(
    'SELECT filename FROM _migrations ORDER BY filename DESC LIMIT 1',
  );
  return result.rows[0]?.filename ?? null;
}

async function historicalLedger(
  pool: Pool,
  through = LEGACY_RELEASE_MIGRATION,
): Promise<MigrationLedgerRow[]> {
  const result = await pool.query<MigrationLedgerRow>(
    `SELECT id,
            filename,
            checksum,
            applied_at::text AS "appliedAt",
            execution_ms AS "executionMs"
       FROM _migrations
      WHERE filename <= $1
      ORDER BY id`,
    [through],
  );
  return result.rows;
}

async function createMainStageAFixture(pool: Pool): Promise<MainStageAFixture> {
  const source = await pool.query<{ tenantId: string; userId: string; customerId: string }>(
    `SELECT tenant.id AS "tenantId", tenant_user.id AS "userId", customer.id AS "customerId"
       FROM tenants tenant
       JOIN users tenant_user
         ON tenant_user.tenant_id = tenant.id
        AND tenant_user.status = 'active'
        AND tenant_user.deleted_at IS NULL
       JOIN customers customer
         ON customer.tenant_id = tenant.id
        AND customer.deleted_at IS NULL
      ORDER BY tenant.created_at, tenant_user.created_at, customer.created_at
      LIMIT 1`,
  );
  if (!source.rows[0]) {
    throw new Error('Main 054 upgrade rehearsal requires an existing tenant, user and customer.');
  }

  const suffix = randomUUID();
  const fixture: MainStageAFixture = {
    tenantId: source.rows[0].tenantId,
    userId: source.rows[0].userId,
    documentSetId: randomUUID(),
    salesOrderId: randomUUID(),
    quoteNumber: `MIG-054-${suffix.slice(0, 8)}`,
    idempotencyKey: randomUUID(),
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO trade_document_sets
         (id, tenant_id, owner_user_id, customer_id, quote_number)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        fixture.documentSetId,
        fixture.tenantId,
        fixture.userId,
        source.rows[0].customerId,
        fixture.quoteNumber,
      ],
    );
    await client.query(
      `INSERT INTO sales_orders
         (id, tenant_id, customer_id, owner_user_id, order_number, currency, total_amount,
          source_quote_id, source_quote_version, source_quote_number, source_quote_snapshot,
          source_quote_idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'USD',1,$6,1,$7,$8::jsonb,$9)`,
      [
        fixture.salesOrderId,
        fixture.tenantId,
        source.rows[0].customerId,
        fixture.userId,
        `SO-MIG-054-${suffix.slice(0, 8)}`,
        fixture.documentSetId,
        fixture.quoteNumber,
        JSON.stringify({ source: 'main-054', preserved: true }),
        fixture.idempotencyKey,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return fixture;
}

async function removeMainStageAFixture(pool: Pool, fixture: MainStageAFixture): Promise<void> {
  await pool.query('DELETE FROM sales_orders WHERE id = $1', [fixture.salesOrderId]);
  await pool.query('DELETE FROM trade_document_sets WHERE id = $1', [fixture.documentSetId]);
}

async function assertMainStageAUpgrade(pool: Pool, fixture: MainStageAFixture): Promise<void> {
  const result = await pool.query<{
    sourceDocumentSetId: string;
    quoteNumber: string;
    quoteVersion: number;
    snapshot: Record<string, unknown>;
    idempotencyKey: string;
    convertedBy: string;
    convertedAt: string;
  }>(
    `SELECT source_document_set_id AS "sourceDocumentSetId",
            source_quote_number AS "quoteNumber",
            source_quote_version AS "quoteVersion",
            source_quote_snapshot AS snapshot,
            source_quote_idempotency_key AS "idempotencyKey",
            source_quote_converted_by AS "convertedBy",
            source_quote_converted_at::text AS "convertedAt"
       FROM sales_orders
      WHERE id = $1`,
    [fixture.salesOrderId],
  );
  const order = result.rows[0];
  if (
    !order ||
    order.sourceDocumentSetId !== fixture.documentSetId ||
    order.quoteNumber !== fixture.quoteNumber ||
    order.quoteVersion !== 1 ||
    order.idempotencyKey !== fixture.idempotencyKey ||
    order.convertedBy !== fixture.userId ||
    !order.convertedAt ||
    order.snapshot.source !== 'main-054' ||
    order.snapshot.preserved !== true
  ) {
    throw new Error('Main 054 quote source data was not preserved by the compatibility upgrade.');
  }
}

async function rehearseMainStageAUpgrade(pool: Pool): Promise<void> {
  if ((await latestMigration(pool)) !== CURRENT_RELEASE_MIGRATION) {
    throw new Error(`Main 054 upgrade rehearsal must start at ${CURRENT_RELEASE_MIGRATION}.`);
  }
  while ((await latestMigration(pool)) !== MAIN_STAGE_A_MIGRATION) {
    await rollback();
  }

  const beforeLedger = await historicalLedger(pool, MAIN_STAGE_A_MIGRATION);
  const published = beforeLedger.find((row) => row.filename === MAIN_STAGE_A_MIGRATION);
  if (published?.checksum !== MAIN_STAGE_A_CHECKSUM) {
    throw new Error(
      `${MAIN_STAGE_A_MIGRATION} checksum is ${published?.checksum ?? '<missing>'}; ` +
        `expected published checksum ${MAIN_STAGE_A_CHECKSUM}.`,
    );
  }

  const fixture = await createMainStageAFixture(pool);
  try {
    await migrate();
    const afterLedger = await historicalLedger(pool, MAIN_STAGE_A_MIGRATION);
    if (JSON.stringify(afterLedger) !== JSON.stringify(beforeLedger)) {
      throw new Error('Forward migration modified the main 054 _migrations history.');
    }
    if ((await latestMigration(pool)) !== CURRENT_RELEASE_MIGRATION) {
      throw new Error(`Main 054 upgrade did not reach ${CURRENT_RELEASE_MIGRATION}.`);
    }
    await assertMainStageAUpgrade(pool, fixture);
  } finally {
    await removeMainStageAFixture(pool, fixture);
  }

  console.log(
    `Main forward migration passed: immutable ${MAIN_STAGE_A_MIGRATION}, quote source data preserved`,
  );
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
  while ((await latestMigration(pool)) !== LEGACY_RELEASE_MIGRATION) {
    await rollback();
  }
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
  await rehearseMainStageAUpgrade(pool);
  await rehearseLegacyUpgrade(pool);
}

rehearse()
  .then(() => closePool())
  .catch((error: unknown) => {
    console.error(error);
    closePool().finally(() => process.exit(1));
  });
