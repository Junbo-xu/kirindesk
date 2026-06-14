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
  TEST_USER_EMAIL,
  TEST_USER2_EMAIL,
  TEST_USER4_EMAIL,
  TEST_USER3_EMAIL,
  TEST_PASSWORD,
} from './fixtures';

const { Client } = pg;

// Phase 1F-C: purchase order approval workflow — symmetric with the sales
// approval suite. Role matrix (from fixtures):
//   admin  (TEST_USER)  -> procurement:* at scope ALL  (can approve any order)
//   sales  (TEST_USER2) -> procurement:* at scope OWN   (approve rejected: not all-scope)
//   noperm (TEST_USER4) -> no roles                     (401/403 gate)
//   t2admin(TEST_USER3) -> tenant2 admin                (cross-tenant isolation)
describe('Purchase Orders Approval (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let salesToken: string;
  let nopermToken: string;
  let tenant2Token: string;

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

  async function createSupplier(token: string, companyName: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(token))
      .send({ company_name: companyName });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  // Creates a draft purchase order owned by the caller and returns its id.
  async function createDraft(
    token: string,
    supplierId: string,
    orderNumber: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders')
      .set(bearer(token))
      .send({
        supplier_id: supplierId,
        order_number: orderNumber,
        currency: 'RMB',
        items: [{ description: 'Item', quantity: '1', unit_price: '100' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    return res.body.id as string;
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

  let adminSupplierId: string;
  let salesSupplierId: string;

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

    adminSupplierId = await createSupplier(adminToken, 'Approval Admin Supplier');
    salesSupplierId = await createSupplier(salesToken, 'Approval Sales Supplier');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // --- auth + permission gates on the transition endpoints ---

  it('submit with no token -> 401', async () => {
    const id = await createDraft(adminToken, adminSupplierId, 'PO-AP-AUTH');
    const res = await request(app.getHttpServer()).post(`/api/purchase-orders/${id}/submit`);
    expect(res.status).toBe(401);
  });

  it('submit by a user lacking procurement:update -> 403', async () => {
    const id = await createDraft(adminToken, adminSupplierId, 'PO-AP-NOPERM');
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(nopermToken));
    expect(res.status).toBe(403);
  });

  // --- happy path: submit (sales) -> approve (admin) ---

  let happyOrderId: string;

  it('sales submits own draft -> 200, status pending_approval', async () => {
    const id = await createDraft(salesToken, salesSupplierId, 'PO-AP-HAPPY');
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_approval');
    happyOrderId = id;
  });

  it('admin (all-scope) approves the sales-submitted order -> 200, status approved', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${happyOrderId}/approve`)
      .set(bearer(adminToken))
      .send({ reason: 'looks good' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
  });

  // --- reject path ---

  it('reject without a reason -> 400', async () => {
    const id = await createDraft(salesToken, salesSupplierId, 'PO-AP-REJ-NOREASON');
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken))
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/reject`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  it('admin rejects a pending order with a reason -> 200, status rejected', async () => {
    const id = await createDraft(salesToken, salesSupplierId, 'PO-AP-REJECT');
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken))
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/reject`)
      .set(bearer(adminToken))
      .send({ reason: 'price too high' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  // --- withdraw path ---

  it('sales withdraws its own pending order -> 200, back to draft', async () => {
    const id = await createDraft(salesToken, salesSupplierId, 'PO-AP-WITHDRAW');
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken))
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/withdraw`)
      .set(bearer(salesToken))
      .send({ reason: 'need to revise' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
  });

  // --- separation of duties ---

  it('admin approving its own submission -> 403 (self-approval blocked)', async () => {
    const id = await createDraft(adminToken, adminSupplierId, 'PO-AP-SELF');
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(adminToken))
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/approve`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('submitter');
  });

  // --- all-scope requirement (scope check fires before separation of duties) ---

  it('sales (own-scope) approving -> 403 (approval requires all-scope)', async () => {
    const id = await createDraft(salesToken, salesSupplierId, 'PO-AP-OWNSCOPE');
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken))
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/approve`)
      .set(bearer(salesToken))
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('all-scope');
  });

  // --- illegal transitions -> 409 ---

  it('approve a draft order -> 409', async () => {
    const id = await createDraft(adminToken, adminSupplierId, 'PO-AP-ILLEGAL-APPROVE');
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/approve`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(409);
  });

  it('submit an already-pending order -> 409', async () => {
    const id = await createDraft(salesToken, salesSupplierId, 'PO-AP-DOUBLE-SUBMIT');
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken))
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken));
    expect(res.status).toBe(409);
  });

  it('withdraw an approved order -> 409 (approved is forward-only)', async () => {
    const id = await createDraft(salesToken, salesSupplierId, 'PO-AP-WD-APPROVED');
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/approve`)
      .set(bearer(adminToken))
      .send({})
      .expect(200);
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/withdraw`)
      .set(bearer(salesToken));
    expect(res.status).toBe(409);
  });

  // --- 404: not found / cross-tenant ---

  it('transition on a non-existent order -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/purchase-orders/00000000-0000-0000-0000-000000000000/submit')
      .set(bearer(adminToken));
    expect(res.status).toBe(404);
  });

  it('tenant2 admin cannot submit a tenant1 order -> 404', async () => {
    const id = await createDraft(adminToken, adminSupplierId, 'PO-AP-XTENANT');
    const res = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(tenant2Token));
    expect(res.status).toBe(404);
  });

  // --- ledger + audit + chain integrity ---

  it('order_approvals ledger records each transition with the actor', async () => {
    const id = await createDraft(salesToken, salesSupplierId, 'PO-AP-LEDGER');
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/submit`)
      .set(bearer(salesToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${id}/approve`)
      .set(bearer(adminToken))
      .send({ reason: 'ok' })
      .expect(200);

    const rows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT action, from_status, to_status, actor_user_id, reason
           FROM order_approvals
          WHERE order_type = 'purchase' AND order_id = $1
          ORDER BY created_at ASC`,
        [id],
      );
      return r.rows;
    });
    expect(rows.map((r) => r.action)).toEqual(['submit', 'approve']);
    expect(rows[0].from_status).toBe('draft');
    expect(rows[0].to_status).toBe('pending_approval');
    expect(rows[1].from_status).toBe('pending_approval');
    expect(rows[1].to_status).toBe('approved');
    expect(rows[1].reason).toBe('ok');
  });

  it('approval audit actions are recorded for tenant1', async () => {
    const actions = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT DISTINCT action FROM audit_logs
          WHERE tenant_id = $1 AND resource_type = 'purchase_order'`,
        [TEST_TENANT_ID],
      );
      return r.rows.map((x) => x.action as string);
    });
    expect(actions).toContain('purchase_order.submitted');
    expect(actions).toContain('purchase_order.approved');
    expect(actions).toContain('purchase_order.rejected');
    expect(actions).toContain('purchase_order.withdrawn');
  });

  it('tenant1 chain still verifies after approval activity', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });
});
