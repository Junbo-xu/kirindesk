import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'db', 'migrations');

function extractDown(sql: string): string {
  const lines = sql.split('\n');
  const downIdx = lines.findIndex((l) => l.trim() === '-- DOWN');
  if (downIdx === -1) return '';
  return lines.slice(downIdx + 1).join('\n').trim();
}

export async function rollback(): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query<{ filename: string }>(
    `SELECT filename FROM _migrations ORDER BY filename DESC LIMIT 1`
  );
  if (rows.length === 0) {
    console.log('No migrations to roll back.');
    return;
  }

  const filename = rows[0].filename;
  const all = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  if (!all.includes(filename)) {
    throw new Error(
      `Cannot roll back ${filename}: file not found in migrations directory.`
    );
  }

  const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
  const downSql = extractDown(sql);
  if (!downSql) {
    throw new Error(`Migration ${filename} has no -- DOWN section.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(downSql);
    await client.query(`DELETE FROM _migrations WHERE filename = $1`, [filename]);
    await client.query('COMMIT');
    console.log(`DOWN ${filename}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`FAIL rollback ${filename}`);
    throw e;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  rollback()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      closePool().finally(() => process.exit(1));
    });
}
