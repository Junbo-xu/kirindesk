import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notification/notification.service';
import { CreateSupportAccessDto } from './dto/create-support-access.dto';
import { ListSupportAccessQuery } from './dto/list-support-access.query';
import {
  GRANT_ADMIN_JOIN,
  GRANT_COLUMNS,
  GRANT_RETURNING_COLUMNS,
  SupportAccessGrantAlreadyActiveException,
  SupportAccessGrantAlreadyRevokedException,
  SupportAccessGrantNotFoundException,
  SupportAccessGrantRow,
  SupportAccessGrantSummary,
  toSupportAccessGrantSummary,
} from './support-access.response';

// The caller (a tenant user) authorizing/viewing support access. dataScope is
// always 'all' for these endpoints (plan §3.7): a grant is a tenant-management
// record with no resource owner, so own-scope is meaningless — the controller
// still passes the resolved scope, and RLS isolates by tenant regardless.
export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface ListResult {
  data: SupportAccessGrantSummary[];
  page: number;
  pageSize: number;
  total: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const UNIQUE_VIOLATION = '23505';

/**
 * Tenant-side support-access authorization (plan §3.3). A tenant user with
 * support_access:grant/revoke/view manages who (which named platform admin) may
 * read this tenant's data, in what scope, until when. Every write runs inside
 * withTenantContext (RLS isolates to the caller's tenant) and is audited into
 * the tenant chain. Validity is DERIVED at read time (the platform path trusts
 * app_check_support_access, not status alone) — this service only drives the
 * lifecycle status machine: ∅ → active → revoked (plan §3.2).
 */
@Injectable()
export class SupportAccessService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
    private readonly notification: NotificationService,
  ) {}

  async create(
    actor: RequestActor,
    dto: CreateSupportAccessDto,
  ): Promise<SupportAccessGrantSummary> {
    // expiresAt must be in the future. @IsISO8601 only validates the format.
    const expiresAt = new Date(dto.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expiresAt must be a future timestamp');
    }

    // Resolve email → platform_admin_id. platform_admins is a global table (no
    // RLS); an unknown OR inactive admin is an opaque 404 so a tenant cannot
    // probe which platform-admin emails exist (plan §3.3).
    const adminRes = await this.pool.query<{ id: string }>(
      `SELECT id FROM platform_admins WHERE email = $1 AND status = 'active'`,
      [dto.platformAdminEmail],
    );
    if (adminRes.rows.length === 0) {
      throw new SupportAccessGrantNotFoundException();
    }
    const platformAdminId = adminRes.rows[0].id;

    const row = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        // Pre-check the single-active rule for a clean 409; the partial-unique
        // index uq_sag_one_active is the race-safe backstop (caught below).
        const dup = await client.query(
          `SELECT 1 FROM support_access_grants
            WHERE platform_admin_id = $1 AND status = 'active' LIMIT 1`,
          [platformAdminId],
        );
        if (dup.rows.length > 0) {
          throw new SupportAccessGrantAlreadyActiveException();
        }
        try {
          // One-step grant (plan §3.2): land directly as active, stamp
          // approved_at now. pending/expired exist in the CHECK for future use.
          const inserted = await client.query<SupportAccessGrantRow>(
            `INSERT INTO support_access_grants
               (tenant_id, platform_admin_id, scope, reason, status, expires_at,
                granted_by_user_id, approved_at)
             VALUES ($1, $2, $3, $4, 'active', $5, $6, now())
             RETURNING ${GRANT_RETURNING_COLUMNS}`,
            [
              actor.tenantId,
              platformAdminId,
              dto.scope,
              dto.reason,
              expiresAt.toISOString(),
              actor.userId,
            ],
          );
          return inserted.rows[0];
        } catch (e) {
          if ((e as { code?: string }).code === UNIQUE_VIOLATION) {
            throw new SupportAccessGrantAlreadyActiveException();
          }
          throw e;
        }
      },
    );

    // Audit AFTER commit (tenant chain). Identifiers + terms only, no secrets.
    await this.auditService.log({
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action: 'support_access.granted',
      resourceType: 'support_access_grant',
      resourceId: row.id,
      reason: dto.reason,
      metadata: { platformAdminId, scope: dto.scope, expiresAt: expiresAt.toISOString() },
    });

    // Notify tenant owner that a support admin has been granted access (best-effort).
    void this._notifyOwnerOfGrant(
      actor.tenantId,
      actor.userId,
      dto.platformAdminEmail,
      expiresAt.toISOString(),
    ).catch(() => {});

    // Backfill the joined email for the response (RETURNING used NULL above).
    return toSupportAccessGrantSummary({ ...row, platform_admin_email: dto.platformAdminEmail });
  }

  private async _notifyOwnerOfGrant(
    tenantId: string,
    actorId: string,
    adminEmail: string,
    expiresAt: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      await client.query(`SELECT set_config('app.current_actor_type', 'tenant_user', true)`);
      const { rows } = await client.query<{ email: string }>(
        `SELECT email FROM users WHERE is_tenant_owner = true AND deleted_at IS NULL LIMIT 1`,
      );
      await client.query('COMMIT');
      if (rows.length === 0) return;
      await this.notification.send(
        tenantId,
        actorId,
        'support_access',
        rows[0].email,
        '平台支持访问已授权',
        `您已授权 ${adminEmail} 对租户进行只读访问，有效期至 ${new Date(expiresAt).toLocaleString('zh-CN')}。`,
      );
    } catch {
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      client.release();
    }
  }

  async list(actor: RequestActor, query: ListSupportAccessQuery): Promise<ListResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.status) {
      params.push(query.status);
      conditions.push(`g.status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const totalRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM support_access_grants g ${where}`,
          params,
        );
        const dataRes = await client.query<SupportAccessGrantRow>(
          `SELECT ${GRANT_COLUMNS}
             FROM support_access_grants g
             ${GRANT_ADMIN_JOIN}
             ${where}
            ORDER BY g.created_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
        return {
          data: dataRes.rows.map(toSupportAccessGrantSummary),
          page,
          pageSize,
          total: parseInt(totalRes.rows[0].count, 10),
        };
      },
    );
  }

  async getOne(actor: RequestActor, id: string): Promise<SupportAccessGrantSummary> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<SupportAccessGrantRow>(
          `SELECT ${GRANT_COLUMNS}
             FROM support_access_grants g
             ${GRANT_ADMIN_JOIN}
            WHERE g.id = $1`,
          [id],
        );
        if (rows.length === 0) {
          throw new SupportAccessGrantNotFoundException();
        }
        return toSupportAccessGrantSummary(rows[0]);
      },
    );
  }

  /**
   * Revokes a grant (plan §3.3): row-locked read → 404 if not in tenant, 409 if
   * already revoked, else UPDATE status='revoked' + revoke stamps. Already-
   * expired (still 'active' but past expires_at) IS revokable — revoke is a
   * tightening op (plan §3.2). The 037 freeze trigger guarantees only the
   * lifecycle columns change; the authorization terms cannot be touched.
   */
  async revoke(
    actor: RequestActor,
    id: string,
    reason: string,
  ): Promise<SupportAccessGrantSummary> {
    const row = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const cur = await client.query<{ status: string }>(
          `SELECT status FROM support_access_grants WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (cur.rows.length === 0) {
          throw new SupportAccessGrantNotFoundException();
        }
        if (cur.rows[0].status === 'revoked') {
          throw new SupportAccessGrantAlreadyRevokedException();
        }
        const updated = await client.query<SupportAccessGrantRow>(
          `UPDATE support_access_grants
              SET status = 'revoked', revoked_by_user_id = $2, revoked_at = now(),
                  revoke_reason = $3, updated_at = now()
            WHERE id = $1
          RETURNING ${GRANT_RETURNING_COLUMNS}`,
          [id, actor.userId, reason],
        );
        return updated.rows[0];
      },
    );

    await this.auditService.log({
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action: 'support_access.revoked',
      resourceType: 'support_access_grant',
      resourceId: row.id,
      reason,
      metadata: { platformAdminId: row.platform_admin_id },
    });

    // RETURNING has no platform_admins join; backfill email as null (the
    // tenant already knows whom it revoked; the list view re-joins it).
    return toSupportAccessGrantSummary({ ...row, platform_admin_email: null });
  }
}
