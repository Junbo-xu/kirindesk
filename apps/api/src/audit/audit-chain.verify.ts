import { createHash } from 'node:crypto';

/**
 * Read-only re-verification of the tenant audit hash-chain (plan §2.4/§3.4).
 *
 * This MUST stay byte-for-byte identical to
 * `packages/database/src/verify-chain.ts` (computeRowHash / canonicalizeJson /
 * the ZERO_HASH-seeded prev_hash scan) so that this endpoint and the CLI
 * `pnpm db:verify-chain tenant:<id>` can never disagree ("CLI PASS / page FAIL"
 * drift). The algorithm is duplicated rather than imported because the API is
 * CommonJS while @kirindesk/database is an ESM (raw-TS) package — the same
 * reason AuditService re-implements the write-side hash inline. If the canonical
 * algorithm in the database package ever changes, change it here in lockstep.
 *
 * Pure functions only — no DB access. The caller selects the tenant's rows
 * (RLS-scoped, ordered by id ASC) and passes them in.
 */

const ZERO_HASH = '0'.repeat(64);

export function canonicalizeJson(obj: unknown): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalizeJson((obj as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

export interface ChainRow {
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

export function computeRowHash(row: ChainRow): string {
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

export interface ChainVerifyResult {
  ok: boolean;
  total: number;
  failedAt?: { id: string; reason: string };
}

/**
 * Recomputes each row hash and checks the prev_hash linkage, starting from
 * ZERO_HASH (chain genesis). `rows` MUST be the full tenant chain ordered by
 * id ASC. Returns the aggregate conclusion plus the first failure point only —
 * no per-row hash listing, no repair (plan §3.4).
 */
export function verifyChainRows(rows: ChainRow[]): ChainVerifyResult {
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
