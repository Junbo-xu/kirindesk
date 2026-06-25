import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { ListAuditLogsQuery } from './dto/list-audit-logs.query';
import {
  AuditLogDetail,
  AuditLogNotFoundException,
  AuditLogRow,
  AuditLogSummary,
  toAuditLogDetail,
  toAuditLogSummary,
} from './audit-log.response';
import { ChainRow, ChainVerifyResult, verifyChainRows } from './audit-chain.verify';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface ListResult {
  data: AuditLogSummary[];
  page: number;
  pageSize: number;
  total: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

// Columns selected for list rows (summary shape). actor_name comes from a
// tenant-safe LEFT JOIN on users (same tenant by RLS). Hash-chain internals are
// never selected into the response.
const SUMMARY_COLUMNS = `al.id::text AS id, al.tenant_id, al.actor_type, al.actor_id,
       u.name AS actor_name, al.action, al.resource_type, al.resource_id, al.created_at`;

// Detail adds the snapshot/context columns; still no hash-chain internals.
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, al.before_json, al.after_json, al.metadata_json,
       al.reason, al.request_id, al.ip_address, al.user_agent`;

const ACTOR_JOIN = `LEFT JOIN users u ON u.id = al.actor_id AND al.actor_type = 'tenant_user'`;

/**
 * Read-only query service for the audit-log viewer (plan §3.6). Strictly
 * separate from the write-side AuditService (which is untouched). Every read
 * runs inside withTenantContext so the audit_logs FORCE-RLS policy
 * (tenant_id = app_current_tenant_id()) scopes results to the caller's tenant;
 * dataScope is pushed into the WHERE on top of that.
 */
@Injectable()
export class AuditQueryService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  // own/assigned narrow to events the caller themself initiated. Audit rows
  // carry no resource-owner field, so `own` can only anchor to actor_id — i.e.
  // "operations I performed" (plan §4.1.4).
  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  async list(actor: RequestActor, query: ListAuditLogsQuery): Promise<ListResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      conditions.push(`al.actor_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      conditions.push(`al.created_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`al.created_at <= $${params.length}`);
    }
    if (query.actorId) {
      params.push(query.actorId);
      conditions.push(`al.actor_id = $${params.length}`);
    }
    if (query.actorType) {
      params.push(query.actorType);
      conditions.push(`al.actor_type = $${params.length}`);
    }
    if (query.action) {
      params.push(query.action);
      conditions.push(`al.action = $${params.length}`);
    }
    if (query.resourceType) {
      params.push(query.resourceType);
      conditions.push(`al.resource_type = $${params.length}`);
    }
    if (query.resourceId) {
      params.push(query.resourceId);
      conditions.push(`al.resource_id = $${params.length}`);
    }
    if (query.requestId) {
      params.push(query.requestId);
      conditions.push(`al.request_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const totalRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM audit_logs al ${where}`,
          params,
        );
        const dataRes = await client.query<AuditLogRow>(
          `SELECT ${SUMMARY_COLUMNS}
             FROM audit_logs al
             ${ACTOR_JOIN}
             ${where}
            ORDER BY al.created_at DESC, al.id DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
        return {
          data: dataRes.rows.map(toAuditLogSummary),
          page,
          pageSize,
          total: parseInt(totalRes.rows[0].count, 10),
        };
      },
    );
  }

  async getOne(actor: RequestActor, id: string): Promise<AuditLogDetail> {
    const row = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [id];
        let scopeClause = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scopeClause = ` AND al.actor_id = $${params.length}`;
        }
        // id is a bigint passed as a digit string (controller constrains :id to
        // \d+); never parsed to a JS number, so large ids keep full precision.
        const { rows } = await client.query<AuditLogRow>(
          `SELECT ${DETAIL_COLUMNS}
             FROM audit_logs al
             ${ACTOR_JOIN}
            WHERE al.id = $1${scopeClause}`,
          params,
        );
        if (rows.length === 0) {
          throw new AuditLogNotFoundException();
        }
        return rows[0];
      },
    );
    return toAuditLogDetail(row);
  }

  /**
   * Verifies the caller's own tenant audit chain. The chain_key is derived
   * server-side from the authenticated tenantId and never accepted from the
   * client — audit_log_chains has no RLS, so a client-supplied chain_key could
   * probe/verify another tenant's chain (plan §2.2/§4.1.2). RLS scopes
   * audit_logs to this tenant, so selecting all rows ordered by id ASC
   * reproduces exactly the CLI's per-tenant chain scan.
   */
  async verifyTenantChain(actor: RequestActor): Promise<ChainVerifyResult> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        // ORDER BY the bigint column (qualified) — NOT the `id::text` output
        // alias, which would sort lexicographically (1,10,100,…,2) and break the
        // chain order. Numeric id ASC reproduces the CLI's scan exactly.
        const { rows } = await client.query<ChainRow>(
          `SELECT al.id::text AS id, al.tenant_id, al.actor_type, al.actor_id, al.action,
                  al.resource_type, al.resource_id, al.before_json, al.after_json,
                  al.metadata_json, al.request_id, al.ip_address, al.user_agent, al.reason,
                  al.row_hash, al.prev_hash, al.hash_version, al.created_at
             FROM audit_logs al
            ORDER BY al.id ASC`,
        );
        return verifyChainRows(rows);
      },
    );
  }
}
