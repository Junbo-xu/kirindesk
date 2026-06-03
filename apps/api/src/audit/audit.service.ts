import { Injectable, Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';

type PublicActorType = 'tenant_user' | 'platform_admin';

export interface AuditLogParams {
  tenantId: string | null;
  actorType: PublicActorType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  reason?: string | null;
}

function canonicalizeJson(obj: unknown): string {
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

// Round-trips a value through JSON so the bytes used for the hash are exactly
// the bytes stored in jsonb. JSON.stringify applies Date#toJSON (-> ISO
// string), drops undefined object members, etc., giving a stable JSON-safe
// shape. Returns undefined when there is nothing to store (null/undefined or a
// value that serializes to nothing), which the caller maps to a SQL NULL.
function normalizeJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  return JSON.parse(json);
}

@Injectable()
export class AuditService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  async log(params: AuditLogParams): Promise<void> {
    await this.writeToChain(params);
  }

  private async writeToChain(params: AuditLogParams): Promise<void> {
    const chainKey = params.tenantId ? `tenant:${params.tenantId}` : 'platform';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_actor_type', 'system', true)`);
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
        params.tenantId ?? '',
      ]);

      const { rows } = await client.query(
        `SELECT last_hash FROM audit_log_chains WHERE chain_key = $1 FOR UPDATE`,
        [chainKey],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return;
      }
      const prevHash = rows[0].last_hash as string;
      const createdAt = new Date();

      // Normalize before/after/metadata exactly once, then use the SAME value
      // for both the hash input and the DB insert. The hash and the stored
      // jsonb must derive from identical bytes, or verifyChain (which re-reads
      // the stored jsonb) recomputes a different hash. A JSON round-trip also
      // makes the payload JSON-safe: Date -> ISO string via Date#toJSON, so a
      // Date in before/after no longer hashes as `{}` at write time and as a
      // string at verify time.
      const before = normalizeJsonValue(params.before);
      const after = normalizeJsonValue(params.after);
      const metadata = normalizeJsonValue(params.metadata);

      const hashInput = [
        '1',
        prevHash,
        params.tenantId ?? '',
        params.actorType,
        params.actorId,
        params.action,
        params.resourceType,
        params.resourceId ?? '',
        canonicalizeJson(before),
        canonicalizeJson(after),
        canonicalizeJson(metadata),
        params.requestId ?? '',
        params.ipAddress ?? '',
        params.userAgent ?? '',
        params.reason ?? '',
        createdAt.toISOString(),
      ].join('|');
      const rowHash = createHash('sha256').update(hashInput).digest('hex');

      await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, resource_type, resource_id,
          before_json, after_json, metadata_json, request_id, ip_address, user_agent, reason,
          row_hash, prev_hash, hash_version, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,$16)`,
        [
          params.tenantId,
          params.actorType,
          params.actorId,
          params.action,
          params.resourceType,
          params.resourceId ?? null,
          before === undefined ? null : JSON.stringify(before),
          after === undefined ? null : JSON.stringify(after),
          metadata === undefined ? null : JSON.stringify(metadata),
          params.requestId ?? null,
          params.ipAddress ?? null,
          params.userAgent ?? null,
          params.reason ?? null,
          rowHash,
          prevHash,
          createdAt,
        ],
      );

      const idResult = await client.query(`SELECT currval('audit_logs_id_seq') as id`);
      await client.query(
        `UPDATE audit_log_chains SET last_log_id = $1, last_hash = $2, updated_at = now() WHERE chain_key = $3`,
        [idResult.rows[0].id, rowHash, chainKey],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
