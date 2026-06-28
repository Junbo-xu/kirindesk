import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notification/notification.service';
import { ListTenantsQuery, TenantStatus } from './dto/list-tenants.query';

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  suspended_at: Date | null;
  suspended_reason: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListResult {
  data: TenantSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export type LifecycleAction = 'suspend' | 'deactivate' | 'activate';

// State machine for tenant lifecycle (plan §3.2). Each action lists the
// statuses it may transition FROM; anything else is an illegal transition (409).
const TRANSITIONS: Record<
  LifecycleAction,
  { from: TenantStatus[]; to: TenantStatus; auditAction: string }
> = {
  suspend: { from: ['active'], to: 'suspended', auditAction: 'tenant.suspended' },
  deactivate: {
    from: ['active', 'suspended'],
    to: 'deactivated',
    auditAction: 'tenant.deactivated',
  },
  activate: { from: ['suspended', 'deactivated'], to: 'active', auditAction: 'tenant.activated' },
};

const META_COLUMNS = `id, name, slug, status, suspended_at, suspended_reason,
       contact_email, contact_phone, created_at, updated_at`;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

/**
 * Platform-side tenant lifecycle (plan §3.4). Reads/writes the tenants registry
 * (no RLS — global table) and audits every status change into the TENANT's own
 * hash chain (actor_type=platform_admin), so the tenant can see it via the 1I
 * audit viewer. Returns metadata only — never tenant business data.
 */
@Injectable()
export class PlatformTenantsService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
    private readonly notification: NotificationService,
  ) {}

  async list(query: ListTenantsQuery): Promise<ListResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const conditions = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const totalRes = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tenants ${where}`,
      params,
    );
    const dataRes = await this.pool.query<TenantRow>(
      `SELECT ${META_COLUMNS} FROM tenants ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset],
    );
    return {
      data: dataRes.rows.map(toTenantSummary),
      page,
      pageSize,
      total: parseInt(totalRes.rows[0].count, 10),
    };
  }

  async getOne(id: string): Promise<TenantSummary> {
    const { rows } = await this.pool.query<TenantRow>(
      `SELECT ${META_COLUMNS} FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (rows.length === 0) {
      throw new NotFoundException('Tenant not found');
    }
    return toTenantSummary(rows[0]);
  }

  /**
   * Applies a lifecycle transition under a row lock, then audits it. Illegal
   * transitions (e.g. suspend a non-active tenant, activate an active one) are
   * 409; a missing tenant is 404.
   */
  async transition(
    adminId: string,
    id: string,
    action: LifecycleAction,
    reason: string | null,
  ): Promise<TenantSummary> {
    const spec = TRANSITIONS[action];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query<{ status: string }>(
        `SELECT status FROM tenants WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id],
      );
      if (cur.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new NotFoundException('Tenant not found');
      }
      const fromStatus = cur.rows[0].status;
      if (!spec.from.includes(fromStatus as TenantStatus)) {
        await client.query('ROLLBACK');
        throw new ConflictException(`Cannot ${action} a tenant in status '${fromStatus}'`);
      }

      // suspend/deactivate stamp the non-active transition; activate clears it.
      const suspending = spec.to !== 'active';
      const { rows } = await client.query<TenantRow>(
        `UPDATE tenants
            SET status = $2,
                suspended_at = ${suspending ? 'now()' : 'NULL'},
                suspended_reason = ${suspending ? '$3' : 'NULL'},
                updated_at = now()
          WHERE id = $1
        RETURNING ${META_COLUMNS}`,
        suspending ? [id, spec.to, reason] : [id, spec.to],
      );
      await client.query('COMMIT');

      // Audit into the TENANT's chain so the tenant sees it (plan §3.4). The
      // write goes through AuditService (session actor=system), which the
      // audit_logs_system_insert policy permits regardless of the row's
      // platform_admin actor_type — no audit_logs policy change needed.
      await this.auditService.log({
        tenantId: id,
        actorType: 'platform_admin',
        actorId: adminId,
        action: spec.auditAction,
        resourceType: 'tenant',
        resourceId: id,
        reason: reason ?? undefined,
        metadata: { fromStatus, toStatus: spec.to },
      });

      // Notify tenant owner on suspend (best-effort).
      if (action === 'suspend') {
        void this._notifyOwner(id, rows[0].name, reason).catch(() => {});
      }

      return toTenantSummary(rows[0]);
    } catch (e) {
      // ROLLBACK already issued on the handled throws above; guard the rest.
      if (!(e instanceof NotFoundException) && !(e instanceof ConflictException)) {
        await client.query('ROLLBACK').catch(() => {});
      }
      throw e;
    } finally {
      client.release();
    }
  }

  private async _notifyOwner(
    tenantId: string,
    tenantName: string,
    reason: string | null,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ email: string }>(
        `SELECT u.email FROM users u
           JOIN tenants t ON t.owner_user_id = u.id
          WHERE t.id = $1 AND u.deleted_at IS NULL LIMIT 1`,
        [tenantId],
      );
      if (rows.length === 0) return;
      await this.notification.send(
        tenantId,
        tenantId,
        'support_access',
        rows[0].email,
        '您的租户已被暂停',
        `租户 ${tenantName} 已被平台暂停。${reason ? `原因：${reason}` : ''}`,
      );
    } finally {
      client.release();
    }
  }
}

export function toTenantSummary(row: TenantRow): TenantSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    suspendedAt: row.suspended_at,
    suspendedReason: row.suspended_reason,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
