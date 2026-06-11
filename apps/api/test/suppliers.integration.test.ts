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
describe('Suppliers API (integration)', () => {
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

  // Suppliers created during the run; ids shared across ordered tests.
  let adminSupplierId: string; // owned by admin (Acme Supply / Alice), active
  let salesSupplierId: string; // owned by sales (Sales Supply / Bob), active
  let inactiveSupplierId: string; // owned by admin (Inactive Supply), inactive

  // --- auth + permission gates ---

  it('GET /api/suppliers with no token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/suppliers');
    expect(res.status).toBe(401);
  });

  it('GET /api/suppliers with a platform token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/suppliers').set(bearer(platformToken));
    expect(res.status).toBe(401);
  });

  it('GET /api/suppliers with a tenant user lacking permission returns 403', async () => {
    const res = await request(app.getHttpServer()).get('/api/suppliers').set(bearer(nopermToken));
    expect(res.status).toBe(403);
  });

  // --- create: ownership is derived from the caller, never the body ---

  it('admin creates a supplier -> 201, owner_user_id = admin', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: 'Acme Supply', contact_name: 'Alice', email: 'alice@acmesupply.test' });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(TEST_USER_ID);
    expect(res.body.company_name).toBe('Acme Supply');
    adminSupplierId = res.body.id;
  });

  it('admin creates a second (inactive) supplier for filter tests', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: 'Inactive Supply', status: 'inactive', category: '包材' });
    expect(res.status).toBe(201);
    inactiveSupplierId = res.body.id;
  });

  it('sales creates a supplier -> 201, owner_user_id = sales', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(salesToken))
      .send({ company_name: 'Sales Supply', contact_name: 'Bob', email: 'bob@salessupply.test' });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(TEST_USER2_ID);
    salesSupplierId = res.body.id;
  });

  // --- dataScope: all vs own ---

  it('admin (scope=all) list sees both admin and sales suppliers', async () => {
    const res = await request(app.getHttpServer()).get('/api/suppliers').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(adminSupplierId);
    expect(ids).toContain(salesSupplierId);
  });

  it('sales (scope=own) list sees only its own supplier', async () => {
    const res = await request(app.getHttpServer()).get('/api/suppliers').set(bearer(salesToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(salesSupplierId);
    expect(ids).not.toContain(adminSupplierId);
    const owners = res.body.data.map((s: { owner_user_id: string }) => s.owner_user_id);
    expect(owners.every((o: string) => o === TEST_USER2_ID)).toBe(true);
  });

  it('admin (scope=all) can fetch the sales supplier detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/suppliers/${salesSupplierId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(salesSupplierId);
  });

  it('sales (scope=own) cannot view/update/delete the admin supplier -> 404', async () => {
    const get = await request(app.getHttpServer())
      .get(`/api/suppliers/${adminSupplierId}`)
      .set(bearer(salesToken));
    expect(get.status).toBe(404);

    const patch = await request(app.getHttpServer())
      .patch(`/api/suppliers/${adminSupplierId}`)
      .set(bearer(salesToken))
      .send({ company_name: 'Hijacked' });
    expect(patch.status).toBe(404);

    const del = await request(app.getHttpServer())
      .delete(`/api/suppliers/${adminSupplierId}`)
      .set(bearer(salesToken));
    expect(del.status).toBe(404);
  });

  // --- update + soft delete ---

  it('admin updates the sales supplier -> 200, field changed', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/suppliers/${salesSupplierId}`)
      .set(bearer(adminToken))
      .send({ contact_name: 'Bobby', status: 'inactive', category: '原料' });
    expect(res.status).toBe(200);
    expect(res.body.contact_name).toBe('Bobby');
    expect(res.body.status).toBe('inactive');
    expect(res.body.category).toBe('原料');
  });

  it('admin soft-deletes the sales supplier -> 200 { deleted: true }', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/suppliers/${salesSupplierId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: salesSupplierId, deleted: true });
  });

  it('soft-deleted supplier is no longer listed', async () => {
    const res = await request(app.getHttpServer()).get('/api/suppliers').set(bearer(adminToken));
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(salesSupplierId);
  });

  it('soft-deleted supplier detail returns 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/suppliers/${salesSupplierId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(404);
  });

  // --- cross-tenant isolation (RLS): tenant2 cannot see tenant1 rows ---

  it('tenant2 admin cannot fetch a tenant1 supplier -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/suppliers/${adminSupplierId}`)
      .set(bearer(tenant2Token));
    expect(res.status).toBe(404);
  });

  it('tenant2 admin cannot update/delete a tenant1 supplier -> 404', async () => {
    const patch = await request(app.getHttpServer())
      .patch(`/api/suppliers/${adminSupplierId}`)
      .set(bearer(tenant2Token))
      .send({ company_name: 'X' });
    expect(patch.status).toBe(404);
    const del = await request(app.getHttpServer())
      .delete(`/api/suppliers/${adminSupplierId}`)
      .set(bearer(tenant2Token));
    expect(del.status).toBe(404);
  });

  it('tenant2 admin list does not include any tenant1 supplier', async () => {
    const res = await request(app.getHttpServer()).get('/api/suppliers').set(bearer(tenant2Token));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).not.toContain(adminSupplierId);
    expect(ids).not.toContain(inactiveSupplierId);
  });

  // --- validation (global ValidationPipe, same config as main.ts) ---

  it('create with invalid email returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: 'Bad Email Supply', email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('create with empty company_name returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: '' });
    expect(res.status).toBe(400);
  });

  it('create with an unknown field returns 400 (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: 'Has Extra', is_tenant_owner: true });
    expect(res.status).toBe(400);
  });

  it('empty PATCH body returns 400', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/suppliers/${adminSupplierId}`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  // --- search, filter, pagination ---

  it('search q matches company_name', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/suppliers')
      .query({ q: 'Acme' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const names = res.body.data.map((s: { company_name: string }) => s.company_name);
    expect(names).toContain('Acme Supply');
    expect(names).not.toContain('Inactive Supply');
  });

  it('search q matches contact_name', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/suppliers')
      .query({ q: 'Alice' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(adminSupplierId);
  });

  it('search q matches email', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/suppliers')
      .query({ q: 'alice@acmesupply' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(adminSupplierId);
  });

  it('status filter returns only matching suppliers', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/suppliers')
      .query({ status: 'inactive' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((s: { status: string }) => s.status === 'inactive')).toBe(true);
  });

  it('pagination caps page size and reports total', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/suppliers')
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
    const list = await request(app.getHttpServer()).get('/api/suppliers').set(bearer(adminToken));
    for (const s of list.body.data) {
      expect(s).not.toHaveProperty('tenant_id');
      expect(s).not.toHaveProperty('deleted_at');
      expect(s).not.toHaveProperty('notes');
    }
    const detail = await request(app.getHttpServer())
      .get(`/api/suppliers/${adminSupplierId}`)
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

  it('supplier.created / updated / deleted audit records exist for tenant1', async () => {
    const rows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT action, resource_type FROM audit_logs
         WHERE tenant_id = $1 AND resource_type = 'supplier' ORDER BY id ASC`,
        [TEST_TENANT_ID],
      );
      return r.rows;
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('supplier.created');
    expect(actions).toContain('supplier.updated');
    expect(actions).toContain('supplier.deleted');
  });

  it('tenant1 chain verifyChain still passes after supplier writes', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });

  // --- direct DB RLS assertion (app role) ---

  it('RLS hides suppliers under no / wrong tenant context (app role)', async () => {
    const client = new Client({ connectionString: process.env.APP_DATABASE_URL });
    await client.connect();
    try {
      const db = await client.query('SELECT current_database() AS db');
      expect(db.rows[0].db).toBe('kirindesk_test');

      // No tenant context -> app_current_tenant_id() is NULL -> 0 rows.
      const none = await client.query(`SELECT count(*)::int AS n FROM suppliers`);
      expect(none.rows[0].n).toBe(0);

      // Wrong tenant context -> still 0 rows for tenant1's suppliers.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [
        '99999999-9999-9999-9999-999999999999',
      ]);
      const wrong = await client.query(`SELECT count(*)::int AS n FROM suppliers`);
      expect(wrong.rows[0].n).toBe(0);

      // Correct tenant context -> tenant1's suppliers become visible.
      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TEST_TENANT_ID]);
      const right = await client.query(`SELECT count(*)::int AS n FROM suppliers`);
      expect(right.rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });
});
