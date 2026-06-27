import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { closePool } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import {
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_USER_EMAIL,
} from './fixtures';

// Phase 1M subscription + quota integration (plan §6 / exec §4). Covers:
// quota_usage provisioned on onboarding, GET /api/subscription, 429 on
// user/storage/ai limits, month-rollover AI reset, platform plan assignment,
// ModuleGuard 403 MODULE_NOT_ENABLED, mobile alias, and RBAC.

const FREE_PLAN_ID = 'b0000000-0000-0000-0000-000000000001';   // max_users=3, max_storage_gb=5, ai_quota_monthly=50
const STANDARD_PLAN_ID = 'b0000000-0000-0000-0000-000000000002'; // max_users=10

describe('Subscription & Quota API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let platformToken: string;
  const createdTenantIds: string[] = [];

  const { Client } = pg;
  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  function bearer(t: string) { return { Authorization: `Bearer ${t}` }; }

  let seq = 0;
  function slug() { return `qa-sub-${Date.now()}-${++seq}`; }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = app.get<Pool>(APP_POOL);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: TEST_USER_EMAIL, password: TEST_PASSWORD, tenantSlug: TEST_TENANT_SLUG });
    expect(login.status).toBe(200);
    adminToken = login.body.accessToken as string;

    const plat = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });
    expect(plat.status).toBe(200);
    platformToken = plat.body.accessToken as string;
  });

  afterEach(async () => {
    // Reset plan_id + quota_usage for the main test tenant after each test.
    await withAdmin(async (c) => {
      await c.query(
        `UPDATE tenants SET plan_id = NULL, plan_assigned_at = NULL, plan_expires_at = NULL WHERE id = $1`,
        [TEST_TENANT_ID],
      );
      await c.query(
        `UPDATE tenant_quota_usage SET user_count = 1, storage_bytes = 0, ai_calls_month = 0,
          ai_calls_reset_at = date_trunc('month', now()), updated_at = now()
         WHERE tenant_id = $1`,
        [TEST_TENANT_ID],
      );
    });

    // Clean up any provisioned tenants.
    if (createdTenantIds.length > 0) {
      const ids = [...createdTenantIds];
      createdTenantIds.length = 0;
      await withAdmin(async (c) => {
        for (const id of ids) {
          await c.query(`DELETE FROM tenant_modules WHERE tenant_id = $1`, [id]);
          await c.query(`DELETE FROM tenant_quota_usage WHERE tenant_id = $1`, [id]);
          await c.query(`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]);
          await c.query(`DELETE FROM users WHERE tenant_id = $1`, [id]);
          await c.query(`DELETE FROM audit_log_chains WHERE tenant_id = $1`, [id]);
          await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
        }
      });
    }
  });

  afterAll(async () => {
    if (app) { await app.close(); await pool.end(); }
    await closePool();
  });

  // ── 1. onboarding creates tenant_quota_usage row ──────────────────────────

  it('provisioning a new tenant creates a tenant_quota_usage row with user_count=1', async () => {
    const s = slug();
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send({ name: 'Quota Test Tenant', slug: s, ownerEmail: `owner-${s}@qa.local`, ownerPassword: 'TestPass123!', ownerName: 'QA' });
    expect(res.status).toBe(201);
    const tenantId = res.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    await withAdmin(async (c) => {
      const { rows } = await c.query(
        `SELECT user_count, storage_bytes, ai_calls_month FROM tenant_quota_usage WHERE tenant_id = $1`,
        [tenantId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].user_count).toBe(1);
      expect(rows[0].storage_bytes).toBe('0');
      expect(rows[0].ai_calls_month).toBe(0);
    });
  });

  // ── 2. GET /api/subscription ──────────────────────────────────────────────

  it('GET /api/subscription returns plan, usage, and modules', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/subscription')
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBeDefined();
    expect(typeof res.body.plan.maxUsers).toBe('number');
    expect(typeof res.body.plan.maxStorageGb).toBe('number');
    expect(typeof res.body.plan.aiQuotaMonthly).toBe('number');
    expect(res.body.usage).toBeDefined();
    expect(typeof res.body.usage.userCount).toBe('number');
    expect(Array.isArray(res.body.modules)).toBe(true);
  });

  // ── 3. user count at limit → 429 ─────────────────────────────────────────

  it('POST /api/users returns 429 QUOTA_EXCEEDED when user count is at free plan limit', async () => {
    await withAdmin(async (c) => {
      await c.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [FREE_PLAN_ID, TEST_TENANT_ID]);
      // free max_users=3; set user_count=3
      await c.query(`UPDATE tenant_quota_usage SET user_count = 3 WHERE tenant_id = $1`, [TEST_TENANT_ID]);
    });

    const res = await request(app.getHttpServer())
      .post('/api/users')
      .set(bearer(adminToken))
      .send({ email: `new-${Date.now()}@qa.local`, password: 'Pass123!', name: 'New User' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.quota).toBe('users');
    expect(res.body.limit).toBe(3);
  });

  // ── 4. storage at limit → 429 ─────────────────────────────────────────────

  it('POST /api/files returns 429 QUOTA_EXCEEDED when storage is at free plan limit', async () => {
    const fiveGib = 5n * 1024n * 1024n * 1024n;
    await withAdmin(async (c) => {
      await c.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [FREE_PLAN_ID, TEST_TENANT_ID]);
      await c.query(`UPDATE tenant_quota_usage SET storage_bytes = $1 WHERE tenant_id = $2`, [fiveGib.toString(), TEST_TENANT_ID]);
    });

    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(adminToken))
      .attach('file', Buffer.from('hello'), { filename: 'test.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.quota).toBe('storage');
  });

  // ── 5. AI calls at limit → 429 ────────────────────────────────────────────

  it('POST /api/ai/ocr returns 429 QUOTA_EXCEEDED when ai_calls_month is at free plan limit', async () => {
    await withAdmin(async (c) => {
      await c.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [FREE_PLAN_ID, TEST_TENANT_ID]);
      // free ai_quota_monthly=50
      await c.query(`UPDATE tenant_quota_usage SET ai_calls_month = 50 WHERE tenant_id = $1`, [TEST_TENANT_ID]);
    });

    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(adminToken))
      .send({ fileId: '00000000-0000-0000-0000-000000000001' });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.quota).toBe('ai');
    expect(res.body.limit).toBe(50);
  });

  // ── 6. month rollover resets AI counter ──────────────────────────────────

  it('AI call with stale ai_calls_reset_at (last month, at limit) resets counter and allows the call', async () => {
    // Set plan_id = free and ai_calls_month=50 but ai_calls_reset_at = last month.
    // QuotaGuard should detect the new month, reset, and allow the call.
    await withAdmin(async (c) => {
      await c.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [FREE_PLAN_ID, TEST_TENANT_ID]);
      await c.query(
        `UPDATE tenant_quota_usage
            SET ai_calls_month = 50,
                ai_calls_reset_at = date_trunc('month', now()) - interval '1 month'
          WHERE tenant_id = $1`,
        [TEST_TENANT_ID],
      );
    });

    // The request will fail at file scope (not at quota), but not with 429.
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(adminToken))
      .send({ fileId: '00000000-0000-0000-0000-000000000001' });
    // 404 (file not in scope) is fine — it proves quota did NOT block the call.
    expect(res.status).not.toBe(429);

    // DB: counter reset
    await withAdmin(async (c) => {
      const { rows } = await c.query(
        `SELECT ai_calls_month, ai_calls_reset_at FROM tenant_quota_usage WHERE tenant_id = $1`,
        [TEST_TENANT_ID],
      );
      expect(rows[0].ai_calls_month).toBe(0);
      const resetAt = new Date(rows[0].ai_calls_reset_at as string);
      const now = new Date();
      expect(resetAt.getFullYear()).toBe(now.getFullYear());
      expect(resetAt.getMonth()).toBe(now.getMonth());
    });
  });

  // ── 7. platform assigns plan → tenant sees new limits ────────────────────

  it('PUT /api/platform/tenants/:id/subscription changes the plan visible in GET /api/subscription', async () => {
    // Initially no plan_id → defaults to standard (max_users=10).
    const before = await request(app.getHttpServer())
      .get('/api/subscription')
      .set(bearer(adminToken));
    expect(before.status).toBe(200);
    expect(before.body.plan.maxUsers).toBe(10); // standard

    // Platform assigns free plan.
    const assign = await request(app.getHttpServer())
      .put(`/api/platform/tenants/${TEST_TENANT_ID}/subscription`)
      .set(bearer(platformToken))
      .send({ planId: FREE_PLAN_ID });
    expect(assign.status).toBe(200);

    const after = await request(app.getHttpServer())
      .get('/api/subscription')
      .set(bearer(adminToken));
    expect(after.status).toBe(200);
    expect(after.body.plan.maxUsers).toBe(3); // free
    expect(after.body.plan.code).toBe('free');
  });

  // ── 8. ModuleGuard: disabled module → 403 MODULE_NOT_ENABLED ──────────────

  it('AI endpoint returns 403 MODULE_NOT_ENABLED for a tenant with no ai module enabled', async () => {
    // Provision a new tenant — it gets no tenant_modules rows.
    const s = slug();
    const ownerEmail = `owner-${s}@qa.local`;
    const prov = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send({ name: 'No-Module Tenant', slug: s, ownerEmail, ownerPassword: 'TestPass123!', ownerName: 'QA' });
    expect(prov.status).toBe(201);
    const tenantId = prov.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: ownerEmail, password: 'TestPass123!', tenantSlug: s });
    expect(login.status).toBe(200);
    const ownerToken = login.body.accessToken as string;

    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(ownerToken))
      .send({ fileId: '00000000-0000-0000-0000-000000000001' });
    expect(res.status).toBe(403);
    expect(res.body.message?.code ?? res.body.code).toBe('MODULE_NOT_ENABLED');
  });

  // ── 9. mobile alias ───────────────────────────────────────────────────────

  it('GET /api/mobile/v1/subscription returns the same structure as GET /api/subscription', async () => {
    const tenant = await request(app.getHttpServer()).get('/api/subscription').set(bearer(adminToken));
    const mobile = await request(app.getHttpServer()).get('/api/mobile/v1/subscription').set(bearer(adminToken));
    expect(mobile.status).toBe(200);
    expect(mobile.body.plan.code).toBe(tenant.body.plan.code);
    expect(mobile.body.usage.userCount).toBe(tenant.body.usage.userCount);
    expect(mobile.body.modules).toHaveLength(tenant.body.modules.length);
  });

  // ── 10. RBAC: tenant token cannot access platform plan API ────────────────

  it('GET /api/platform/plans with a tenant token returns 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/platform/plans')
      .set(bearer(adminToken)); // tenant jwt, not platform jwt
    expect(res.status).toBe(401);
  });
});
