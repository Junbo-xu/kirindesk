import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load the repo .env only when present, and never override injected env vars —
// in a migration/seed container the environment is the source of truth (Phase 3A).
const envPath = resolve(__dirname, '..', '..', '..', '.env');
if (existsSync(envPath)) {
  config({ path: envPath, override: false });
}

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type { Pool, PoolClient } from 'pg';
