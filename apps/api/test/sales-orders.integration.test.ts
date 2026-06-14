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
describe('Sales Orders API (integration)', () => {
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

  // Creates a customer via the API and returns its id (orders need a valid FK).
  async function createCustomer(token: string, companyName: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
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

    adminCustomerId = await createCustomer(adminToken, 'Order Admin Customer');
    salesCustomerId = await createCustomer(salesToken, 'Order Sales Customer');
    tenant2CustomerId = await createCustomer(tenant2Token, 'Order T2 Customer');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // Customers (owned per role) used as order FKs.
  let adminCustomerId: string;
  let salesCustomerId: string;
  let tenant2CustomerId: string;

  // Orders created during the run; ids shared across ordered tests.
  let adminOrderId: string; // owned by admin
  let salesOrderId: string; // owned by sales

  // --- auth + permission gates ---

  it('GET /api/sales-orders with no token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/sales-orders');
    expect(res.status).toBe(401);
  });

  it('GET /api/sales-orders with a platform token returns 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/sales-orders')
      .set(bearer(platformToken));
    expect(res.status).toBe(401);
  });

  it('GET /api/sales-orders with a tenant user lacking permission returns 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/sales-orders')
      .set(bearer(nopermToken));
    expect(res.status).toBe(403);
  });

  // --- create: ownership from caller, total_amount derived from items ---

  it('admin creates an order -> 201, owner = admin, total derived from items', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-ADMIN-1',
        currency: 'USD',
        // 2 * 617.25 = 1234.50, derived server-side.
        items: [{ description: 'Widget', quantity: '2', unit_price: '617.25' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(TEST_USER_ID);
    expect(res.body.order_number).toBe('SO-ADMIN-1');
    expect(res.body.status).toBe('draft');
    // total_amount is derived (Σ line_total), not client-supplied.
    expect(res.body.total_amount).toBe('1234.50');
    expect(typeof res.body.total_amount).toBe('string');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].line_no).toBe(1);
    expect(res.body.items[0].line_total).toBe('1234.50');
    adminOrderId = res.body.id;
  });

  it('sales creates an order -> 201, owner = sales', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(salesToken))
      .send({
        customer_id: salesCustomerId,
        order_number: 'SO-SALES-1',
        currency: 'RMB',
        items: [{ description: 'Sample', quantity: '1', unit_price: '99' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.owner_user_id).toBe(TEST_USER2_ID);
    expect(res.body.total_amount).toBe('99.00');
    salesOrderId = res.body.id;
  });

  // --- customer_id scope enforcement at create time (404) ---

  it('sales cannot create an order against the admin customer -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(salesToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-SALES-X',
        currency: 'USD',
      });
    expect(res.status).toBe(404);
  });

  it('admin cannot create an order against a tenant2 customer -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: tenant2CustomerId,
        order_number: 'SO-ADMIN-X',
        currency: 'USD',
      });
    expect(res.status).toBe(404);
  });

  // --- duplicate order_number within a tenant -> 409 ---

  it('duplicate order_number in the same tenant returns 409', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-ADMIN-1',
        currency: 'USD',
      });
    expect(res.status).toBe(409);
  });

  // --- dataScope: all vs own ---

  it('admin (scope=all) list sees both admin and sales orders', async () => {
    const res = await request(app.getHttpServer()).get('/api/sales-orders').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).toContain(adminOrderId);
    expect(ids).toContain(salesOrderId);
  });

  it('sales (scope=own) list sees only its own order', async () => {
    const res = await request(app.getHttpServer()).get('/api/sales-orders').set(bearer(salesToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).toContain(salesOrderId);
    expect(ids).not.toContain(adminOrderId);
  });

  it('admin (scope=all) can fetch the sales order detail', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/sales-orders/${salesOrderId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(salesOrderId);
  });

  it('sales (scope=own) cannot view/update/delete the admin order -> 404', async () => {
    const get = await request(app.getHttpServer())
      .get(`/api/sales-orders/${adminOrderId}`)
      .set(bearer(salesToken));
    expect(get.status).toBe(404);

    const patch = await request(app.getHttpServer())
      .patch(`/api/sales-orders/${adminOrderId}`)
      .set(bearer(salesToken))
      .send({ status: 'confirmed' });
    expect(patch.status).toBe(404);

    const del = await request(app.getHttpServer())
      .delete(`/api/sales-orders/${adminOrderId}`)
      .set(bearer(salesToken));
    expect(del.status).toBe(404);
  });

  // --- update + soft delete ---

  it('admin updates the sales order -> 200, status + items replaced, total re-derived', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/sales-orders/${salesOrderId}`)
      .set(bearer(adminToken))
      .send({
        status: 'confirmed',
        // Replace lines: 3 * 50.00 = 150.00 derived.
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
      .delete(`/api/sales-orders/${salesOrderId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: salesOrderId, deleted: true });
  });

  it('soft-deleted order is no longer listed and detail returns 404', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/sales-orders')
      .set(bearer(adminToken));
    const ids = list.body.data.map((o: { id: string }) => o.id);
    expect(ids).not.toContain(salesOrderId);

    const detail = await request(app.getHttpServer())
      .get(`/api/sales-orders/${salesOrderId}`)
      .set(bearer(adminToken));
    expect(detail.status).toBe(404);
  });

  // --- cross-tenant isolation (RLS): tenant2 cannot see tenant1 rows ---

  it('tenant2 admin cannot fetch/update/delete a tenant1 order -> 404', async () => {
    const get = await request(app.getHttpServer())
      .get(`/api/sales-orders/${adminOrderId}`)
      .set(bearer(tenant2Token));
    expect(get.status).toBe(404);
    const patch = await request(app.getHttpServer())
      .patch(`/api/sales-orders/${adminOrderId}`)
      .set(bearer(tenant2Token))
      .send({ status: 'cancelled' });
    expect(patch.status).toBe(404);
    const del = await request(app.getHttpServer())
      .delete(`/api/sales-orders/${adminOrderId}`)
      .set(bearer(tenant2Token));
    expect(del.status).toBe(404);
  });

  it('tenant2 admin list does not include any tenant1 order', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/sales-orders')
      .set(bearer(tenant2Token));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).not.toContain(adminOrderId);
  });

  // --- validation (global ValidationPipe, same config as main.ts) ---

  it('create with invalid currency returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-BAD-CUR',
        currency: 'JPY',
      });
    expect(res.status).toBe(400);
  });

  it('create with negative / over-precision item unit_price returns 400', async () => {
    const neg = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-NEG',
        currency: 'USD',
        items: [{ description: 'Bad', quantity: '1', unit_price: '-1' }],
      });
    expect(neg.status).toBe(400);

    const prec = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-PREC',
        currency: 'USD',
        // unit_price allows up to 4 decimals; 5 decimals is rejected.
        items: [{ description: 'Bad', quantity: '1', unit_price: '1.23456' }],
      });
    expect(prec.status).toBe(400);
  });

  it('create non-draft with no items returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-NOITEMS',
        currency: 'USD',
        status: 'confirmed',
      });
    expect(res.status).toBe(400);
  });

  it('create missing customer_id returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({ order_number: 'SO-NOCUST', currency: 'USD' });
    expect(res.status).toBe(400);
  });

  it('create with an unknown field returns 400 (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-EXTRA',
        currency: 'USD',
        pi_file_id: '00000000-0000-0000-0000-000000000000',
      });
    expect(res.status).toBe(400);
  });

  it('empty PATCH body returns 400', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/sales-orders/${adminOrderId}`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  // --- search + filter ---

  it('search q matches order_number', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/sales-orders')
      .query({ q: 'SO-ADMIN-1' })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((o: { id: string }) => o.id);
    expect(ids).toContain(adminOrderId);
  });

  it('customer_id filter returns only matching orders', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/sales-orders')
      .query({ customer_id: adminCustomerId })
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(
      res.body.data.every((o: { customer_id: string }) => o.customer_id === adminCustomerId),
    ).toBe(true);
  });

  // --- response allowlist: internal columns never leak over HTTP ---

  it('responses do not leak tenant_id / deleted_at / notes / pi_file_id', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/sales-orders')
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

  it('sales_order.created / updated / deleted audit records exist for tenant1', async () => {
    const rows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT action FROM audit_logs
         WHERE tenant_id = $1 AND resource_type = 'sales_order' ORDER BY id ASC`,
        [TEST_TENANT_ID],
      );
      return r.rows;
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('sales_order.created');
    expect(actions).toContain('sales_order.updated');
    expect(actions).toContain('sales_order.deleted');
  });

  it('tenant1 chain still verifies after order activity', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });

  // --- Phase 1F-B: FX snapshot (rate + source) + derived base total ---
  // The test tenant seeds no base_currency row, so base currency defaults to
  // RMB, and no exchange_rates rows exist unless a test inserts them.

  // Inserts a tenant1 exchange_rates row (base RMB -> quote) for the mock path.
  async function seedRate(quote: string, rate: string, yearMonth: string): Promise<void> {
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO exchange_rates
           (tenant_id, base_currency, quote_currency, rate, year_month, source)
         VALUES ($1, 'RMB', $2, $3, $4, 'manual')
         ON CONFLICT (tenant_id, base_currency, quote_currency, year_month)
         DO UPDATE SET rate = EXCLUDED.rate`,
        [TEST_TENANT_ID, quote, rate, yearMonth],
      );
    });
  }

  let fxSameId: string; // RMB order (same currency)
  let fxManualId: string; // USD order with manual rate
  let fxMockId: string; // HKD order resolved via exchange_rates
  let fxNullId: string; // EUR order with no rate available

  it('same-currency order (RMB) freezes fx_rate=1 / source=system / base=total', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-FX-SAME',
        currency: 'RMB',
        items: [{ description: 'Domestic', quantity: '2', unit_price: '617.25' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.total_amount).toBe('1234.50');
    expect(res.body.fx_rate).toBe('1.00000000');
    expect(res.body.fx_rate_source).toBe('system');
    expect(res.body.total_amount_base).toBe('1234.50');
    expect(res.body.fx_captured_at).not.toBeNull();
    fxSameId = res.body.id;
  });

  it('manual fx_rate override freezes the value and derives base correctly', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-FX-MANUAL',
        currency: 'USD',
        fx_rate: '7.25',
        // 1 * 100.00 = 100.00 total; base = 100.00 * 7.25 = 725.00
        items: [{ description: 'Imported', quantity: '1', unit_price: '100' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.total_amount).toBe('100.00');
    expect(res.body.fx_rate).toBe('7.25000000');
    expect(res.body.fx_rate_source).toBe('manual');
    expect(res.body.total_amount_base).toBe('725.00');
    fxManualId = res.body.id;
  });

  it('exchange_rates lookup hit freezes source=mock with the stored rate', async () => {
    await seedRate('HKD', '0.92', '2099-01');
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-FX-MOCK',
        currency: 'HKD',
        // 1 * 200.00 = 200.00 total; base = 200.00 * 0.92 = 184.00
        items: [{ description: 'HK goods', quantity: '1', unit_price: '200' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.total_amount).toBe('200.00');
    expect(res.body.fx_rate).toBe('0.92000000');
    expect(res.body.fx_rate_source).toBe('mock');
    expect(res.body.total_amount_base).toBe('184.00');
    fxMockId = res.body.id;
  });

  it('no rate available (cross-currency, no manual, no exchange_rates) -> FX columns NULL', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: adminCustomerId,
        order_number: 'SO-FX-NULL',
        currency: 'EUR',
        items: [{ description: 'EU goods', quantity: '1', unit_price: '50' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.total_amount).toBe('50.00');
    expect(res.body.fx_rate).toBeNull();
    expect(res.body.fx_rate_source).toBeNull();
    expect(res.body.fx_captured_at).toBeNull();
    expect(res.body.total_amount_base).toBeNull();
    fxNullId = res.body.id;
  });

  it('updating fx_rate re-derives total_amount_base', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/sales-orders/${fxManualId}`)
      .set(bearer(adminToken))
      .send({ fx_rate: '7.5' });
    expect(res.status).toBe(200);
    // total unchanged (100.00); base = 100.00 * 7.5 = 750.00
    expect(res.body.total_amount).toBe('100.00');
    expect(res.body.fx_rate).toBe('7.50000000');
    expect(res.body.fx_rate_source).toBe('manual');
    expect(res.body.total_amount_base).toBe('750.00');
  });

  it('getOne returns the frozen FX snapshot fields', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/sales-orders/${fxMockId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.fx_rate).toBe('0.92000000');
    expect(res.body.fx_rate_source).toBe('mock');
    expect(res.body.total_amount_base).toBe('184.00');
  });

  it('FX fields are captured in the audit after-snapshot', async () => {
    const after = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT after_json FROM audit_logs
         WHERE tenant_id = $1 AND resource_type = 'sales_order'
           AND action = 'sales_order.created' AND resource_id = $2
         ORDER BY id DESC LIMIT 1`,
        [TEST_TENANT_ID, fxMockId],
      );
      return r.rows[0]?.after_json;
    });
    expect(after).toBeTruthy();
    expect(after.fx_rate).toBe('0.92000000');
    expect(after.fx_rate_source).toBe('mock');
    expect(after.total_amount_base).toBe('184.00');
  });

  it('chain still verifies after FX order activity', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
    // Touch the null-FX order id so the lint/TS unused-var check stays clean.
    expect(fxSameId && fxNullId).toBeTruthy();
  });

  // --- direct DB RLS assertion (app role) ---

  it('RLS hides sales_orders under no / wrong tenant context (app role)', async () => {
    const client = new Client({ connectionString: process.env.APP_DATABASE_URL });
    await client.connect();
    try {
      const db = await client.query('SELECT current_database() AS db');
      expect(db.rows[0].db).toBe('kirindesk_test');

      const none = await client.query(`SELECT count(*)::int AS n FROM sales_orders`);
      expect(none.rows[0].n).toBe(0);

      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [
        '99999999-9999-9999-9999-999999999999',
      ]);
      const wrong = await client.query(`SELECT count(*)::int AS n FROM sales_orders`);
      expect(wrong.rows[0].n).toBe(0);

      await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TEST_TENANT_ID]);
      const right = await client.query(`SELECT count(*)::int AS n FROM sales_orders`);
      expect(right.rows[0].n).toBeGreaterThan(0);
    } finally {
      await client.end();
    }
  });
});
