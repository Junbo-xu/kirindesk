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

      const hashInput = [
        '1',
        prevHash,
        params.tenantId ?? '',
        params.actorType,
        params.actorId,
        params.action,
        params.resourceType,
        params.resourceId ?? '',
        canonicalizeJson(params.before),
        canonicalizeJson(params.after),
        canonicalizeJson(params.metadata),
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
          params.before ? JSON.stringify(params.before) : null,
          params.after ? JSON.stringify(params.after) : null,
          params.metadata ? JSON.stringify(params.metadata) : null,
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
