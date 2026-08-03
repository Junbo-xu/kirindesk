import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { closePool } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import { FileNotFoundException } from '../src/files/files.errors';
import { FilesService } from '../src/files/files.service';
import { UserNotFoundException } from '../src/users/users.errors';
import { UsersService } from '../src/users/users.service';
import {
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_USER_EMAIL,
  TEST_USER_ID,
} from './fixtures';

// Phase 1M subscription + quota integration (plan §6 / exec §4). Covers:
// quota_usage provisioned on onboarding, GET /api/subscription, 429 on
// user/storage/ai limits, month-rollover AI reset, platform plan assignment,
// ModuleGuard 403 MODULE_NOT_ENABLED, mobile alias, and RBAC.

const FREE_PLAN_ID = 'b0000000-0000-0000-0000-000000000001'; // max_users=3, max_storage_gb=5, ai_quota_monthly=50

describe('Subscription & Quota API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let platformToken: string;
  let usersService: UsersService;
  let filesService: FilesService;
  const createdTenantIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdFileIds: string[] = [];

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

  async function expectUserQuotaMatchesActiveUsers(
    client: pg.Client,
    expected: number,
  ): Promise<void> {
    const { rows } = await client.query<{
      user_count: number;
      active_user_count: number;
    }>(
      `SELECT q.user_count,
              (SELECT COUNT(*)::integer
                 FROM users u
                WHERE u.tenant_id = q.tenant_id
                  AND u.status = 'active'
                  AND u.deleted_at IS NULL) AS active_user_count
         FROM tenant_quota_usage q
        WHERE q.tenant_id = $1`,
      [TEST_TENANT_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_count).toBe(expected);
    expect(rows[0].user_count).toBe(rows[0].active_user_count);
  }

  async function runBehindTargetRowLock<T>(
    targetTable: 'users' | 'files',
    targetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const warmConnections = await Promise.all([pool.connect(), pool.connect()]);
    for (const connection of warmConnections) connection.release();

    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    let pending: Promise<T> | undefined;
    try {
      await blocker.query('BEGIN');
      const lockQuery =
        targetTable === 'users'
          ? `SELECT id FROM users WHERE id = $1 FOR UPDATE`
          : `SELECT id FROM files WHERE id = $1 FOR UPDATE`;
      await blocker.query(lockQuery, [targetId]);
      pending = operation();

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const waiting = await blocker.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND usename = 'kirindesk_app'`,
        );
        if (parseInt(waiting.rows[0].count, 10) >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const waiting = await blocker.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND usename = 'kirindesk_app'`,
      );
      if (parseInt(waiting.rows[0].count, 10) < 2) {
        const activity = await blocker.query<{
          usename: string;
          state: string;
          wait_event_type: string | null;
          wait_event: string | null;
          query: string;
        }>(
          `SELECT usename, state, wait_event_type, wait_event, left(query, 240) AS query
             FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
            ORDER BY pid`,
        );
        throw new Error(`Target row lock barrier timed out: ${JSON.stringify(activity.rows)}`);
      }

      await blocker.query('COMMIT');
      return await pending;
    } catch (error) {
      await blocker.query('ROLLBACK').catch(() => undefined);
      if (pending) await pending.catch(() => undefined);
      throw error;
    } finally {
      await blocker.end();
    }
  }

  function bearer(t: string) {
    return { Authorization: `Bearer ${t}` };
  }

  let seq = 0;
  function slug() {
    return `qa-sub-${Date.now()}-${++seq}`;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);
    usersService = app.get(UsersService);
    filesService = app.get(FilesService);

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
        `UPDATE tenant_quota_usage SET user_count = 3, storage_bytes = 0, ai_calls_month = 0,
          ai_calls_reset_at = date_trunc('month', now()), updated_at = now()
         WHERE tenant_id = $1`,
        [TEST_TENANT_ID],
      );
      if (createdFileIds.length > 0) {
        await c.query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [createdFileIds]);
        createdFileIds.length = 0;
      }
      if (createdUserIds.length > 0) {
        await c.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]);
        createdUserIds.length = 0;
      }
    });

    // Clean up any provisioned tenants.
    if (createdTenantIds.length > 0) {
      const ids = [...createdTenantIds];
      createdTenantIds.length = 0;
      await withAdmin(async (c) => {
        for (const id of ids) {
          await c.query(`DELETE FROM tenant_modules WHERE tenant_id = $1`, [id]);
          await c.query(`DELETE FROM tenant_quota_usage WHERE tenant_id = $1`, [id]);
          await c.query(`DELETE FROM tenant_notification_settings WHERE tenant_id = $1`, [id]);
          await c.query(
            `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`,
            [id],
          );
          await c.query(`DELETE FROM users WHERE tenant_id = $1`, [id]);
          await c.query(`DELETE FROM audit_log_chains WHERE tenant_id = $1`, [id]);
          await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
        }
      });
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // ── 1. onboarding creates tenant_quota_usage row ──────────────────────────

  it('provisioning a new tenant creates a tenant_quota_usage row with user_count=1', async () => {
    const s = slug();
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send({
        name: 'Quota Test Tenant',
        slug: s,
        ownerEmail: `owner-${s}@qa.local`,
        ownerPassword: 'TestPass123!',
        ownerName: 'QA',
      });
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
    const res = await request(app.getHttpServer()).get('/api/subscription').set(bearer(adminToken));
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
      await c.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [
        FREE_PLAN_ID,
        TEST_TENANT_ID,
      ]);
      // free max_users=3; set user_count=3
      await c.query(`UPDATE tenant_quota_usage SET user_count = 3 WHERE tenant_id = $1`, [
        TEST_TENANT_ID,
      ]);
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

  it('concurrent user creates serialize on the quota row and only one reaches the last slot', async () => {
    const prefix = `quota-race-${Date.now()}`;
    await withAdmin(async (client) => {
      await client.query(`UPDATE tenant_quota_usage SET user_count = 9 WHERE tenant_id = $1`, [
        TEST_TENANT_ID,
      ]);
    });

    const responses = await Promise.all(
      [1, 2].map((sequence) =>
        request(app.getHttpServer())
          .post('/api/users')
          .set(bearer(adminToken))
          .send({
            email: `${prefix}-${sequence}@qa.local`,
            password: 'Pass123!',
            name: `Quota Race ${sequence}`,
          }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);

    await withAdmin(async (client) => {
      const usage = await client.query<{ user_count: number }>(
        `SELECT user_count FROM tenant_quota_usage WHERE tenant_id = $1`,
        [TEST_TENANT_ID],
      );
      expect(usage.rows[0].user_count).toBe(10);

      const created = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users WHERE tenant_id = $1 AND email LIKE $2`,
        [TEST_TENANT_ID, `${prefix}-%`],
      );
      expect(created.rows[0].count).toBe('1');
      await client.query(`DELETE FROM users WHERE tenant_id = $1 AND email LIKE $2`, [
        TEST_TENANT_ID,
        `${prefix}-%`,
      ]);
    });
  });

  it('concurrent user deactivation releases one user slot exactly once', async () => {
    const userId = randomUUID();
    createdUserIds.push(userId);
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
         VALUES ($1, $2, $3, 'not-used', 'Quota Deactivate Race', 'active', false)`,
        [userId, TEST_TENANT_ID, `quota-deactivate-${userId}@qa.local`],
      );
      await client.query(`UPDATE tenant_quota_usage SET user_count = 4 WHERE tenant_id = $1`, [
        TEST_TENANT_ID,
      ]);
    });

    const actor = { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, dataScope: 'all' };
    const outcomes = await runBehindTargetRowLock('users', userId, () =>
      Promise.allSettled([1, 2].map(() => usersService.deactivate(actor, userId))),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejection?.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(UserNotFoundException);
    }

    await withAdmin(async (client) => {
      await expectUserQuotaMatchesActiveUsers(client, 3);
    });
  });

  it('concurrent status deactivation releases one user slot exactly once', async () => {
    const userId = randomUUID();
    createdUserIds.push(userId);
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
         VALUES ($1, $2, $3, 'not-used', 'Quota Status Race', 'active', false)`,
        [userId, TEST_TENANT_ID, `quota-status-${userId}@qa.local`],
      );
      await client.query(`UPDATE tenant_quota_usage SET user_count = 4 WHERE tenant_id = $1`, [
        TEST_TENANT_ID,
      ]);
    });

    const actor = { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, dataScope: 'all' };
    const outcomes = await runBehindTargetRowLock('users', userId, () =>
      Promise.allSettled(
        [1, 2].map(() => usersService.update(actor, userId, { status: 'inactive' })),
      ),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);

    await withAdmin(async (client) => {
      await expectUserQuotaMatchesActiveUsers(client, 3);
    });
  });

  it('active to inactive to deleted releases the user slot only on the active boundary', async () => {
    const userId = randomUUID();
    createdUserIds.push(userId);
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
         VALUES ($1, $2, $3, 'not-used', 'Quota State Machine', 'active', false)`,
        [userId, TEST_TENANT_ID, `quota-state-${userId}@qa.local`],
      );
      await client.query(`UPDATE tenant_quota_usage SET user_count = 4 WHERE tenant_id = $1`, [
        TEST_TENANT_ID,
      ]);
      await expectUserQuotaMatchesActiveUsers(client, 4);
    });

    const actor = { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, dataScope: 'all' };
    await usersService.update(actor, userId, { status: 'inactive' });
    await withAdmin(async (client) => {
      await expectUserQuotaMatchesActiveUsers(client, 3);
    });

    await usersService.deactivate(actor, userId);
    await withAdmin(async (client) => {
      await expectUserQuotaMatchesActiveUsers(client, 3);
    });
  });

  it('inactive to active to inactive consumes and releases quota, and full-quota activation rolls back', async () => {
    const userId = randomUUID();
    createdUserIds.push(userId);
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
         VALUES ($1, $2, $3, 'not-used', 'Quota Reactivation', 'inactive', false)`,
        [userId, TEST_TENANT_ID, `quota-reactivation-${userId}@qa.local`],
      );
      await expectUserQuotaMatchesActiveUsers(client, 3);
    });

    const activate = await request(app.getHttpServer())
      .patch(`/api/users/${userId}`)
      .set(bearer(adminToken))
      .send({ status: 'active' });
    expect(activate.status).toBe(200);
    expect(activate.body.status).toBe('active');
    await withAdmin(async (client) => {
      await expectUserQuotaMatchesActiveUsers(client, 4);
    });

    const deactivate = await request(app.getHttpServer())
      .patch(`/api/users/${userId}`)
      .set(bearer(adminToken))
      .send({ status: 'inactive' });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.status).toBe('inactive');
    await withAdmin(async (client) => {
      await expectUserQuotaMatchesActiveUsers(client, 3);
      await client.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [
        FREE_PLAN_ID,
        TEST_TENANT_ID,
      ]);
    });

    const rejectedActivation = await request(app.getHttpServer())
      .patch(`/api/users/${userId}`)
      .set(bearer(adminToken))
      .send({ status: 'active' });
    expect(rejectedActivation.status).toBe(429);
    expect(rejectedActivation.body).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      quota: 'users',
      limit: 3,
      current: 3,
    });

    await withAdmin(async (client) => {
      await expectUserQuotaMatchesActiveUsers(client, 3);
      const user = await client.query<{ status: string }>(
        `SELECT status FROM users WHERE id = $1`,
        [userId],
      );
      expect(user.rows[0].status).toBe('inactive');
    });
  });

  it('concurrent status update and delete preserve the authoritative active user count', async () => {
    const userId = randomUUID();
    createdUserIds.push(userId);
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
         VALUES ($1, $2, $3, 'not-used', 'Quota Cross Entry Race', 'active', false)`,
        [userId, TEST_TENANT_ID, `quota-cross-entry-${userId}@qa.local`],
      );
      await client.query(`UPDATE tenant_quota_usage SET user_count = 4 WHERE tenant_id = $1`, [
        TEST_TENANT_ID,
      ]);
      await expectUserQuotaMatchesActiveUsers(client, 4);
    });

    const actor = { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, dataScope: 'all' };
    const [statusUpdate, deletion] = await runBehindTargetRowLock('users', userId, () =>
      Promise.allSettled([
        usersService.update(actor, userId, { status: 'inactive' }),
        usersService.deactivate(actor, userId),
      ]),
    );
    expect(deletion.status).toBe('fulfilled');
    if (statusUpdate.status === 'rejected') {
      expect(statusUpdate.reason).toBeInstanceOf(UserNotFoundException);
    }

    await withAdmin(async (client) => {
      await expectUserQuotaMatchesActiveUsers(client, 3);
      const deleted = await client.query<{ status: string; deleted_at: Date | null }>(
        `SELECT status, deleted_at FROM users WHERE id = $1`,
        [userId],
      );
      expect(deleted.rows[0].status).toBe('inactive');
      expect(deleted.rows[0].deleted_at).not.toBeNull();
    });
  });

  // ── 4. storage at limit → 429 ─────────────────────────────────────────────

  it('POST /api/files returns 429 QUOTA_EXCEEDED when storage is at free plan limit', async () => {
    const fiveGib = 5n * 1024n * 1024n * 1024n;
    await withAdmin(async (c) => {
      await c.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [
        FREE_PLAN_ID,
        TEST_TENANT_ID,
      ]);
      await c.query(`UPDATE tenant_quota_usage SET storage_bytes = $1 WHERE tenant_id = $2`, [
        fiveGib.toString(),
        TEST_TENANT_ID,
      ]);
    });

    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(adminToken))
      .attach('file', Buffer.from('hello'), {
        filename: 'test.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.quota).toBe('storage');
  });

  it('concurrent file deletion releases storage bytes exactly once', async () => {
    const fileId = randomUUID();
    const fileSize = 4_096;
    createdFileIds.push(fileId);
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO files
           (id, tenant_id, uploaded_by, original_name, storage_key, mime_type, size_bytes, sha256)
         VALUES ($1, $2, $3, 'quota-race.pdf', $4, 'application/pdf', $5, $6)`,
        [
          fileId,
          TEST_TENANT_ID,
          TEST_USER_ID,
          `${TEST_TENANT_ID}/${fileId}`,
          fileSize,
          'a'.repeat(64),
        ],
      );
      await client.query(`UPDATE tenant_quota_usage SET storage_bytes = $1 WHERE tenant_id = $2`, [
        String(fileSize * 5),
        TEST_TENANT_ID,
      ]);
    });

    const actor = { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, dataScope: 'all' };
    const outcomes = await runBehindTargetRowLock('files', fileId, () =>
      Promise.allSettled([1, 2].map(() => filesService.remove(actor, fileId))),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    if (rejection?.status === 'rejected') {
      expect(rejection.reason).toBeInstanceOf(FileNotFoundException);
    }

    await withAdmin(async (client) => {
      const usage = await client.query<{ storage_bytes: string }>(
        `SELECT storage_bytes FROM tenant_quota_usage WHERE tenant_id = $1`,
        [TEST_TENANT_ID],
      );
      expect(usage.rows[0].storage_bytes).toBe(String(fileSize * 4));
    });
  });

  // ── 5. AI calls at limit → 429 ────────────────────────────────────────────

  it('POST /api/ai/ocr returns 429 QUOTA_EXCEEDED when ai_calls_month is at free plan limit', async () => {
    await withAdmin(async (c) => {
      await c.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [
        FREE_PLAN_ID,
        TEST_TENANT_ID,
      ]);
      // free ai_quota_monthly=50
      await c.query(`UPDATE tenant_quota_usage SET ai_calls_month = 50 WHERE tenant_id = $1`, [
        TEST_TENANT_ID,
      ]);
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
      await c.query(`UPDATE tenants SET plan_id = $1 WHERE id = $2`, [
        FREE_PLAN_ID,
        TEST_TENANT_ID,
      ]);
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

  it('AI endpoint returns 403 MODULE_NOT_ENABLED when ai module is disabled', async () => {
    // Disable the ai module for the test tenant, then re-enable in afterEach.
    await withAdmin(async (c) => {
      await c.query(
        `UPDATE tenant_modules tm SET enabled = false
           FROM modules m WHERE m.id = tm.module_id AND m.code = 'ai' AND tm.tenant_id = $1`,
        [TEST_TENANT_ID],
      );
    });

    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(adminToken))
      .send({ fileId: '00000000-0000-0000-0000-000000000001' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MODULE_NOT_ENABLED');

    // Re-enable so subsequent tests are not affected.
    await withAdmin(async (c) => {
      await c.query(
        `UPDATE tenant_modules tm SET enabled = true
           FROM modules m WHERE m.id = tm.module_id AND m.code = 'ai' AND tm.tenant_id = $1`,
        [TEST_TENANT_ID],
      );
    });
  });

  // ── 9. mobile alias ───────────────────────────────────────────────────────

  it('GET /api/mobile/v1/subscription returns the same structure as GET /api/subscription', async () => {
    const tenant = await request(app.getHttpServer())
      .get('/api/subscription')
      .set(bearer(adminToken));
    const mobile = await request(app.getHttpServer())
      .get('/api/mobile/v1/subscription')
      .set(bearer(adminToken));
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
