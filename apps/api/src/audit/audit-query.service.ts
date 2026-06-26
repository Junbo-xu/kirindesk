import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { ActorType, withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { ListAuditLogsQuery } from './dto/list-audit-logs.query';
import { AuditExportQuery } from './dto/audit-export.query';
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
  // Session actor type for withTenantContext. Defaults to 'tenant_user' (the
  // 1I viewer). The platform support-access path (1K-B §3.4) passes
  // 'platform_admin' so the read session is honestly attributed — never
  // impersonating a tenant user. audit_logs_tenant_read keys on tenant_id, so
  // either actor type reads the same rows once the tenant context is set.
  actorType?: ActorType;
}

export interface ListResult {
  data: AuditLogSummary[];
  page: number;
  pageSize: number;
  total: number;
}

// Full filtered set for export, plus whether the cap clipped it (plan §2.4).
export interface ExportResult {
  data: AuditLogSummary[];
  truncated: boolean;
}

// The filter fields shared by list and export (the structural shape the WHERE
// builder consumes). Both ListAuditLogsQuery and AuditExportQuery satisfy it.
type AuditLogFilters = Pick<
  ListAuditLogsQuery,
  'from' | 'to' | 'actorId' | 'actorType' | 'action' | 'resourceType' | 'resourceId' | 'requestId'
>;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

// Hard ceiling on rows per audit export (plan §5.1): bounds memory/soft-DoS on
// the ever-growing append-only table. Overridable per call for tests.
export const AUDIT_EXPORT_CAP = 50000;

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

  // Shared WHERE builder for list + export (plan §3.6): dataScope (own anchors
  // to actor_id) plus the optional filters, all parameterized. Both paths use
  // this so the export set can never diverge from the list set.
  private buildWhere(
    actor: RequestActor,
    filters: AuditLogFilters,
  ): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Explicit tenant scope (plan §3.4 isolation). RLS already pins a
    // tenant_user to its own rows, but the platform support-access path sets the
    // session actor_type='platform_admin', and audit_logs_tenant_read also
    // exposes platform-global rows (tenant_id IS NULL) to that actor. Pinning
    // al.tenant_id = <tenant> here excludes those foreign-chain rows so a
    // support session sees ONLY the authorized tenant's events — a no-op for a
    // tenant_user (whose rows always carry this tenant_id).
    params.push(actor.tenantId);
    conditions.push(`al.tenant_id = $${params.length}`);

    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      conditions.push(`al.actor_id = $${params.length}`);
    }
    if (filters.from) {
      params.push(filters.from);
      conditions.push(`al.created_at >= $${params.length}`);
    }
    if (filters.to) {
      params.push(filters.to);
      conditions.push(`al.created_at <= $${params.length}`);
    }
    if (filters.actorId) {
      params.push(filters.actorId);
      conditions.push(`al.actor_id = $${params.length}`);
    }
    if (filters.actorType) {
      params.push(filters.actorType);
      conditions.push(`al.actor_type = $${params.length}`);
    }
    if (filters.action) {
      params.push(filters.action);
      conditions.push(`al.action = $${params.length}`);
    }
    if (filters.resourceType) {
      params.push(filters.resourceType);
      conditions.push(`al.resource_type = $${params.length}`);
    }
    if (filters.resourceId) {
      params.push(filters.resourceId);
      conditions.push(`al.resource_id = $${params.length}`);
    }
    if (filters.requestId) {
      params.push(filters.requestId);
      conditions.push(`al.request_id = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return { where, params };
  }

  async list(actor: RequestActor, query: ListAuditLogsQuery): Promise<ListResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const { where, params } = this.buildWhere(actor, query);

    return withTenantContext(
      this.pool,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
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

  /**
   * Read-only full-set fetch for export (plan §2.4/§3.6): same WHERE as list
   * (dataScope + filters + RLS), no offset, a single `LIMIT cap + 1` so we can
   * tell whether the cap clipped the result. Returns at most `cap` rows plus a
   * `truncated` flag — never silently drops rows.
   */
  async listForExport(
    actor: RequestActor,
    query: AuditExportQuery,
    cap: number = AUDIT_EXPORT_CAP,
  ): Promise<ExportResult> {
    const { where, params } = this.buildWhere(actor, query);

    return withTenantContext(
      this.pool,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
      async (client) => {
        const dataRes = await client.query<AuditLogRow>(
          `SELECT ${SUMMARY_COLUMNS}
             FROM audit_logs al
             ${ACTOR_JOIN}
             ${where}
            ORDER BY al.created_at DESC, al.id DESC
            LIMIT $${params.length + 1}`,
          [...params, cap + 1],
        );
        const truncated = dataRes.rows.length > cap;
        const rows = truncated ? dataRes.rows.slice(0, cap) : dataRes.rows;
        return { data: rows.map(toAuditLogSummary), truncated };
      },
    );
  }

  async getOne(actor: RequestActor, id: string): Promise<AuditLogDetail> {
    const row = await withTenantContext(
      this.pool,
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
      async (client) => {
        const params: unknown[] = [id];
        // Explicit tenant scope (see buildWhere): excludes platform-global
        // (tenant_id IS NULL) rows a platform_admin support session could
        // otherwise read via audit_logs_tenant_read; a no-op for tenant_user.
        params.push(actor.tenantId);
        let scopeClause = ` AND al.tenant_id = $${params.length}`;
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scopeClause += ` AND al.actor_id = $${params.length}`;
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
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actorType: actor.actorType ?? 'tenant_user',
      },
      async (client) => {
        // ORDER BY the bigint column (qualified) — NOT the `id::text` output
        // alias, which would sort lexicographically (1,10,100,…,2) and break the
        // chain order. Numeric id ASC reproduces the CLI's scan exactly.
        // tenant_id pinned explicitly: a platform_admin support session must
        // verify ONLY this tenant's chain, never the interleaved platform-global
        // (tenant_id IS NULL) rows audit_logs_tenant_read also exposes to it.
        // No-op for a tenant_user (RLS already pins it to this tenant).
        const { rows } = await client.query<ChainRow>(
          `SELECT al.id::text AS id, al.tenant_id, al.actor_type, al.actor_id, al.action,
                  al.resource_type, al.resource_id, al.before_json, al.after_json,
                  al.metadata_json, al.request_id, al.ip_address, al.user_agent, al.reason,
                  al.row_hash, al.prev_hash, al.hash_version, al.created_at
             FROM audit_logs al
            WHERE al.tenant_id = $1
            ORDER BY al.id ASC`,
          [actor.tenantId],
        );
        return verifyChainRows(rows);
      },
    );
  }
}
