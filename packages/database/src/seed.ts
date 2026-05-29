import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEDS_DIR = join(__dirname, '..', '..', '..', 'db', 'seeds');

function isDevSeed(filename: string): boolean {
  return /dev/i.test(filename);
}

export async function seed(): Promise<void> {
  const env = process.env.NODE_ENV ?? 'development';
  const pool = getPool();

  const files = readdirSync(SEEDS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    if (isDevSeed(filename) && env === 'production') {
      console.log(`SKIP ${filename} (dev seed cannot run in production)`);
      continue;
    }

    const sql = readFileSync(join(SEEDS_DIR, filename), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`SEED ${filename}`);
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
  seed()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      closePool().finally(() => process.exit(1));
    });
}
