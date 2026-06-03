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
  TEST_TENANT_SLUG,
  TEST_TENANT2_SLUG,
  TEST_USER_ID,
  TEST_USER2_ID,
  TEST_USER_EMAIL,
  TEST_USER2_EMAIL,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
} from './fixtures';

const { Client } = pg;

// Boots the real Nest app with the same global ValidationPipe as src/main.ts,
// so DTO validation / whitelist / transform behave exactly as in production.
describe('Customers API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string; // tenant1 admin, scope=all
  let salesToken: string; // tenant1 sales, scope=own
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);

    adminToken = await tenantLogin(TEST_USER_EMAIL, TEST_TENANT_SLUG);
    salesToken = await tenantLogin(TEST_USER2_EMAIL, TEST_TENANT_SLUG);
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

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // Customers created during the run; ids shared across ordered tests.
  let adminCustomerId: string; // owned by admin (Acme Corp / Alice), active
  let salesCustomerId: string; // owned by sales (Sales Co / Bob), active
  let inactiveCustomerId: string; // owned by admin (Inactive Inc), inactive

  // --- auth + permission gates ---

  it('GET /api/customers with no token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/customers');
    expect(res.status).toBe(401);
  });

  it('GET /api/customers with a platform token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/customers').set(bearer(platformToken));
    expect(res.status).toBe(401);
  });

  it('GET /api/customers with a tenant user lacking permission returns 403', async () => {
    const res = await request(app.getHttpServer()).get('/api/customers').set(bearer(nopermToken));
    expect(res.status).toBe(403);
  });

  // --- create: ownership is derived from the caller, never the body ---

  it('admin creates a customer -> 201, owner_user_id = admin', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Acme Corp', contact_name: 'Alice', email: 'alice@acme.test' });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(TEST_USER_ID);
    expect(res.body.company_name).toBe('Acme Corp');
    adminCustomerId = res.body.id;
  });

  it('admin creates a second (inactive) customer for filter tests', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Inactive Inc', status: 'inactive' });
    expect(res.status).toBe(201);
    inactiveCustomerId = res.body.id;
  });

  it('sales creates a customer -> 201, owner_user_id = sales', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(salesToken))
      .send({ company_name: 'Sales Co', contact_name: 'Bob', email: 'bob@sales.test' });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(TEST_USER2_ID);
    salesCustomerId = res.body.id;
  });

  // --- dataScope: all vs own ---

  it('admin (scope=all) list sees both admin and sales customers', async () => {
    const res = await request(app.getHttpServer()).get('/api/customers').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(adminCustomerId);
    expect(ids).toContain(salesCustomerId);
  });

  it('sales (scope=own) list sees only its own customer', async () => {
    const res = await request(app.getHttpServer()).get('/api/customers').set(bearer(salesToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(salesCustomerId);
    expect(ids).not.toContain(adminCustomerId);
    const owners = res.body.data.map((c: { owner_user_id: string }) => c.owner_user_id);
    expect(owners.every((o: string) => o === TEST_USER2_ID)).toBe(true);
  });

  it('admin (scope=all) can fetch the sales customer detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/customers/${salesCustomerId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(salesCustomerId);
  });

  it('sales (scope=own) cannot view/update/delete the admin customer -> 404', async () => {
    const get = await request(app.getHttpServer())
      .get(`/api/customers/${adminCustomerId}`)
      .set(bearer(salesToken));
    expect(get.status).toBe(404);

    const patch = await request(app.getHttpServer())
      .patch(`/api/customers/${adminCustomerId}`)
      .set(bearer(salesToken))
      .send({ company_name: 'Hijacked' });
    expect(patch.status).toBe(404);

    const del = await request(app.getHttpServer())
      .delete(`/api/customers/${adminCustomerId}`)
      .set(bearer(salesToken));
    expect(del.status).toBe(404);
  });

  // --- update + soft delete ---

  it('admin updates the sales customer -> 200, field changed', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/customers/${salesCustomerId}`)
      .set(bearer(adminToken))
      .send({ contact_name: 'Bobby', status: 'inactive' });
    expect(res.status).toBe(200);
    expect(res.body.contact_name).toBe('Bobby');
    expect(res.body.status).toBe('inactive');
  });

  it('admin soft-deletes the sales customer -> 200 { deleted: true }', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/customers/${salesCustomerId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: salesCustomerId, deleted: true });
  });

  it('soft-deleted customer is no longer listed', async () => {
    const res = await request(app.getHttpServer()).get('/api/customers').set(bearer(adminToken));
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(salesCustomerId);
  });

  it('soft-deleted customer detail returns 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/customers/${salesCustomerId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(404);
  });

  // --- cross-tenant isolation (RLS): tenant2 cannot see tenant1 rows ---

  it('tenant2 admin cannot fetch a tenant1 customer -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/customers/${adminCustomerId}`)
      .set(bearer(tenant2Token));
    expect(res.status).toBe(404);
  });

  it('tenant2 admin cannot update/delete a tenant1 customer -> 404', async () => {
    const patch = await request(app.getHttpServer())
      .patch(`/api/customers/${adminCustomerId}`)
      .set(bearer(tenant2Token))
      .send({ company_name: 'X' });
    expect(patch.status).toBe(404);
    const del = await request(app.getHttpServer())
      .delete(`/api/customers/${adminCustomerId}`)
      .set(bearer(tenant2Token));
    expect(del.status).toBe(404);
  });

  it('tenant2 admin list does not include any tenant1 customer', async () => {
    const res = await request(app.getHttpServer()).get('/api/customers').set(bearer(tenant2Token));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).not.toContain(adminCustomerId);
    expect(ids).not.toContain(inactiveCustomerId);
  });

  // --- validation (global ValidationPipe, same config as main.ts) ---

  it('create with invalid email returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Bad Email Co', email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('create with empty company_name returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: '' });
    expect(res.status).toBe(400);
  });

  it('create with an unknown field returns 400 (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Has Extra', is_tenant_owner: true });
    expect(res.status).toBe(400);
  });

  it('empty PATCH body returns 400', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/customers/${adminCustomerId}`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  // --- search, filter, pagination ---

  it('search q matches company_name', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .query({ q: 'Acme' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const names = res.body.data.map((c: { company_name: string }) => c.company_name);
    expect(names).toContain('Acme Corp');
    expect(names).not.toContain('Inactive Inc');
  });

  it('search q matches contact_name', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .query({ q: 'Alice' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(adminCustomerId);
  });

  it('search q matches email', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .query({ q: 'alice@acme' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(adminCustomerId);
  });

  it('status filter returns only matching customers', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .query({ status: 'inactive' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((c: { status: string }) => c.status === 'inactive')).toBe(true);
  });

  it('pagination caps page size and reports total', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/customers')
      .query({ page: 1, pageSize: 1 })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(1);
    expect(res.body.total).toBeGreaterThan(1);
  });

  // --- response allowlist: internal columns never leak over HTTP ---

  it('list and detail responses do not leak tenant_id / deleted_at / notes', async () => {
    const list = await request(app.getHttpServer()).get('/api/customers').set(bearer(adminToken));
    for (const c of list.body.data) {
      expect(c).not.toHaveProperty('tenant_id');
      expect(c).not.toHaveProperty('deleted_at');
      expect(c).not.toHaveProperty('notes');
    }
    const detail = await request(app.getHttpServer())
      .get(`/api/customers/${adminCustomerId}`)
      .set(bearer(adminToken));
    expect(detail.body).not.toHaveProperty('tenant_id');
    expect(detail.body).not.toHaveProperty('deleted_at');
    expect(detail.body).not.toHaveProperty('notes');
  });

  // --- audit + hash chain ---

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it('customer.created / updated / deleted audit records exist for tenant1', async () => {
    const rows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT action, resource_type FROM audit_logs
         WHERE tenant_id = $1 AND resource_type = 'customer' ORDER BY id ASC`,
        [TEST_TENANT_ID],
      );
      return r.rows;
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('customer.created');
    expect(actions).toContain('customer.updated');
    expect(actions).toContain('customer.deleted');
  });

  it('tenant1 chain advanced and verifyChain passes', async () => {
    const chain = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT last_log_id, last_hash FROM audit_log_chains WHERE chain_key = $1`,
        [`tenant:${TEST_TENANT_ID}`],
      );
      return r.rows[0];
    });
    expect(chain.last_log_id).not.toBeNull();
    expect(chain.last_hash).not.toBe('0'.repeat(64));

    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });

  // --- direct DB RLS assertion (app role), without modifying
  //     scripts/security-regression.mjs ---

  it('RLS hides customers under no / wrong tenant context (app role)', async () => {
    const client = new Client({ connectionString: process.env.APP_DATABASE_URL });
    await client.connect();
    try {
      const db = await client.query('SELECT current_database() AS db');
      expect(db.rows[0].db).toBe('kirindesk_test');

      // No tenant context -> app_current_tenant_id() is NULL -> 0 rows.
      const none = await client.query(`SELECT count(*)::int AS n FROM customers`);
      expect(none.rows[0].n).toBe(0);

      // Wrong tenant context -> still 0 rows for tenant1's customers.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [
        '99999999-9999-9999-9999-999999999999',
      ]);
      const wrong = await client.query(`SELECT count(*)::int AS n FROM customers`);
      expect(wrong.rows[0].n).toBe(0);

      // Correct tenant context -> tenant1's customers become visible.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TEST_TENANT_ID]);
      const right = await client.query(`SELECT count(*)::int AS n FROM customers`);
      expect(right.rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });
});
