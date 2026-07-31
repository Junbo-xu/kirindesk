import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { closePool, verifyChain } from '@kirindesk/database';
import pg from 'pg';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import {
  TEST_PASSWORD,
  TEST_TENANT2_SLUG,
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_USER2_EMAIL,
  TEST_USER2_ID,
  TEST_USER3_EMAIL,
  TEST_USER_EMAIL,
  TEST_USER_ID,
} from './fixtures';

const APPROVER2_ID = '88888888-8888-4888-8888-888888888888';
const APPROVER2_EMAIL = 'procurement-approver2@test.local';
const APPROVER3_ID = '99999999-9999-4999-8999-999999999999';
const APPROVER3_EMAIL = 'procurement-approver3@test.local';
const CUSTOMER_ID = 'a0000000-0000-4000-8000-000000000001';
const SUPPLIER1_ID = 'b0000000-0000-4000-8000-000000000001';
const SUPPLIER2_ID = 'b0000000-0000-4000-8000-000000000002';
const INQUIRY_ID = 'c0000000-0000-4000-8000-000000000001';
const INQUIRY_ITEM1_ID = 'd0000000-0000-4000-8000-000000000001';
const INQUIRY_ITEM2_ID = 'd0000000-0000-4000-8000-000000000002';
const SELECTION1_ID = 'e0000000-0000-4000-8000-000000000001';
const SELECTION2_ID = 'e0000000-0000-4000-8000-000000000002';
const PI_ID = 'f0000000-0000-4000-8000-000000000001';
const PI_SERIES_ID = 'f1000000-0000-4000-8000-000000000001';
const PI_ITEM1_ID = 'f2000000-0000-4000-8000-000000000001';
const PI_ITEM2_ID = 'f2000000-0000-4000-8000-000000000002';
const SALES_ORDER_ID = 'a1000000-0000-4000-8000-000000000001';
const SALES_ITEM1_ID = 'a2000000-0000-4000-8000-000000000001';
const SALES_ITEM2_ID = 'a2000000-0000-4000-8000-000000000002';

describe('Stage 2C procurement requests (integration)', () => {
  const { Client } = pg;
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let salesToken: string;
  let approver2Token: string;
  let approver3Token: string;
  let tenant2Token: string;
  let requestId: string;
  let requestConfigVersion: number;
  let purchaseOrders: Array<{ id: string; supplier_id: string; status: string }> = [];

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function login(email: string, slug = TEST_TENANT_SLUG): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: slug });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  async function withAdmin<T>(callback: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await callback(client);
    } finally {
      await client.end();
    }
  }

  async function insertGate(status: 'open' | 'blocked'): Promise<void> {
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO procurement_gate_evaluations
           (tenant_id, sales_order_id, proforma_invoice_id, status, order_amount,
            confirmed_amount, required_amount, currency, required_ratio_bps,
            proof_required, config_enabled, bypass_reason, blocking_reasons, evaluated_by)
         VALUES ($1,$2,$3,$4,1500,${status === 'open' ? '1500' : '0'},1500,'USD',10000,
                 true,true,NULL,$5,$6)`,
        [
          TEST_TENANT_ID,
          SALES_ORDER_ID,
          PI_ID,
          status,
          JSON.stringify(status === 'open' ? [] : ['insufficient_confirmed_receipts']),
          TEST_USER_ID,
        ],
      );
    });
  }

  async function waitForBlockedPlacement(client: pg.Client, blockerPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
         ) AS blocked`,
        [blockerPid],
      );
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Placement did not wait for the sales-order lock');
  }

  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO users
             (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
           SELECT $1, tenant_id, $2, password_hash, 'Procurement Approver 2', 'active', false
             FROM users WHERE id = $3`,
          [APPROVER2_ID, APPROVER2_EMAIL, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO users
             (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
           SELECT $1, tenant_id, $2, password_hash, 'Procurement Approver 3', 'active', false
             FROM users WHERE id = $3`,
          [APPROVER3_ID, APPROVER3_EMAIL, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id)
           SELECT tenant_id, approver_id, role_id
             FROM user_roles
             CROSS JOIN unnest($1::uuid[]) AS approvers(approver_id)
            WHERE user_id = $2`,
          [[APPROVER2_ID, APPROVER3_ID], TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO customers
             (id, tenant_id, owner_user_id, company_name, country)
           VALUES ($1,$2,$3,'Stage 2C Customer','US')`,
          [CUSTOMER_ID, TEST_TENANT_ID, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO suppliers
             (id, tenant_id, owner_user_id, company_name, country)
           VALUES ($1,$3,$4,'Stage 2C Supplier A','CN'),
                  ($2,$3,$4,'Stage 2C Supplier B','CN')`,
          [SUPPLIER1_ID, SUPPLIER2_ID, TEST_TENANT_ID, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO inquiries
             (id, tenant_id, owner_user_id, customer_code, customer_country,
              customer_message, status, submitted_at, customer_id)
           VALUES ($1,$2,$3,'STAGE-2C','US','Stage 2C fixture','selected',now(),$4)`,
          [INQUIRY_ID, TEST_TENANT_ID, TEST_USER2_ID, CUSTOMER_ID],
        );
        await client.query(
          `INSERT INTO inquiry_items
             (id, tenant_id, inquiry_id, line_no, description, quantity, unit)
           VALUES ($1,$3,$4,1,'Widget A',10,'pcs'),
                  ($2,$3,$4,2,'Widget B',5,'pcs')`,
          [INQUIRY_ITEM1_ID, INQUIRY_ITEM2_ID, TEST_TENANT_ID, INQUIRY_ID],
        );
        const snapshots = [
          {
            selectionId: SELECTION1_ID,
            itemId: INQUIRY_ITEM1_ID,
            supplierId: SUPPLIER1_ID,
            quotationId: 'e1000000-0000-4000-8000-000000000001',
            quotationLineId: 'e2000000-0000-4000-8000-000000000001',
            unitPrice: '50.0000',
            description: 'Widget A',
            quantity: '10.000',
          },
          {
            selectionId: SELECTION2_ID,
            itemId: INQUIRY_ITEM2_ID,
            supplierId: SUPPLIER2_ID,
            quotationId: 'e1000000-0000-4000-8000-000000000002',
            quotationLineId: 'e2000000-0000-4000-8000-000000000002',
            unitPrice: '80.0000',
            description: 'Widget B',
            quantity: '5.000',
          },
        ];
        for (const snapshot of snapshots) {
          await client.query(
            `INSERT INTO quote_selection_snapshots
               (id, tenant_id, inquiry_id, inquiry_item_id, quotation_id,
                quotation_line_id, quotation_version, selected_by, snapshot_json,
                sales_currency, sales_unit_price, purchase_to_sales_fx_rate,
                fx_rate_source, fx_captured_at, purchase_unit_cost, gross_profit_unit,
                gross_margin_bps, margin_threshold_bps, margin_status, margin_formula_version)
             VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,'USD',100,1,'system',now(),$9,50,5000,1500,
                     'meets_threshold','gross_margin_bps_v1')`,
            [
              snapshot.selectionId,
              TEST_TENANT_ID,
              INQUIRY_ID,
              snapshot.itemId,
              snapshot.quotationId,
              snapshot.quotationLineId,
              TEST_USER2_ID,
              JSON.stringify({
                quotation_id: snapshot.quotationId,
                quotation_version: 1,
                supplier_id: snapshot.supplierId,
                currency: 'USD',
                valid_until: '2099-12-31',
                line: {
                  id: snapshot.quotationLineId,
                  inquiry_item_id: snapshot.itemId,
                  quantity: snapshot.quantity,
                  unit_price: snapshot.unitPrice,
                },
                inquiry_item: {
                  id: snapshot.itemId,
                  inquiry_id: INQUIRY_ID,
                  description: snapshot.description,
                  quantity: snapshot.quantity,
                  unit: 'pcs',
                },
              }),
              snapshot.unitPrice,
            ],
          );
        }
        await client.query(
          `INSERT INTO proforma_invoices
             (id, tenant_id, series_id, inquiry_id, customer_id, pi_number, version,
              currency, payment_terms, status, total_amount, created_by, issued_by, issued_at)
           VALUES ($1,$2,$3,$4,$5,'PI-STAGE-2C',1,'USD','100% before procurement',
                   'issued',1500,$6,$6,now())`,
          [PI_ID, TEST_TENANT_ID, PI_SERIES_ID, INQUIRY_ID, CUSTOMER_ID, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO proforma_invoice_series_selections
             (tenant_id, series_id, selection_id)
           VALUES ($1,$2,$3),($1,$2,$4)`,
          [TEST_TENANT_ID, PI_SERIES_ID, SELECTION1_ID, SELECTION2_ID],
        );
        await client.query(
          `INSERT INTO proforma_invoice_items
             (id, tenant_id, proforma_invoice_id, series_id, selection_id, line_no,
              description, quantity, unit, unit_price, line_total, selection_snapshot)
           SELECT $1::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,
                  1,'Widget A',10,'pcs',100,1000,snapshot_json
             FROM quote_selection_snapshots WHERE id = $6::uuid
           UNION ALL
           SELECT $2::uuid,$3::uuid,$4::uuid,$5::uuid,$7::uuid,
                  2,'Widget B',5,'pcs',100,500,snapshot_json
             FROM quote_selection_snapshots WHERE id = $7::uuid`,
          [
            PI_ITEM1_ID,
            PI_ITEM2_ID,
            TEST_TENANT_ID,
            PI_ID,
            PI_SERIES_ID,
            SELECTION1_ID,
            SELECTION2_ID,
          ],
        );
        await client.query(
          `INSERT INTO sales_orders
             (id, tenant_id, customer_id, owner_user_id, order_number, pi_number,
              currency, total_amount, status, inquiry_id, source_pi_id)
           VALUES ($1,$2,$3,$4,'SO-STAGE-2C','PI-STAGE-2C','USD',1500,
                   'payment_gate_open',$5,$6)`,
          [SALES_ORDER_ID, TEST_TENANT_ID, CUSTOMER_ID, TEST_USER2_ID, INQUIRY_ID, PI_ID],
        );
        await client.query(
          `INSERT INTO sales_order_items
             (id, tenant_id, order_id, line_no, description, unit, quantity, unit_price, line_total)
           VALUES ($1,$3,$4,1,'Widget A','pcs',10,100,1000),
                  ($2,$3,$4,2,'Widget B','pcs',5,100,500)`,
          [SALES_ITEM1_ID, SALES_ITEM2_ID, TEST_TENANT_ID, SALES_ORDER_ID],
        );
        await client.query(
          `UPDATE proforma_invoices
              SET status = 'customer_confirmed', confirmed_by = $1,
                  confirmed_at = now(), sales_order_id = $2, updated_at = now()
            WHERE id = $3`,
          [TEST_USER2_ID, SALES_ORDER_ID, PI_ID],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    await insertGate('open');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);

    adminToken = await login(TEST_USER_EMAIL);
    salesToken = await login(TEST_USER2_EMAIL);
    approver2Token = await login(APPROVER2_EMAIL);
    approver3Token = await login(APPROVER3_EMAIL);
    tenant2Token = await login(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('requires all-scope access to read or change approval configuration', async () => {
    const denied = await request(app.getHttpServer())
      .get('/api/procurement/approval-config')
      .set(bearer(salesToken));
    expect(denied.status).toBe(403);

    const configured = await request(app.getHttpServer())
      .put('/api/procurement/approval-config')
      .set(bearer(adminToken))
      .send({
        price_variance_threshold_bps: 500,
        steps: [{ approver_user_id: APPROVER2_ID }, { approver_user_id: APPROVER3_ID }],
      });
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    expect(configured.body.version).toBe(1);
    expect(configured.body.steps.map((step: { step_no: number }) => step.step_no)).toEqual([1, 2]);
    requestConfigVersion = configured.body.version as number;
  });

  it('blocks request creation when the latest receipt gate is closed', async () => {
    await insertGate('blocked');
    const blocked = await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/procurement-requests`)
      .set(bearer(salesToken))
      .send({ items: [{ selection_id: SELECTION1_ID, quantity: '1' }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PROCUREMENT_GATE_CLOSED');
    await insertGate('open');
  });

  it('freezes the config and hides supplier identity from the salesperson projection', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/procurement-requests`)
      .set(bearer(salesToken))
      .send({
        note: 'Procure confirmed PI lines',
        items: [
          { selection_id: SELECTION1_ID, quantity: '10' },
          { selection_id: SELECTION2_ID, quantity: '5' },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending_approval');
    expect(created.body.approval_config.version).toBe(requestConfigVersion);
    expect(created.body.approval_steps).toHaveLength(2);
    expect(
      created.body.items.every((item: Record<string, unknown>) => !('supplier_id' in item)),
    ).toBe(true);
    requestId = created.body.id as string;

    const replacedConfig = await request(app.getHttpServer())
      .put('/api/procurement/approval-config')
      .set(bearer(adminToken))
      .send({
        price_variance_threshold_bps: 100,
        steps: [{ approver_user_id: APPROVER3_ID }],
      });
    expect(replacedConfig.status).toBe(200);
    expect(replacedConfig.body.version).toBe(2);

    const frozen = await request(app.getHttpServer())
      .get(`/api/procurement-requests/${requestId}`)
      .set(bearer(salesToken));
    expect(frozen.status).toBe(200);
    expect(frozen.body.approval_config.version).toBe(1);
    expect(frozen.body.approval_config.price_variance_threshold_bps).toBe(500);
    expect(frozen.body.approval_steps).toHaveLength(2);
  });

  it('enforces frozen approval order, tenant isolation, and incomplete-approval blocking', async () => {
    const wrongApprover = await request(app.getHttpServer())
      .post(`/api/procurement-requests/${requestId}/decisions`)
      .set(bearer(approver3Token))
      .send({ decision: 'approved' });
    expect(wrongApprover.status).toBe(403);
    expect(wrongApprover.body.code).toBe('PROCUREMENT_WRONG_APPROVER');

    const crossTenant = await request(app.getHttpServer())
      .get(`/api/procurement-requests/${requestId}`)
      .set(bearer(tenant2Token));
    expect(crossTenant.status).toBe(404);

    const first = await request(app.getHttpServer())
      .post(`/api/procurement-requests/${requestId}/decisions`)
      .set(bearer(approver2Token))
      .send({ decision: 'approved', reason: 'Budget checked' });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('pending_approval');
    expect(first.body.current_approval_step).toBe(2);
    expect(first.body.purchase_orders).toEqual([]);
  });

  it('appends the final decision and splits the approved request by supplier', async () => {
    const approved = await request(app.getHttpServer())
      .post(`/api/procurement-requests/${requestId}/decisions`)
      .set(bearer(approver3Token))
      .send({ decision: 'approved', reason: 'Sourcing checked' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.purchase_orders).toHaveLength(2);
    expect(
      new Set(
        approved.body.purchase_orders.map((order: { supplier_id: string }) => order.supplier_id),
      ),
    ).toEqual(new Set([SUPPLIER1_ID, SUPPLIER2_ID]));
    purchaseOrders = approved.body.purchase_orders;

    const links = await withAdmin(async (client) => {
      const result = await client.query(
        `SELECT sales_order_id, purchase_order_id, procurement_request_id
           FROM sales_order_purchase_orders
          WHERE procurement_request_id = $1
          ORDER BY purchase_order_id`,
        [requestId],
      );
      return result.rows;
    });
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.sales_order_id === SALES_ORDER_ID)).toBe(true);

    const salesView = await request(app.getHttpServer())
      .get(`/api/procurement-requests/${requestId}`)
      .set(bearer(salesToken));
    expect(salesView.status).toBe(200);
    expect(
      salesView.body.purchase_orders.every(
        (order: Record<string, unknown>) => !('supplier_id' in order),
      ),
    ).toBe(true);

    const legacyOrderView = await request(app.getHttpServer())
      .get(`/api/purchase-orders/${purchaseOrders[0].id}`)
      .set(bearer(salesToken));
    expect(legacyOrderView.status).toBe(200);
    expect(legacyOrderView.body.supplier_id).toBeUndefined();
    expect(legacyOrderView.body.source_procurement_request_id).toBe(requestId);

    const bypassUpdate = await request(app.getHttpServer())
      .patch(`/api/purchase-orders/${purchaseOrders[0].id}`)
      .set(bearer(salesToken))
      .send({ status: 'completed' });
    expect(bypassUpdate.status).toBe(409);
    expect(bypassUpdate.body.code).toBe('GENERATED_PURCHASE_ORDER_IMMUTABLE');
  });

  it('keeps approval decisions append-only at the database boundary', async () => {
    await expect(
      withAdmin(async (client) => {
        await client.query(
          `UPDATE procurement_request_decisions SET reason = 'overwritten' WHERE request_id = $1`,
          [requestId],
        );
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('serializes placement behind a concurrent gate close without side effects', async () => {
    const orderId = purchaseOrders.find((order) => order.supplier_id === SUPPLIER1_ID)!.id;
    const orderDetail = await request(app.getHttpServer())
      .get(`/api/purchase-orders/${orderId}`)
      .set(bearer(adminToken));
    expect(orderDetail.status).toBe(200);
    const itemId = orderDetail.body.items[0].id as string;
    const gateClient = new Client({ connectionString: process.env.DATABASE_URL });
    await gateClient.connect();
    let transactionOpen = false;
    let placementSettled = false;
    let placementPromise: Promise<request.Response> | undefined;
    try {
      await gateClient.query('BEGIN');
      transactionOpen = true;
      const backend = await gateClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await gateClient.query('SELECT id FROM sales_orders WHERE id = $1 FOR UPDATE', [
        SALES_ORDER_ID,
      ]);
      await gateClient.query(
        `INSERT INTO procurement_gate_evaluations
           (tenant_id, sales_order_id, proforma_invoice_id, status, order_amount,
            confirmed_amount, required_amount, currency, required_ratio_bps,
            proof_required, config_enabled, bypass_reason, blocking_reasons, evaluated_by)
         VALUES ($1,$2,$3,'blocked',1500,0,1500,'USD',10000,
                 true,true,NULL,$4,$5)`,
        [
          TEST_TENANT_ID,
          SALES_ORDER_ID,
          PI_ID,
          JSON.stringify(['insufficient_confirmed_receipts']),
          TEST_USER_ID,
        ],
      );

      placementPromise = request(app.getHttpServer())
        .post(`/api/purchase-orders/${orderId}/place`)
        .set(bearer(adminToken))
        .send({ items: [{ item_id: itemId, final_unit_price: '55.0000' }] })
        .then((response) => {
          placementSettled = true;
          return response;
        });
      await waitForBlockedPlacement(gateClient, backend.rows[0].pid);
      expect(placementSettled).toBe(false);
      await gateClient.query('COMMIT');
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) await gateClient.query('ROLLBACK');
      if (placementPromise) await placementPromise;
      throw error;
    } finally {
      await gateClient.end();
    }

    const blocked = await placementPromise!;
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PROCUREMENT_GATE_CLOSED');

    const evidence = await withAdmin(async (client) => {
      const order = await client.query(
        `SELECT status, final_total_amount::text, placed_by, placed_at
           FROM purchase_orders WHERE id = $1`,
        [orderId],
      );
      const items = await client.query(
        `SELECT final_unit_price, final_line_total, price_variance_amount,
                price_variance_bps, price_variance_status, price_finalized_by,
                price_finalized_at
           FROM purchase_order_items WHERE order_id = $1`,
        [orderId],
      );
      const snapshots = await client.query(
        `SELECT id FROM purchase_price_snapshots WHERE purchase_order_id = $1`,
        [orderId],
      );
      const exceptions = await client.query(
        `SELECT id FROM business_exceptions
          WHERE context_type = 'purchase_order' AND context_id = $1`,
        [orderId],
      );
      const audits = await client.query(
        `SELECT id FROM audit_logs
          WHERE tenant_id = $1 AND action = 'purchase_order.placed' AND resource_id = $2`,
        [TEST_TENANT_ID, orderId],
      );
      return {
        order: order.rows[0],
        items: items.rows,
        snapshots: snapshots.rows,
        exceptions: exceptions.rows,
        audits: audits.rows,
      };
    });
    expect(evidence.order).toEqual({
      status: 'approved',
      final_total_amount: null,
      placed_by: null,
      placed_at: null,
    });
    expect(
      evidence.items.every((item) => Object.values(item).every((value) => value === null)),
    ).toBe(true);
    expect(evidence.snapshots).toEqual([]);
    expect(evidence.exceptions).toEqual([]);
    expect(evidence.audits).toEqual([]);
  });

  it('rechecks the latest gate before placement and audits exact final-price variance', async () => {
    await insertGate('blocked');
    const orderId = purchaseOrders.find((order) => order.supplier_id === SUPPLIER1_ID)!.id;
    const orderDetail = await request(app.getHttpServer())
      .get(`/api/purchase-orders/${orderId}`)
      .set(bearer(adminToken));
    expect(orderDetail.status).toBe(200);
    const itemId = orderDetail.body.items[0].id as string;

    const blocked = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${orderId}/place`)
      .set(bearer(adminToken))
      .send({ items: [{ item_id: itemId, final_unit_price: '55.0000' }] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PROCUREMENT_GATE_CLOSED');

    await insertGate('open');
    const placed = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${orderId}/place`)
      .set(bearer(adminToken))
      .send({
        items: [{ item_id: itemId, final_unit_price: '55.0000', reason: 'Supplier repriced' }],
      });
    expect(placed.status).toBe(200);
    expect(placed.body.status).toBe('placed');
    expect(placed.body.items[0]).toMatchObject({
      expected_unit_price: '50.0000',
      final_unit_price: '55.0000',
      expected_line_total: '500.00',
      final_line_total: '550.00',
      price_variance_amount: '50.00',
      price_variance_bps: 1000,
      price_variance_status: 'exception',
      price_variance_threshold_bps: 500,
    });

    const evidence = await withAdmin(async (client) => {
      const snapshot = await client.query(
        `SELECT expected_unit_price::text, final_unit_price::text,
                variance_amount::text, variance_bps, variance_status
           FROM purchase_price_snapshots WHERE purchase_order_id = $1`,
        [orderId],
      );
      const exception = await client.query(
        `SELECT exception_type, status FROM business_exceptions
          WHERE context_type = 'purchase_order' AND context_id = $1`,
        [orderId],
      );
      const audit = await client.query(
        `SELECT action FROM audit_logs
          WHERE tenant_id = $1
            AND action IN (
              'business_exception.opened', 'purchase_price.exception', 'purchase_order.placed'
            )
          ORDER BY created_at`,
        [TEST_TENANT_ID],
      );
      return { snapshot: snapshot.rows[0], exception: exception.rows[0], audit: audit.rows };
    });
    expect(evidence.snapshot).toMatchObject({
      expected_unit_price: '50.0000',
      final_unit_price: '55.0000',
      variance_amount: '50.00',
      variance_bps: 1000,
      variance_status: 'exception',
    });
    expect(evidence.exception).toEqual({ exception_type: 'price_variance', status: 'open' });
    expect(evidence.audit.map((row: { action: string }) => row.action)).toContain(
      'purchase_order.placed',
    );
    expect(evidence.audit.map((row: { action: string }) => row.action)).toContain(
      'purchase_price.exception',
    );
    expect(evidence.audit.map((row: { action: string }) => row.action)).toContain(
      'business_exception.opened',
    );
    expect((await verifyChain(`tenant:${TEST_TENANT_ID}`)).ok).toBe(true);
  });
});
