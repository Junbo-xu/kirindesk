import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import { SetMetadata } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';

export type QuotaType = 'users' | 'storage' | 'ai';
export const CHECK_QUOTA_KEY = 'check_quota';
export const CheckQuota = (type: QuotaType) => SetMetadata(CHECK_QUOTA_KEY, type);

// Fallback plan id when tenants.plan_id IS NULL (legacy / unassigned = standard).
const STANDARD_PLAN_ID = 'b0000000-0000-0000-0000-000000000002';

@Injectable()
export class QuotaService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  // ── Gate check (called by QuotaGuard) ───────────────────────────────────────

  async checkQuota(
    tenantId: string,
    type: QuotaType,
    pendingBytes?: number, // storage only
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Open a transaction so SET LOCAL (is_local=true) survives the two queries.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);

      // Resolve plan limits (fall back to standard when plan_id is NULL).
      const planRes = await client.query<{
        max_users: number;
        max_storage_gb: number;
        ai_quota_monthly: number;
      }>(
        `SELECT p.max_users, p.max_storage_gb, p.ai_quota_monthly
           FROM tenants t
           JOIN plans p ON p.id = COALESCE(t.plan_id, $2)
          WHERE t.id = $1`,
        [tenantId, STANDARD_PLAN_ID],
      );
      if (planRes.rows.length === 0) {
        await client.query('COMMIT');
        return; // unknown tenant — let auth guard handle it
      }

      const limits = planRes.rows[0];

      // Resolve current usage (FORCE RLS on tenant_quota_usage — context set above).
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
      if (usageRes.rows.length === 0) {
        await client.query('COMMIT');
        return; // no usage row yet — allow
      }

      await client.query('COMMIT');
      const usage = usageRes.rows[0];

      if (type === 'users') {
        if (usage.user_count >= limits.max_users) {
          throw new HttpException(
            {
              code: 'QUOTA_EXCEEDED',
              quota: 'users',
              limit: limits.max_users,
              current: usage.user_count,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      } else if (type === 'storage') {
        const maxBytes = BigInt(limits.max_storage_gb) * BigInt(1024 * 1024 * 1024);
        const currentBytes = BigInt(usage.storage_bytes);
        const incoming = BigInt(pendingBytes ?? 0);
        if (currentBytes + incoming > maxBytes) {
          throw new HttpException(
            {
              code: 'QUOTA_EXCEEDED',
              quota: 'storage',
              limit: limits.max_storage_gb * 1024 * 1024 * 1024,
              current: Number(usage.storage_bytes),
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      } else if (type === 'ai') {
        // Reset counter if we've crossed into a new month.
        const resetAt = new Date(usage.ai_calls_reset_at);
        const now = new Date();
        if (now.getFullYear() !== resetAt.getFullYear() || now.getMonth() !== resetAt.getMonth()) {
          await this._resetAiCalls(tenantId);
          return; // just reset → zero calls this month → allow
        }
        if (usage.ai_calls_month >= limits.ai_quota_monthly) {
          throw new HttpException(
            {
              code: 'QUOTA_EXCEEDED',
              quota: 'ai',
              limit: limits.ai_quota_monthly,
              current: usage.ai_calls_month,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
    } finally {
      client.release();
    }
  }

  // ── Usage mutation (called by UsersService / FilesService / AiService) ──────

  async increment(tenantId: string, userId: string): Promise<void> {
    await this._upsertAndUpdate(tenantId, userId, 'user_count = user_count + 1');
  }

  async decrement(tenantId: string, userId: string): Promise<void> {
    await this._upsertAndUpdate(tenantId, userId, 'user_count = GREATEST(0, user_count - 1)');
  }

  async addStorage(tenantId: string, userId: string, bytes: number): Promise<void> {
    await this._upsertAndUpdate(
      tenantId,
      userId,
      `storage_bytes = storage_bytes + ${BigInt(bytes)}`,
    );
  }

  async subtractStorage(tenantId: string, userId: string, bytes: number): Promise<void> {
    await this._upsertAndUpdate(
      tenantId,
      userId,
      `storage_bytes = GREATEST(0, storage_bytes - ${BigInt(bytes)})`,
    );
  }

  async incrementAi(tenantId: string, userId: string): Promise<void> {
    // Reset if new month, then increment.
    await withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        await client.query(
          `INSERT INTO tenant_quota_usage (tenant_id, ai_calls_month, ai_calls_reset_at, updated_at)
              VALUES ($1, 1, $2, now())
         ON CONFLICT (tenant_id) DO UPDATE
           SET ai_calls_month = CASE
                 WHEN tenant_quota_usage.ai_calls_reset_at < $2
                 THEN 1
                 ELSE tenant_quota_usage.ai_calls_month + 1
               END,
               ai_calls_reset_at = CASE
                 WHEN tenant_quota_usage.ai_calls_reset_at < $2 THEN $2
                 ELSE tenant_quota_usage.ai_calls_reset_at
               END,
               updated_at = now()`,
          [tenantId, monthStart],
        );
      },
    );
  }

  // ── Provision (called by TenantOnboardingService) ────────────────────────────

  /** Insert the initial quota row inside an already-open transaction client. */
  async insertInitialRow(client: import('pg').PoolClient, tenantId: string): Promise<void> {
    await client.query(
      `INSERT INTO tenant_quota_usage (tenant_id, user_count, storage_bytes, ai_calls_month, ai_calls_reset_at, updated_at)
            VALUES ($1, 1, 0, 0, date_trunc('month', now()), now())
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId],
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _upsertAndUpdate(
    tenantId: string,
    userId: string,
    setClause: string,
  ): Promise<void> {
    await withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        await client.query(
          `INSERT INTO tenant_quota_usage (tenant_id, updated_at)
              VALUES ($1, now())
         ON CONFLICT (tenant_id) DO UPDATE SET ${setClause}, updated_at = now()`,
          [tenantId],
        );
      },
    );
  }

  private async _resetAiCalls(tenantId: string): Promise<void> {
    // Use a system-actor context so FORCE RLS on tenant_quota_usage is satisfied.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      await client.query(
        `UPDATE tenant_quota_usage
            SET ai_calls_month = 0,
                ai_calls_reset_at = date_trunc('month', now()),
                updated_at = now()
          WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}
