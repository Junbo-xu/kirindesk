import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'db', 'migrations');

interface MigrateOptions {
  target?: string;
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Substitute ${VAR} placeholders with env values, escaped for a single-quoted
// SQL string literal. Lets a migration take a runtime secret (e.g. the app-role
// password) from the environment instead of hardcoding it. Checksums are
// computed on the RAW file (placeholder intact), so the recorded checksum is
// stable across deployments regardless of the substituted value. Does not
// collide with Postgres $$ dollar-quoting (requires {NAME}). Fail-fast on a
// missing var so we never silently apply an empty/wrong secret.
export function substituteEnv(sql: string): string {
  return sql.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const val = process.env[name];
    if (val === undefined || val === '') {
      throw new Error(`Migration references \${${name}} but env var ${name} is not set.`);
    }
    return val.replace(/'/g, "''");
  });
}

function extractSection(sql: string, marker: '-- UP' | '-- DOWN'): string {
  const lines = sql.split('\n');
  const upIdx = lines.findIndex((l) => l.trim() === '-- UP');
  const downIdx = lines.findIndex((l) => l.trim() === '-- DOWN');
  if (upIdx === -1) {
    throw new Error('Migration file missing -- UP marker');
  }
  if (marker === '-- UP') {
    const end = downIdx === -1 ? lines.length : downIdx;
    return lines
      .slice(upIdx + 1, end)
      .join('\n')
      .trim();
  } else {
    if (downIdx === -1) return '';
    return lines
      .slice(downIdx + 1)
      .join('\n')
      .trim();
  }
}

export function selectMigrationFiles(files: string[], target?: string): string[] {
  const migrationFiles = files.filter((file) => file.endsWith('.sql')).sort();
  if (!target) return migrationFiles;
  const targetIndex = migrationFiles.indexOf(target);
  if (targetIndex === -1) {
    throw new Error(`Migration target ${target} does not exist.`);
  }
  return migrationFiles.slice(0, targetIndex + 1);
}

function targetFromArguments(args: string[]): string | undefined {
  const targetArguments = args.filter((argument) => argument.startsWith('--target='));
  if (targetArguments.length > 1) {
    throw new Error('Migration accepts at most one --target=<filename> argument.');
  }
  const target = targetArguments[0]?.slice('--target='.length);
  if (targetArguments.length === 1 && !target) {
    throw new Error('Migration target filename cannot be empty.');
  }
  const unsupported = args.filter((argument) => !argument.startsWith('--target='));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported migration argument: ${unsupported[0]}`);
  }
  return target;
}

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id serial PRIMARY KEY,
      filename varchar(200) NOT NULL UNIQUE,
      checksum varchar(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL
    );
  `);
}

export async function migrate(options: MigrateOptions = {}): Promise<void> {
  await ensureMigrationsTable();
  const pool = getPool();

  const allFiles = selectMigrationFiles(readdirSync(MIGRATIONS_DIR));
  const files = selectMigrationFiles(allFiles, options.target);

  const { rows: applied } = await pool.query<{
    filename: string;
    checksum: string;
  }>(`SELECT filename, checksum FROM _migrations ORDER BY filename ASC`);
  const appliedBeyondTarget = options.target
    ? applied.find((row) => allFiles.indexOf(row.filename) > allFiles.indexOf(options.target!))
    : undefined;
  if (appliedBeyondTarget) {
    throw new Error(
      `Database already contains ${appliedBeyondTarget.filename}, which is beyond target ${options.target}.`,
    );
  }
  const appliedMap = new Map(applied.map((r) => [r.filename, r.checksum]));

  for (const filename of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
    const sum = checksum(sql);

    if (appliedMap.has(filename)) {
      if (appliedMap.get(filename) !== sum) {
        throw new Error(
          `Migration ${filename} has been modified after being applied. ` +
            `Stored checksum does not match current file content.`,
        );
      }
      continue;
    }

    const upSql = substituteEnv(extractSection(sql, '-- UP'));
    if (!upSql) {
      console.log(`SKIP ${filename} (empty UP section)`);
      continue;
    }

    const client = await pool.connect();
    const startedAt = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(upSql);
      const ms = Date.now() - startedAt;
      await client.query(
        `INSERT INTO _migrations (filename, checksum, execution_ms) VALUES ($1, $2, $3)`,
        [filename, sum, ms],
      );
      await client.query('COMMIT');
      console.log(`UP   ${filename}  (${ms}ms)`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`FAIL ${filename}`);
      throw e;
    } finally {
      client.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate({ target: targetFromArguments(process.argv.slice(2)) })
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      closePool().finally(() => process.exit(1));
    });
}
