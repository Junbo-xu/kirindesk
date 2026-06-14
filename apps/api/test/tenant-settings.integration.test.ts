import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { closePool, verifyChain } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import {
  TEST_TENANT_ID,
  TEST_TENANT2_ID,
  TEST_TENANT_SLUG,
  TEST_TENANT2_SLUG,
  TEST_USER_EMAIL,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
} from './fixtures';

const { Client } = pg;

// Boots the real Nest app with the same global ValidationPipe as src/main.ts.
describe('Tenant Settings API — base_currency (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string; // tenant1 admin: has tenant_settings:view + :update
  let nopermToken: string; // tenant1 user with no roles
  let platformToken: string;
  let tenant2Token: string; // tenant2 admin, scope=all

  async function tenantLogin(email: string, slug: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: slug });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);

    adminToken = await tenantLogin(TEST_USER_EMAIL, TEST_TENANT_SLUG);
    nopermToken = await tenantLogin(TEST_USER4_EMAIL, TEST_TENANT_SLUG);
    tenant2Token = await tenantLogin(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);

    const plat = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });
    expect(plat.status).toBe(200);
    platformToken = plat.body.accessToken;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // --- auth + permission gates ---

  it('GET base-currency with no token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/tenant-settings/base-currency');
    expect(res.status).toBe(401);
  });

  it('PUT base-currency with no token returns 401', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/tenant-settings/base-currency')
      .send({ base_currency: 'USD' });
    expect(res.status).toBe(401);
  });

  it('GET with a platform token returns 401 (not a tenant user)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/tenant-settings/base-currency')
      .set(bearer(platformToken));
    expect(res.status).toBe(401);
  });

  it('GET with a tenant user lacking tenant_settings:view returns 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/tenant-settings/base-currency')
      .set(bearer(nopermToken));
    expect(res.status).toBe(403);
  });

  it('PUT with a tenant user lacking tenant_settings:update returns 403', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/tenant-settings/base-currency')
      .set(bearer(nopermToken))
      .send({ base_currency: 'USD' });
    expect(res.status).toBe(403);
  });

  // --- read: default fallback when no row exists ---

  it('GET returns RMB by default when no base_currency row exists', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/tenant-settings/base-currency')
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ base_currency: 'RMB' });
  });

  // --- write: persists and is reflected by a subsequent read ---

  it('PUT updates the base currency and persists it', async () => {
    const put = await request(app.getHttpServer())
      .put('/api/tenant-settings/base-currency')
      .set(bearer(adminToken))
      .send({ base_currency: 'USD' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ base_currency: 'USD' });

    const get = await request(app.getHttpServer())
      .get('/api/tenant-settings/base-currency')
      .set(bearer(adminToken));
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ base_currency: 'USD' });
  });

  it('PUT again updates the same row (upsert, no duplicate)', async () => {
    const put = await request(app.getHttpServer())
      .put('/api/tenant-settings/base-currency')
      .set(bearer(adminToken))
      .send({ base_currency: 'HKD' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ base_currency: 'HKD' });

    const count = await withAdmin(async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tenant_settings
         WHERE tenant_id = $1 AND key = 'base_currency'`,
        [TEST_TENANT_ID],
      );
      return parseInt(r.rows[0].n, 10);
    });
    expect(count).toBe(1);
  });

  // --- validation: currency whitelist ---

  it('PUT with a non-whitelisted currency returns 400', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/tenant-settings/base-currency')
      .set(bearer(adminToken))
      .send({ base_currency: 'JPY' });
    expect(res.status).toBe(400);
  });

  it('PUT with a missing / unknown field returns 400', async () => {
    const missing = await request(app.getHttpServer())
      .put('/api/tenant-settings/base-currency')
      .set(bearer(adminToken))
      .send({});
    expect(missing.status).toBe(400);

    const extra = await request(app.getHttpServer())
      .put('/api/tenant-settings/base-currency')
      .set(bearer(adminToken))
      .send({ base_currency: 'USD', evil: 'x' });
    expect(extra.status).toBe(400);
  });

  // --- cross-tenant isolation: tenant2 writes never affect tenant1 ---

  it('tenant2 updating its own base currency does not change tenant1', async () => {
    const t2 = await request(app.getHttpServer())
      .put('/api/tenant-settings/base-currency')
      .set(bearer(tenant2Token))
      .send({ base_currency: 'EUR' });
    expect(t2.status).toBe(200);
    expect(t2.body).toEqual({ base_currency: 'EUR' });

    // tenant1 still reads its own value (HKD from the upsert test above).
    const t1 = await request(app.getHttpServer())
      .get('/api/tenant-settings/base-currency')
      .set(bearer(adminToken));
    expect(t1.body).toEqual({ base_currency: 'HKD' });

    // Direct DB check: each tenant has its own distinct row.
    const rows = await withAdmin(async (c) => {
      const r = await c.query<{ tenant_id: string; v: string }>(
        `SELECT tenant_id, value_json #>> '{}' AS v FROM tenant_settings
         WHERE key = 'base_currency' AND tenant_id = ANY($1) ORDER BY tenant_id`,
        [[TEST_TENANT_ID, TEST_TENANT2_ID]],
      );
      return r.rows;
    });
    const byTenant = Object.fromEntries(rows.map((r) => [r.tenant_id, r.v]));
    expect(byTenant[TEST_TENANT_ID]).toBe('HKD');
    expect(byTenant[TEST_TENANT2_ID]).toBe('EUR');
  });

  // --- audit + hash chain ---

  it('tenant_settings.updated audit records exist for tenant1', async () => {
    const rows = await withAdmin(async (c) => {
      const r = await c.query<{ action: string; resource_id: string }>(
        `SELECT action, resource_id FROM audit_logs
         WHERE tenant_id = $1 AND resource_type = 'tenant_settings' ORDER BY id ASC`,
        [TEST_TENANT_ID],
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.action === 'tenant_settings.updated')).toBe(true);
    expect(rows.every((r) => r.resource_id === 'base_currency')).toBe(true);
  });

  it('audit after-snapshot reflects the new base currency', async () => {
    const after = await withAdmin(async (c) => {
      const r = await c.query<{ after_json: { base_currency: string } }>(
        `SELECT after_json FROM audit_logs
         WHERE tenant_id = $1 AND resource_type = 'tenant_settings'
           AND action = 'tenant_settings.updated'
         ORDER BY id DESC LIMIT 1`,
        [TEST_TENANT_ID],
      );
      return r.rows[0]?.after_json;
    });
    // Last tenant1 write was HKD.
    expect(after).toEqual({ base_currency: 'HKD' });
  });

  it('tenant1 chain still verifies after settings activity', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });

  it('tenant2 chain still verifies after settings activity', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT2_ID}`);
    expect(result.ok).toBe(true);
  });
});
