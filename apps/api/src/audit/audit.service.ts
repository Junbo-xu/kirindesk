import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { APP_POOL } from '../database/database.module';
import { computeRowHash, type ChainRow } from './audit-chain.verify';

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

  /**
   * Append an audit record using the caller's open transaction. This is for
   * business mutations that must fail closed when the hash-chain cannot be
   * advanced. The caller must already have established the tenant context.
   */
  async logInTransaction(client: PoolClient, params: AuditLogParams): Promise<void> {
    await this.appendRow(client, params);
  }

  private async writeToChain(params: AuditLogParams): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_actor_type', $1, true)`, [
        params.tenantId === null ? params.actorType : 'system',
      ]);
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [
        params.tenantId ?? '',
      ]);

      await this.appendRow(client, params);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async appendRow(client: PoolClient, params: AuditLogParams): Promise<void> {
    const chainKey = params.tenantId ? `tenant:${params.tenantId}` : 'platform';
    const { rows } = await client.query<{ last_hash: string; last_log_id: string | null }>(
      `SELECT last_hash, last_log_id::text AS last_log_id
         FROM audit_log_chains
        WHERE chain_key = $1
        FOR UPDATE`,
      [chainKey],
    );
    if (rows.length === 0) {
      throw new Error(`Audit chain is not initialized: ${chainKey}`);
    }
    const head = rows[0];
    if (head.last_log_id === null) {
      if (head.last_hash !== '0'.repeat(64)) {
        throw new Error(`Audit chain genesis is invalid: ${chainKey}`);
      }
    } else {
      const latest = await client.query<ChainRow>(
        `SELECT id::text AS id, tenant_id, actor_type, actor_id, action,
                resource_type, resource_id, before_json, after_json, metadata_json,
                request_id, ip_address, user_agent, reason, row_hash, prev_hash,
                hash_version, created_at
           FROM audit_logs
          WHERE id = $1`,
        [head.last_log_id],
      );
      if (
        latest.rows.length !== 1 ||
        latest.rows[0].row_hash !== head.last_hash ||
        computeRowHash(latest.rows[0]) !== head.last_hash
      ) {
        throw new Error(`Audit chain head validation failed: ${chainKey}`);
      }
    }

    const prevHash = head.last_hash;
    const createdAt = new Date();

    // Hash exactly the JSON-safe values that are persisted in jsonb.
    const before = normalizeJsonValue(params.before);
    const after = normalizeJsonValue(params.after);
    const metadata = normalizeJsonValue(params.metadata);
    const rowHash = computeRowHash({
      id: '',
      tenant_id: params.tenantId,
      actor_type: params.actorType,
      actor_id: params.actorId,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId ?? null,
      before_json: before,
      after_json: after,
      metadata_json: metadata,
      request_id: params.requestId ?? null,
      ip_address: params.ipAddress ?? null,
      user_agent: params.userAgent ?? null,
      reason: params.reason ?? null,
      row_hash: '',
      prev_hash: prevHash,
      hash_version: 1,
      created_at: createdAt,
    });

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO audit_logs (tenant_id, actor_type, actor_id, action, resource_type, resource_id,
        before_json, after_json, metadata_json, request_id, ip_address, user_agent, reason,
        row_hash, prev_hash, hash_version, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,$16)
       RETURNING id::text AS id`,
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

    const advanced = await client.query(
      `UPDATE audit_log_chains
          SET last_log_id = $1, last_hash = $2, updated_at = now()
        WHERE chain_key = $3 AND last_hash = $4`,
      [inserted.rows[0].id, rowHash, chainKey, prevHash],
    );
    if (advanced.rowCount !== 1) {
      throw new Error(`Audit chain head changed unexpectedly: ${chainKey}`);
    }
  }
}
