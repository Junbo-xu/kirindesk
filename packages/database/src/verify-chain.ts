import { createHash } from 'node:crypto';
import { getPool, closePool } from './client.js';

const ZERO_HASH = '0'.repeat(64);

export function canonicalizeJson(obj: unknown): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalizeJson((obj as Record<string, unknown>)[k])
  );
  return '{' + parts.join(',') + '}';
}

interface AuditLogRow {
  id: string;
  tenant_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_json: unknown;
  after_json: unknown;
  metadata_json: unknown;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  reason: string | null;
  row_hash: string;
  prev_hash: string;
  hash_version: number;
  created_at: Date;
}

export function computeRowHash(row: AuditLogRow): string {
  const parts = [
    String(row.hash_version),
    row.prev_hash,
    row.tenant_id ?? '',
    row.actor_type,
    row.actor_id ?? '',
    row.action,
    row.resource_type,
    row.resource_id ?? '',
    canonicalizeJson(row.before_json),
    canonicalizeJson(row.after_json),
    canonicalizeJson(row.metadata_json),
    row.request_id ?? '',
    row.ip_address ?? '',
    row.user_agent ?? '',
    row.reason ?? '',
    row.created_at.toISOString(),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

export async function verifyChain(chainKey: string): Promise<{
  ok: boolean;
  total: number;
  failedAt?: { id: string; reason: string };
}> {
  const pool = getPool();

  const { rows: chains } = await pool.query<{ tenant_id: string | null }>(
    `SELECT tenant_id FROM audit_log_chains WHERE chain_key = $1`,
    [chainKey]
  );
  if (chains.length === 0) {
    throw new Error(`Chain not found: ${chainKey}`);
  }
  const tenantId = chains[0].tenant_id;

  const where = tenantId === null ? `tenant_id IS NULL` : `tenant_id = $1`;
  const params = tenantId === null ? [] : [tenantId];
  const { rows } = await pool.query<AuditLogRow>(
    `SELECT id, tenant_id, actor_type, actor_id, action, resource_type, resource_id,
            before_json, after_json, metadata_json, request_id, ip_address, user_agent,
            reason, row_hash, prev_hash, hash_version, created_at
       FROM audit_logs
       WHERE ${where}
       ORDER BY id ASC`,
    params
  );

  let expectedPrev = ZERO_HASH;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return {
        ok: false,
        total: rows.length,
        failedAt: { id: row.id, reason: 'prev_hash mismatch' },
      };
    }
    const computed = computeRowHash(row);
    if (computed !== row.row_hash) {
      return {
        ok: false,
        total: rows.length,
        failedAt: { id: row.id, reason: 'row_hash mismatch' },
      };
    }
    expectedPrev = row.row_hash;
  }
  return { ok: true, total: rows.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const chainKey = args[0] ?? 'platform';
  verifyChain(chainKey)
    .then((result) => {
      console.log(`Chain: ${chainKey}`);
      console.log(`Total entries: ${result.total}`);
      console.log(`Status: ${result.ok ? 'PASS' : 'FAIL'}`);
      if (!result.ok && result.failedAt) {
        console.log(`Failed at id=${result.failedAt.id}: ${result.failedAt.reason}`);
      }
      return closePool().then(() => process.exit(result.ok ? 0 : 1));
    })
    .catch((e) => {
      console.error(e);
      closePool().finally(() => process.exit(1));
    });
}
