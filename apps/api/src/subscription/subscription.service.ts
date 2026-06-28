import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { AuditService } from '../audit/audit.service';
import { AssignPlanDto } from './dto/assign-plan.dto';

const STANDARD_PLAN_ID = 'b0000000-0000-0000-0000-000000000002';

export interface SubscriptionDetail {
  plan: {
    id: string;
    code: string;
    name: string;
    maxUsers: number;
    maxStorageGb: number;
    aiQuotaMonthly: number;
    expiresAt: string | null;
  };
  usage: {
    userCount: number;
    storageBytes: string;
    aiCallsMonth: number;
    aiCallsResetAt: string;
  };
  modules: { code: string; name: string; enabled: boolean }[];
}

@Injectable()
export class SubscriptionService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  async getForTenant(tenantId: string, userId: string): Promise<SubscriptionDetail> {
    return withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        const planRes = await client.query<{
          plan_id: string;
          plan_code: string;
          plan_name: string;
          max_users: number;
          max_storage_gb: number;
          ai_quota_monthly: number;
          plan_expires_at: Date | null;
        }>(
          `SELECT p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
                p.max_users, p.max_storage_gb, p.ai_quota_monthly,
                t.plan_expires_at
           FROM tenants t
           JOIN plans p ON p.id = COALESCE(t.plan_id, $2)
          WHERE t.id = $1`,
          [tenantId, STANDARD_PLAN_ID],
        );
        if (planRes.rows.length === 0) throw new NotFoundException('Tenant not found');
        const p = planRes.rows[0];

        const usageRes = await client.query<{
          user_count: number;
          storage_bytes: string;
          ai_calls_month: number;
          ai_calls_reset_at: Date;
        }>(
          `SELECT user_count, storage_bytes, ai_calls_month, ai_calls_reset_at
           FROM tenant_quota_usage WHERE tenant_id = $1`,
          [tenantId],
        );
        const usage = usageRes.rows[0] ?? {
          user_count: 0,
          storage_bytes: '0',
          ai_calls_month: 0,
          ai_calls_reset_at: new Date(),
        };

        const modRes = await client.query<{ code: string; name: string; enabled: boolean }>(
          `SELECT m.code, m.name,
                COALESCE(tm.enabled, false) AS enabled
           FROM modules m
           LEFT JOIN tenant_modules tm ON tm.module_id = m.id AND tm.tenant_id = $1
          ORDER BY m.sort_order`,
          [tenantId],
        );

        return {
          plan: {
            id: p.plan_id,
            code: p.plan_code,
            name: p.plan_name,
            maxUsers: p.max_users,
            maxStorageGb: p.max_storage_gb,
            aiQuotaMonthly: p.ai_quota_monthly,
            expiresAt: p.plan_expires_at?.toISOString() ?? null,
          },
          usage: {
            userCount: usage.user_count,
            storageBytes: usage.storage_bytes,
            aiCallsMonth: usage.ai_calls_month,
            aiCallsResetAt:
              usage.ai_calls_reset_at instanceof Date
                ? usage.ai_calls_reset_at.toISOString()
                : String(usage.ai_calls_reset_at),
          },
          modules: modRes.rows,
        };
      },
    );
  }

  // ── Platform-side ─────────────────────────────────────────────────────────

  async getAllPlans() {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT id, code, name, description, max_users, max_storage_gb, ai_quota_monthly,
                price_monthly, price_yearly, currency, status, sort_order
           FROM plans WHERE status = 'active' ORDER BY sort_order`,
      );
      return res.rows;
    } finally {
      client.release();
    }
  }

  async getTenantPlan(tenantId: string) {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT t.id AS tenant_id, t.plan_id, t.plan_assigned_at, t.plan_expires_at,
                p.code AS plan_code, p.name AS plan_name,
                p.max_users, p.max_storage_gb, p.ai_quota_monthly,
                tqu.user_count, tqu.storage_bytes, tqu.ai_calls_month
           FROM tenants t
           LEFT JOIN plans p ON p.id = COALESCE(t.plan_id, $2)
           LEFT JOIN tenant_quota_usage tqu ON tqu.tenant_id = t.id
          WHERE t.id = $1`,
        [tenantId, STANDARD_PLAN_ID],
      );
      if (res.rows.length === 0) throw new NotFoundException('Tenant not found');
      return res.rows[0];
    } finally {
      client.release();
    }
  }

  async assignPlan(tenantId: string, dto: AssignPlanDto, adminId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Verify plan exists.
      const planRes = await client.query(`SELECT id FROM plans WHERE id = $1`, [dto.planId]);
      if (planRes.rows.length === 0) throw new NotFoundException('Plan not found');

      const expiresAt = dto.planExpiresAt ? new Date(dto.planExpiresAt) : null;
      await client.query(
        `UPDATE tenants SET plan_id = $2, plan_assigned_at = now(), plan_expires_at = $3, updated_at = now()
          WHERE id = $1`,
        [tenantId, dto.planId, expiresAt],
      );
    } finally {
      client.release();
    }

    // Audit into tenant chain (best-effort post-commit).
    await this.audit.log({
      tenantId,
      actorId: adminId,
      actorType: 'platform_admin',
      action: 'tenant.plan_assigned',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { planId: dto.planId, planExpiresAt: dto.planExpiresAt ?? null },
    });
  }
}
