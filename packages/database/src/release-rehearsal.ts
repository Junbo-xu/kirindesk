import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg, { type Pool } from 'pg';
import { computeRowHash, type AuditLogRow } from './verify-chain.js';
import { assertLoopbackPostgresUrl } from './release-rehearsal-guards.js';

const { Client, Pool: PgPool } = pg;
const ZERO_HASH = '0'.repeat(64);
const SOURCE_DATABASE_NAME = 'kirindesk_test';
const POSTGRES_IMAGE = 'postgres:16.10-alpine';
const BASELINE_MIGRATION = '049_stage_2e_finance_profit_commission.sql';
const RELEASE_MIGRATION = '051_kir_21_p0_web_remediation.sql';
const BASELINE_SOURCE_FILTERS: Record<string, string> = {
  finance_review_items: `subject_type <> 'after_sales_adjustment'`,
};

interface TableSnapshot {
  rows: string;
  tenantRows: Record<string, string>;
  numericTotals: Record<string, string>;
}

interface Snapshot {
  migrations: Array<{ filename: string; checksum: string }>;
  tables: Record<string, TableSnapshot>;
  orphanViolations: Array<{ constraint: string; rows: string }>;
  auditChains: Array<{ chainKey: string; rows: number; ok: boolean }>;
}

interface ForeignKey {
  constraint: string;
  childTable: string;
  parentTable: string;
  columns: Array<{ child: string; parent: string }>;
}

interface CopyEvidence {
  tables: number;
  rows: string;
  omittedRows: Record<string, string>;
}

interface TableColumn {
  name: string;
  json: boolean;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function databaseUrl(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function databaseName(connectionString: string): string {
  return new URL(connectionString).pathname.slice(1);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, {
    cwd: join(import.meta.dirname, '..', '..', '..'),
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}.`);
  }
}

function runPostgresTool(tool: string, args: string[], temporaryDirectory: string): void {
  run('docker', [
    'run',
    '--rm',
    '--network',
    'host',
    '--volume',
    `${temporaryDirectory}:/work`,
    POSTGRES_IMAGE,
    tool,
    ...args,
  ]);
}

async function listTables(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> '_migrations'
      ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function tableColumns(pool: Pool, table: string): Promise<TableColumn[]> {
  const { rows } = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => ({
    name: row.column_name,
    json: row.data_type === 'json' || row.data_type === 'jsonb',
  }));
}

async function copyBaselineData(
  sourcePool: Pool,
  targetPool: Pool,
  tables: string[],
): Promise<CopyEvidence> {
  const targetClient = await targetPool.connect();
  let copiedRows = 0n;
  const omittedRows: Record<string, string> = {};
  try {
    await targetClient.query('BEGIN');
    const privilege = await targetClient.query<{ is_superuser: string }>('SHOW is_superuser');
    if (privilege.rows[0]?.is_superuser !== 'on') {
      throw new Error('Release rehearsal admin database role must be a PostgreSQL superuser.');
    }
    await targetClient.query('SET LOCAL session_replication_role = replica');
    for (const table of tables) {
      const columns = await tableColumns(targetPool, table);
      if (columns.length === 0) continue;
      const quotedColumns = columns.map((column) => quoteIdentifier(column.name)).join(', ');
      const filter = BASELINE_SOURCE_FILTERS[table];
      const sourceRows = await sourcePool.query<Record<string, unknown>>(
        `SELECT ${quotedColumns} FROM ${quoteIdentifier(table)}${filter ? ` WHERE ${filter}` : ''}`,
      );
      if (filter) {
        const sourceCount = await sourcePool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${quoteIdentifier(table)}`,
        );
        const omitted =
          BigInt(sourceCount.rows[0]?.count ?? '0') - BigInt(sourceRows.rowCount ?? 0);
        if (omitted > 0n) omittedRows[table] = omitted.toString();
      }
      for (const row of sourceRows.rows) {
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        await targetClient.query(
          `INSERT INTO ${quoteIdentifier(table)} (${quotedColumns}) VALUES (${placeholders})`,
          columns.map((column) => {
            const value = row[column.name];
            return column.json && value !== null ? JSON.stringify(value) : value;
          }),
        );
      }
      copiedRows += BigInt(sourceRows.rowCount ?? 0);
    }
    await targetClient.query('COMMIT');
  } catch (error) {
    await targetClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    targetClient.release();
  }
  return { tables: tables.length, rows: copiedRows.toString(), omittedRows };
}

async function numericColumns(pool: Pool, table: string): Promise<string[]> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND data_type IN ('numeric', 'decimal')
      ORDER BY column_name`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function hasTenantColumn(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name = 'tenant_id'
     ) AS present`,
    [table],
  );
  return rows[0]?.present ?? false;
}

async function collectTable(pool: Pool, table: string): Promise<TableSnapshot> {
  const quotedTable = quoteIdentifier(table);
  const rowCount = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${quotedTable}`,
  );
  const tenantRows: Record<string, string> = {};
  if (await hasTenantColumn(pool, table)) {
    const grouped = await pool.query<{ tenant_id: string | null; count: string }>(
      `SELECT tenant_id::text, COUNT(*)::text AS count
         FROM ${quotedTable}
        GROUP BY tenant_id
        ORDER BY tenant_id NULLS FIRST`,
    );
    for (const row of grouped.rows) tenantRows[row.tenant_id ?? '<null>'] = row.count;
  }
  const numericTotals: Record<string, string> = {};
  for (const column of await numericColumns(pool, table)) {
    const result = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(${quoteIdentifier(column)}), 0)::text AS total FROM ${quotedTable}`,
    );
    numericTotals[column] = result.rows[0]?.total ?? '0';
  }
  return {
    rows: rowCount.rows[0]?.count ?? '0',
    tenantRows,
    numericTotals,
  };
}

async function foreignKeys(pool: Pool): Promise<ForeignKey[]> {
  const { rows } = await pool.query<{
    constraint_name: string;
    child_table: string;
    parent_table: string;
    columns: Array<{ child: string; parent: string }>;
  }>(
    `SELECT constraint_record.conname AS constraint_name,
            child.relname AS child_table,
            parent.relname AS parent_table,
            json_agg(
              json_build_object('child', child_column.attname, 'parent', parent_column.attname)
              ORDER BY child_key.ordinality
            ) AS columns
       FROM pg_constraint constraint_record
       JOIN pg_class child ON child.oid = constraint_record.conrelid
       JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = constraint_record.confrelid
       JOIN unnest(constraint_record.conkey) WITH ORDINALITY child_key(attnum, ordinality) ON true
       JOIN unnest(constraint_record.confkey) WITH ORDINALITY parent_key(attnum, ordinality)
         ON parent_key.ordinality = child_key.ordinality
       JOIN pg_attribute child_column
         ON child_column.attrelid = child.oid AND child_column.attnum = child_key.attnum
       JOIN pg_attribute parent_column
         ON parent_column.attrelid = parent.oid AND parent_column.attnum = parent_key.attnum
      WHERE constraint_record.contype = 'f'
        AND child_namespace.nspname = 'public'
      GROUP BY constraint_record.conname, child.relname, parent.relname
      ORDER BY constraint_record.conname`,
  );
  return rows.map((row) => ({
    constraint: row.constraint_name,
    childTable: row.child_table,
    parentTable: row.parent_table,
    columns: row.columns,
  }));
}

async function orphanViolations(pool: Pool): Promise<Array<{ constraint: string; rows: string }>> {
  const violations: Array<{ constraint: string; rows: string }> = [];
  for (const foreignKey of await foreignKeys(pool)) {
    const joins = foreignKey.columns
      .map(
        ({ child, parent }) =>
          `child.${quoteIdentifier(child)} = parent.${quoteIdentifier(parent)}`,
      )
      .join(' AND ');
    const populated = foreignKey.columns
      .map(({ child }) => `child.${quoteIdentifier(child)} IS NOT NULL`)
      .join(' AND ');
    const firstParentColumn = quoteIdentifier(foreignKey.columns[0].parent);
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM ${quoteIdentifier(foreignKey.childTable)} child
         LEFT JOIN ${quoteIdentifier(foreignKey.parentTable)} parent ON ${joins}
        WHERE ${populated}
          AND parent.${firstParentColumn} IS NULL`,
    );
    const count = result.rows[0]?.count ?? '0';
    if (count !== '0') violations.push({ constraint: foreignKey.constraint, rows: count });
  }
  return violations;
}

async function verifyAuditChains(
  pool: Pool,
): Promise<Array<{ chainKey: string; rows: number; ok: boolean }>> {
  const { rows: chains } = await pool.query<{
    chain_key: string;
    tenant_id: string | null;
    last_log_id: string | null;
    last_hash: string;
  }>(
    `SELECT chain_key, tenant_id::text, last_log_id::text, last_hash
       FROM audit_log_chains
      ORDER BY chain_key`,
  );
  const results: Array<{ chainKey: string; rows: number; ok: boolean }> = [];
  for (const chain of chains) {
    const parameters = chain.tenant_id === null ? [] : [chain.tenant_id];
    const condition = chain.tenant_id === null ? 'tenant_id IS NULL' : 'tenant_id = $1';
    const { rows } = await pool.query<AuditLogRow>(
      `SELECT id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
              before_json, after_json, metadata_json, request_id, ip_address, user_agent,
              reason, row_hash, prev_hash, hash_version, created_at
         FROM audit_logs
        WHERE ${condition}
        ORDER BY id ASC`,
      parameters,
    );
    let expectedPrevious = ZERO_HASH;
    let ok = true;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrevious || row.row_hash !== computeRowHash(row)) {
        ok = false;
        break;
      }
      expectedPrevious = row.row_hash;
    }
    const lastRow = rows.at(-1);
    if (
      chain.last_hash !== (lastRow?.row_hash ?? ZERO_HASH) ||
      chain.last_log_id !== (lastRow?.id ?? null)
    ) {
      ok = false;
    }
    results.push({ chainKey: chain.chain_key, rows: rows.length, ok });
  }
  return results;
}

async function snapshot(pool: Pool, selectedTables?: string[]): Promise<Snapshot> {
  const available = await listTables(pool);
  const tables = selectedTables ?? available;
  for (const table of tables) {
    if (!available.includes(table))
      throw new Error(`Expected table is missing after migration: ${table}`);
  }
  const tableSnapshots: Record<string, TableSnapshot> = {};
  for (const table of tables) tableSnapshots[table] = await collectTable(pool, table);
  const migrations = await pool.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM _migrations ORDER BY filename',
  );
  return {
    migrations: migrations.rows,
    tables: tableSnapshots,
    orphanViolations: await orphanViolations(pool),
    auditChains: await verifyAuditChains(pool),
  };
}

function assertHealthySnapshot(label: string, value: Snapshot): void {
  if (value.orphanViolations.length > 0) {
    throw new Error(`${label} contains orphan records: ${JSON.stringify(value.orphanViolations)}`);
  }
  const brokenChains = value.auditChains.filter((chain) => !chain.ok);
  if (brokenChains.length > 0) {
    throw new Error(`${label} contains broken audit chains: ${JSON.stringify(brokenChains)}`);
  }
}

function assertEqualSnapshot(label: string, before: Snapshot, after: Snapshot): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`${label} reconciliation failed.`);
  }
}

function assertEqualMigrationData(label: string, before: Snapshot, after: Snapshot): void {
  const beforeData = {
    tables: before.tables,
    orphanViolations: before.orphanViolations,
    auditChains: before.auditChains,
  };
  const afterData = {
    tables: after.tables,
    orphanViolations: after.orphanViolations,
    auditChains: after.auditChains,
  };
  if (JSON.stringify(beforeData) !== JSON.stringify(afterData)) {
    throw new Error(`${label} reconciliation failed.`);
  }
}

function assertEqualMigrations(
  expected: Snapshot['migrations'],
  actual: Snapshot['migrations'],
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Shadow migration ledger does not match the release candidate.');
  }
}

function reconciliationEvidence(value: Snapshot): {
  tables: number;
  rows: string;
  tenantPartitions: number;
  numericColumns: number;
  orphanViolations: number;
  auditChains: number;
  auditRows: number;
} {
  const tables = Object.values(value.tables);
  return {
    tables: tables.length,
    rows: tables.reduce((total, table) => total + BigInt(table.rows), 0n).toString(),
    tenantPartitions: tables.reduce(
      (total, table) => total + Object.keys(table.tenantRows).length,
      0,
    ),
    numericColumns: tables.reduce(
      (total, table) => total + Object.keys(table.numericTotals).length,
      0,
    ),
    orphanViolations: value.orphanViolations.length,
    auditChains: value.auditChains.length,
    auditRows: value.auditChains.reduce((total, chain) => total + chain.rows, 0),
  };
}

async function latestMigration(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{ filename: string }>(
    'SELECT filename FROM _migrations ORDER BY filename DESC LIMIT 1',
  );
  return rows[0]?.filename ?? null;
}

async function createTemporaryDatabase(maintenanceUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

async function dropTemporaryDatabase(maintenanceUrl: string, name: string): Promise<void> {
  const client = new Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally {
    await client.end();
  }
}

async function rehearse(): Promise<void> {
  const sourceUrl = process.env.TEST_DATABASE_URL;
  if (!sourceUrl) throw new Error('TEST_DATABASE_URL is required for release rehearsal.');
  assertLoopbackPostgresUrl(sourceUrl);
  if (databaseName(sourceUrl) !== SOURCE_DATABASE_NAME) {
    throw new Error(
      `Refusing release rehearsal on database "${databaseName(sourceUrl)}"; expected "${SOURCE_DATABASE_NAME}".`,
    );
  }
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const shadowName = `kirindesk_release_shadow_${suffix}`;
  const restoreName = `kirindesk_release_restore_${suffix}`;
  const maintenanceUrl = databaseUrl(sourceUrl, 'postgres');
  const shadowUrl = databaseUrl(sourceUrl, shadowName);
  const restoreUrl = databaseUrl(sourceUrl, restoreName);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'kirindesk-release-'));
  const dumpPath = '/work/source.dump';
  const createdDatabases: string[] = [];
  let sourcePool: Pool | undefined;
  let shadowPool: Pool | undefined;
  let restoredPool: Pool | undefined;

  try {
    sourcePool = new PgPool({ connectionString: sourceUrl });
    const sourceSnapshot = await snapshot(sourcePool);
    assertHealthySnapshot('source', sourceSnapshot);
    runPostgresTool(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-privileges', `--file=${dumpPath}`, sourceUrl],
      temporaryDirectory,
    );

    await createTemporaryDatabase(maintenanceUrl, shadowName);
    createdDatabases.push(shadowName);
    run('pnpm', ['--filter', '@kirindesk/database', 'migrate', `--target=${BASELINE_MIGRATION}`], {
      ...process.env,
      DATABASE_URL: shadowUrl,
    });
    shadowPool = new PgPool({ connectionString: shadowUrl });
    const baselineLatestMigration = await latestMigration(shadowPool);
    if (baselineLatestMigration !== BASELINE_MIGRATION) {
      throw new Error(
        `Shadow baseline ended at ${baselineLatestMigration ?? '<none>'}; expected ${BASELINE_MIGRATION}.`,
      );
    }
    const baselineTables = await listTables(shadowPool);
    const copiedSourceData = await copyBaselineData(sourcePool, shadowPool, baselineTables);
    const beforeMigration = await snapshot(shadowPool);
    assertHealthySnapshot('shadow before migration', beforeMigration);
    run('pnpm', ['--filter', '@kirindesk/database', 'migrate'], {
      ...process.env,
      DATABASE_URL: shadowUrl,
    });
    const afterMigration = await snapshot(shadowPool, baselineTables);
    assertHealthySnapshot('shadow after migration', afterMigration);
    assertEqualMigrationData('shadow migration', beforeMigration, afterMigration);
    assertEqualMigrations(sourceSnapshot.migrations, afterMigration.migrations);
    const candidateSnapshot = await snapshot(shadowPool);
    assertHealthySnapshot('shadow release candidate', candidateSnapshot);
    const appliedMigration = await latestMigration(shadowPool);
    if (appliedMigration !== RELEASE_MIGRATION) {
      throw new Error(
        `Shadow candidate ended at ${appliedMigration ?? '<none>'}; expected ${RELEASE_MIGRATION}.`,
      );
    }
    await shadowPool.end();
    shadowPool = undefined;
    await sourcePool.end();
    sourcePool = undefined;

    await createTemporaryDatabase(maintenanceUrl, restoreName);
    createdDatabases.push(restoreName);
    runPostgresTool(
      'pg_restore',
      ['--no-owner', '--no-privileges', `--dbname=${restoreUrl}`, dumpPath],
      temporaryDirectory,
    );
    restoredPool = new PgPool({ connectionString: restoreUrl });
    const restoredSnapshot = await snapshot(restoredPool);
    assertHealthySnapshot('restored backup', restoredSnapshot);
    assertEqualSnapshot('backup restore', sourceSnapshot, restoredSnapshot);
    await restoredPool.end();
    restoredPool = undefined;

    process.stdout.write(
      JSON.stringify(
        {
          status: 'PASS',
          sourceDatabase: SOURCE_DATABASE_NAME,
          shadowMigration: {
            baselineMigration: BASELINE_MIGRATION,
            appliedMigration,
            copiedSourceData,
            preservedBaseline: reconciliationEvidence(afterMigration),
            releaseCandidate: reconciliationEvidence(candidateSnapshot),
          },
          backupRestore: {
            reconciliation: reconciliationEvidence(restoredSnapshot),
          },
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await sourcePool?.end().catch(() => undefined);
    await shadowPool?.end().catch(() => undefined);
    await restoredPool?.end().catch(() => undefined);
    for (const name of createdDatabases.reverse()) {
      await dropTemporaryDatabase(maintenanceUrl, name).catch((error: unknown) => {
        process.stderr.write(
          `Failed to remove temporary database ${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
      });
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

rehearse().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
