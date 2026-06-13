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

// Boots the real Nest app with the same global ValidationPipe as src/main.ts.
describe('Purchase Orders API (integration)', () => {
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

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // Creates a supplier via the API and returns its id (orders need a valid FK).
  async function createSupplier(token: string, companyName: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(token))
      .send({ company_name: companyName });
    expect(res.status).toBe(201);
    return res.body.id as string;
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

    adminSupplierId = await createSupplier(adminToken, 'PO Admin Supplier');
    salesSupplierId = await createSupplier(salesToken, 'PO Sales Supplier');
    tenant2SupplierId = await createSupplier(tenant2Token, 'PO T2 Supplier');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // Suppliers (owned per role) used as order FKs.
  let adminSupplierId: string;
  let salesSupplierId: string;
  let tenant2SupplierId: string;

  // Orders created during the run; ids shared across ordered tests.
  let adminOrderId: string; // owned by admin
  let salesOrderId: string; // owned by sales

  // --- auth + permission gates ---

  it('GET /api/purchase-orders with no token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/purchase-orders');
    expect(res.status).toBe(401);
  });

  it('GET /api/purchase-orders with a platform token returns 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .set(bearer(platformToken));
    expect(res.status).toBe(401);
  });

  it('GET /api/purchase-orders with a tenant user lacking permission returns 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .set(bearer(nopermToken));
    expect(res.status).toBe(403);
  });

  // --- create: ownership from caller, total_amount derived from items ---

  it('admin creates an order -> 201, owner = admin, total derived from items', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({
        supplier_id: adminSupplierId,
        order_number: 'PO-ADMIN-1',
        currency: 'USD',
        items: [{ description: 'Widget', quantity: '2', unit_price: '617.25' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(TEST_USER_ID);
    expect(res.body.order_number).toBe('PO-ADMIN-1');
    expect(res.body.status).toBe('draft');
    expect(res.body.total_amount).toBe('1234.50');
    expect(typeof res.body.total_amount).toBe('string');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].line_no).toBe(1);
    expect(res.body.items[0].line_total).toBe('1234.50');
    adminOrderId = res.body.id;
  });

  it('sales creates an order -> 201, owner = sales', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(salesToken))
      .send({
        supplier_id: salesSupplierId,
        order_number: 'PO-SALES-1',
        currency: 'RMB',
        items: [{ description: 'Sample', quantity: '1', unit_price: '99' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(TEST_USER2_ID);
    expect(res.body.total_amount).toBe('99.00');
    salesOrderId = res.body.id;
  });

  // --- supplier_id scope enforcement at create time (404) ---

  it('sales cannot create an order against the admin supplier -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(salesToken))
      .send({
        supplier_id: adminSupplierId,
        order_number: 'PO-SALES-X',
        currency: 'USD',
      });
    expect(res.status).toBe(404);
  });

  it('admin cannot create an order against a tenant2 supplier -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({
        supplier_id: tenant2SupplierId,
        order_number: 'PO-ADMIN-X',
        currency: 'USD',
      });
    expect(res.status).toBe(404);
  });

  // --- duplicate order_number within a tenant -> 409 ---

  it('duplicate order_number in the same tenant returns 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({
        supplier_id: adminSupplierId,
        order_number: 'PO-ADMIN-1',
        currency: 'USD',
      });
    expect(res.status).toBe(409);
  });

  // --- dataScope: all vs own ---

  it('admin (scope=all) list sees both admin and sales orders', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).toContain(adminOrderId);
    expect(ids).toContain(salesOrderId);
  });

  it('sales (scope=own) list sees only its own order', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .set(bearer(salesToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).toContain(salesOrderId);
    expect(ids).not.toContain(adminOrderId);
  });

  it('admin (scope=all) can fetch the sales order detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/purchase-orders/${salesOrderId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(salesOrderId);
  });

  it('sales (scope=own) cannot view/update/delete the admin order -> 404', async () => {
    const get = await request(app.getHttpServer())
      .get(`/api/purchase-orders/${adminOrderId}`)
      .set(bearer(salesToken));
    expect(get.status).toBe(404);

    const patch = await request(app.getHttpServer())
      .patch(`/api/purchase-orders/${adminOrderId}`)
      .set(bearer(salesToken))
      .send({ status: 'confirmed' });
    expect(patch.status).toBe(404);

    const del = await request(app.getHttpServer())
      .delete(`/api/purchase-orders/${adminOrderId}`)
      .set(bearer(salesToken));
    expect(del.status).toBe(404);
  });

  // --- update + soft delete ---

  it('admin updates the sales order -> 200, status + items replaced, total re-derived', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/purchase-orders/${salesOrderId}`)
      .set(bearer(adminToken))
      .send({
        status: 'confirmed',
        items: [{ description: 'Revised', quantity: '3', unit_price: '50' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.total_amount).toBe('150.00');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].line_no).toBe(1);
    expect(res.body.items[0].line_total).toBe('150.00');
  });

  it('admin soft-deletes the sales order -> 200 { deleted: true }', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/purchase-orders/${salesOrderId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: salesOrderId, deleted: true });
  });

  it('soft-deleted order is no longer listed and detail returns 404', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .set(bearer(adminToken));
    const ids = list.body.data.map((o: { id: string }) => o.id);
    expect(ids).not.toContain(salesOrderId);

    const detail = await request(app.getHttpServer())
      .get(`/api/purchase-orders/${salesOrderId}`)
      .set(bearer(adminToken));
    expect(detail.status).toBe(404);
  });

  // --- cross-tenant isolation (RLS): tenant2 cannot see tenant1 rows ---

  it('tenant2 admin cannot fetch/update/delete a tenant1 order -> 404', async () => {
    const get = await request(app.getHttpServer())
      .get(`/api/purchase-orders/${adminOrderId}`)
      .set(bearer(tenant2Token));
    expect(get.status).toBe(404);
    const patch = await request(app.getHttpServer())
      .patch(`/api/purchase-orders/${adminOrderId}`)
      .set(bearer(tenant2Token))
      .send({ status: 'cancelled' });
    expect(patch.status).toBe(404);
    const del = await request(app.getHttpServer())
      .delete(`/api/purchase-orders/${adminOrderId}`)
      .set(bearer(tenant2Token));
    expect(del.status).toBe(404);
  });

  it('tenant2 admin list does not include any tenant1 order', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .set(bearer(tenant2Token));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).not.toContain(adminOrderId);
  });

  // --- validation (global ValidationPipe, same config as main.ts) ---

  it('create with invalid currency returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({
        supplier_id: adminSupplierId,
        order_number: 'PO-BAD-CUR',
        currency: 'JPY',
      });
    expect(res.status).toBe(400);
  });

  it('create with negative / over-precision item unit_price returns 400', async () => {
    const neg = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({
        supplier_id: adminSupplierId,
        order_number: 'PO-NEG',
        currency: 'USD',
        items: [{ description: 'Bad', quantity: '1', unit_price: '-1' }],
      });
    expect(neg.status).toBe(400);

    const prec = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({
        supplier_id: adminSupplierId,
        order_number: 'PO-PREC',
        currency: 'USD',
        items: [{ description: 'Bad', quantity: '1', unit_price: '1.23456' }],
      });
    expect(prec.status).toBe(400);
  });

  it('create non-draft with no items returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({
        supplier_id: adminSupplierId,
        order_number: 'PO-NOITEMS',
        currency: 'USD',
        status: 'confirmed',
      });
    expect(res.status).toBe(400);
  });

  it('create missing supplier_id returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({ order_number: 'PO-NOSUP', currency: 'USD' });
    expect(res.status).toBe(400);
  });

  it('create with an unknown field returns 400 (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(adminToken))
      .send({
        supplier_id: adminSupplierId,
        order_number: 'PO-EXTRA',
        currency: 'USD',
        pi_file_id: '00000000-0000-0000-0000-000000000000',
      });
    expect(res.status).toBe(400);
  });

  it('empty PATCH body returns 400', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/purchase-orders/${adminOrderId}`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  // --- search + filter ---

  it('search q matches order_number', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .query({ q: 'PO-ADMIN-1' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).toContain(adminOrderId);
  });

  it('supplier_id filter returns only matching orders', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .query({ supplier_id: adminSupplierId })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(
      res.body.data.every((o: { supplier_id: string }) => o.supplier_id === adminSupplierId),
    ).toBe(true);
  });

  // --- response allowlist: internal columns never leak over HTTP ---

  it('responses do not leak tenant_id / deleted_at / notes / pi_file_id', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/purchase-orders')
      .set(bearer(adminToken));
    for (const o of list.body.data) {
      expect(o).not.toHaveProperty('tenant_id');
      expect(o).not.toHaveProperty('deleted_at');
      expect(o).not.toHaveProperty('notes');
      expect(o).not.toHaveProperty('pi_file_id');
    }
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

  it('purchase_order.created / updated / deleted audit records exist for tenant1', async () => {
    const rows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT action FROM audit_logs
         WHERE tenant_id = $1 AND resource_type = 'purchase_order' ORDER BY id ASC`,
        [TEST_TENANT_ID],
      );
      return r.rows;
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('purchase_order.created');
    expect(actions).toContain('purchase_order.updated');
    expect(actions).toContain('purchase_order.deleted');
  });

  it('tenant1 chain still verifies after order activity', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });

  // --- direct DB RLS assertion (app role) ---

  it('RLS hides purchase_orders under no / wrong tenant context (app role)', async () => {
    const client = new Client({ connectionString: process.env.APP_DATABASE_URL });
    await client.connect();
    try {
      const db = await client.query('SELECT current_database() AS db');
      expect(db.rows[0].db).toBe('kirindesk_test');

      const none = await client.query(`SELECT count(*)::int AS n FROM purchase_orders`);
      expect(none.rows[0].n).toBe(0);

      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [
        '99999999-9999-9999-9999-999999999999',
      ]);
      const wrong = await client.query(`SELECT count(*)::int AS n FROM purchase_orders`);
      expect(wrong.rows[0].n).toBe(0);

      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TEST_TENANT_ID]);
      const right = await client.query(`SELECT count(*)::int AS n FROM purchase_orders`);
      expect(right.rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });
});
