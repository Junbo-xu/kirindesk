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
  TEST_USER4_EMAIL,
  TEST_USER4_ID,
  TEST_USER_EMAIL,
  TEST_USER_ID,
} from './fixtures';

const CUSTOMER_ID = '91000000-0000-4000-8000-000000000001';
const SUPPLIER_ID = '92000000-0000-4000-8000-000000000001';
const INQUIRY_ID = '93000000-0000-4000-8000-000000000001';
const INQUIRY_ITEM_ID = '94000000-0000-4000-8000-000000000001';
const SELECTION_ID = '95000000-0000-4000-8000-000000000001';
const PI_ID = '96000000-0000-4000-8000-000000000001';
const PI_SERIES_ID = '96100000-0000-4000-8000-000000000001';
const PI_ITEM_ID = '96200000-0000-4000-8000-000000000001';
const SALES_ORDER_ID = '97000000-0000-4000-8000-000000000001';
const SALES_ITEM_ID = '97100000-0000-4000-8000-000000000001';
const GATE_ID = '97200000-0000-4000-8000-000000000001';
const CONFIG_ID = '97300000-0000-4000-8000-000000000001';
const REQUEST_ID = '97400000-0000-4000-8000-000000000001';
const REQUEST_ITEM_ID = '97500000-0000-4000-8000-000000000001';
const PURCHASE_ORDER_ID = '98000000-0000-4000-8000-000000000001';
const PURCHASE_ITEM_ID = '98100000-0000-4000-8000-000000000001';
const QC_FILE_ID = '99000000-0000-4000-8000-000000000001';
const DELIVERY_FILE_ID = '99000000-0000-4000-8000-000000000002';
const CUSTOMER_RECEIPT_ID = '99000000-0000-4000-8000-000000000003';
const NONE_SCOPE_ROLE_ID = '99100000-0000-4000-8000-000000000001';

describe('Stage 2D fulfillment (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let salesToken: string;
  let tenant2Token: string;
  let noneScopeToken: string;
  let firstReceiptId: string;
  let firstReceiptItemId: string;
  let shipmentId: string;
  let pendingExpenseId: string;

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
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await callback(client);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO customers
             (id, tenant_id, owner_user_id, company_name, country)
           VALUES ($1,$2,$3,'Stage 2D Customer','US')`,
          [CUSTOMER_ID, TEST_TENANT_ID, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO suppliers
             (id, tenant_id, owner_user_id, company_name, country)
           VALUES ($1,$2,$3,'Stage 2D Supplier','CN')`,
          [SUPPLIER_ID, TEST_TENANT_ID, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO inquiries
             (id, tenant_id, owner_user_id, customer_code, customer_country,
              customer_message, status, submitted_at, customer_id)
           VALUES ($1,$2,$3,'STAGE-2D','US','Stage 2D fixture','selected',now(),$4)`,
          [INQUIRY_ID, TEST_TENANT_ID, TEST_USER2_ID, CUSTOMER_ID],
        );
        await client.query(
          `INSERT INTO inquiry_items
             (id, tenant_id, inquiry_id, line_no, description, quantity, unit)
           VALUES ($1,$2,$3,1,'Fulfillment Widget',10,'pcs')`,
          [INQUIRY_ITEM_ID, TEST_TENANT_ID, INQUIRY_ID],
        );
        const snapshot = {
          quotation_id: '95100000-0000-4000-8000-000000000001',
          quotation_version: 1,
          supplier_id: SUPPLIER_ID,
          currency: 'USD',
          valid_until: '2099-12-31',
          line: {
            id: '95200000-0000-4000-8000-000000000001',
            inquiry_item_id: INQUIRY_ITEM_ID,
            quantity: '10.000',
            unit_price: '50.0000',
          },
          inquiry_item: {
            id: INQUIRY_ITEM_ID,
            inquiry_id: INQUIRY_ID,
            description: 'Fulfillment Widget',
            quantity: '10.000',
            unit: 'pcs',
          },
        };
        await client.query(
          `INSERT INTO quote_selection_snapshots
             (id, tenant_id, inquiry_id, inquiry_item_id, quotation_id,
              quotation_line_id, quotation_version, selected_by, snapshot_json,
              sales_currency, sales_unit_price, purchase_to_sales_fx_rate,
              fx_rate_source, fx_captured_at, purchase_unit_cost, gross_profit_unit,
              gross_margin_bps, margin_threshold_bps, margin_status, margin_formula_version)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,'USD',100,1,'system',now(),50,50,5000,1500,
                   'meets_threshold','gross_margin_bps_v1')`,
          [
            SELECTION_ID,
            TEST_TENANT_ID,
            INQUIRY_ID,
            INQUIRY_ITEM_ID,
            snapshot.quotation_id,
            snapshot.line.id,
            TEST_USER2_ID,
            JSON.stringify(snapshot),
          ],
        );
        await client.query(
          `INSERT INTO proforma_invoices
             (id, tenant_id, series_id, inquiry_id, customer_id, pi_number, version,
              currency, payment_terms, status, total_amount, created_by, issued_by, issued_at)
           VALUES ($1,$2,$3,$4,$5,'PI-STAGE-2D',1,'USD','Balance before shipment',
                   'issued',1000,$6,$6,now())`,
          [PI_ID, TEST_TENANT_ID, PI_SERIES_ID, INQUIRY_ID, CUSTOMER_ID, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO proforma_invoice_series_selections (tenant_id, series_id, selection_id)
           VALUES ($1,$2,$3)`,
          [TEST_TENANT_ID, PI_SERIES_ID, SELECTION_ID],
        );
        await client.query(
          `INSERT INTO proforma_invoice_items
             (id, tenant_id, proforma_invoice_id, series_id, selection_id, line_no,
              description, quantity, unit, unit_price, line_total, selection_snapshot)
           VALUES ($1,$2,$3,$4,$5,1,'Fulfillment Widget',10,'pcs',100,1000,$6)`,
          [PI_ITEM_ID, TEST_TENANT_ID, PI_ID, PI_SERIES_ID, SELECTION_ID, JSON.stringify(snapshot)],
        );
        await client.query(
          `INSERT INTO sales_orders
             (id, tenant_id, customer_id, owner_user_id, order_number, pi_number,
              currency, total_amount, status, inquiry_id, source_pi_id)
           VALUES ($1,$2,$3,$4,'SO-STAGE-2D','PI-STAGE-2D','USD',1000,'procurement',$5,$6)`,
          [SALES_ORDER_ID, TEST_TENANT_ID, CUSTOMER_ID, TEST_USER2_ID, INQUIRY_ID, PI_ID],
        );
        await client.query(
          `INSERT INTO sales_order_items
             (id, tenant_id, order_id, line_no, description, unit, quantity, unit_price, line_total)
           VALUES ($1,$2,$3,1,'Fulfillment Widget','pcs',10,100,1000)`,
          [SALES_ITEM_ID, TEST_TENANT_ID, SALES_ORDER_ID],
        );
        await client.query(
          `UPDATE proforma_invoices
              SET status = 'customer_confirmed', confirmed_by = $1,
                  confirmed_at = now(), sales_order_id = $2, updated_at = now()
            WHERE id = $3`,
          [TEST_USER2_ID, SALES_ORDER_ID, PI_ID],
        );
        await client.query(
          `INSERT INTO procurement_gate_evaluations
             (id, tenant_id, sales_order_id, proforma_invoice_id, status, order_amount,
              confirmed_amount, required_amount, currency, required_ratio_bps,
              proof_required, config_enabled, blocking_reasons, evaluated_by)
           VALUES ($1,$2,$3,$4,'open',1000,1000,1000,'USD',10000,false,true,'[]',$5)`,
          [GATE_ID, TEST_TENANT_ID, SALES_ORDER_ID, PI_ID, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO procurement_approval_configs
             (id, tenant_id, version, is_active, price_variance_threshold_bps, created_by)
           VALUES ($1,$2,9001,false,500,$3)`,
          [CONFIG_ID, TEST_TENANT_ID, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO procurement_requests
             (id, tenant_id, sales_order_id, request_number, requested_by,
              approval_config_id, approval_config_version, gate_evaluation_id, gate_status,
              price_variance_threshold_bps, status, completed_at)
           VALUES ($1,$2,$3,'PR-STAGE-2D',$4,$5,9001,$6,'open',500,'approved',now())`,
          [REQUEST_ID, TEST_TENANT_ID, SALES_ORDER_ID, TEST_USER2_ID, CONFIG_ID, GATE_ID],
        );
        await client.query(
          `INSERT INTO procurement_request_items
             (id, tenant_id, request_id, sales_order_item_id, proforma_invoice_item_id,
              selection_id, supplier_id, line_no, description, quantity, unit, currency,
              expected_unit_price, expected_line_total, selection_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,'Fulfillment Widget',10,'pcs','USD',50,500,$8)`,
          [
            REQUEST_ITEM_ID,
            TEST_TENANT_ID,
            REQUEST_ID,
            SALES_ITEM_ID,
            PI_ITEM_ID,
            SELECTION_ID,
            SUPPLIER_ID,
            JSON.stringify(snapshot),
          ],
        );
        await client.query(
          `INSERT INTO purchase_orders
             (id, tenant_id, supplier_id, owner_user_id, order_number, pi_number, currency,
              total_amount, status, source_procurement_request_id, expected_total_amount,
              final_total_amount, placed_by, placed_at)
           VALUES ($1,$2,$3,$4,'PO-STAGE-2D','PI-STAGE-2D','USD',500,'placed',$5,500,500,$4,now())`,
          [PURCHASE_ORDER_ID, TEST_TENANT_ID, SUPPLIER_ID, TEST_USER_ID, REQUEST_ID],
        );
        await client.query(
          `INSERT INTO purchase_order_items
             (id, tenant_id, order_id, line_no, description, unit, quantity, unit_price,
              line_total, source_procurement_request_item_id, selection_id,
              expected_unit_price, final_unit_price, expected_line_total, final_line_total,
              price_variance_amount, price_variance_bps, price_variance_status,
              price_variance_threshold_bps, pricing_snapshot, price_finalized_by, price_finalized_at)
           VALUES ($1,$2,$3,1,'Fulfillment Widget','pcs',10,50,500,$4,$5,
                   50,50,500,500,0,0,'within_tolerance',500,$6,$7,now())`,
          [
            PURCHASE_ITEM_ID,
            TEST_TENANT_ID,
            PURCHASE_ORDER_ID,
            REQUEST_ITEM_ID,
            SELECTION_ID,
            JSON.stringify(snapshot),
            TEST_USER_ID,
          ],
        );
        await client.query(
          `INSERT INTO sales_order_purchase_orders
             (tenant_id, sales_order_id, purchase_order_id, procurement_request_id)
           VALUES ($1,$2,$3,$4)`,
          [TEST_TENANT_ID, SALES_ORDER_ID, PURCHASE_ORDER_ID, REQUEST_ID],
        );
        await client.query(
          `INSERT INTO files
             (id, tenant_id, uploaded_by, original_name, storage_key, mime_type,
              size_bytes, sha256, purpose)
           VALUES ($1,$3,$4,'qc.jpg','stage2d/qc.jpg','image/jpeg',4,$5,'qc_photo'),
                  ($2,$3,$4,'delivery.pdf','stage2d/delivery.pdf','application/pdf',4,$6,'delivery_proof')`,
          [
            QC_FILE_ID,
            DELIVERY_FILE_ID,
            TEST_TENANT_ID,
            TEST_USER2_ID,
            '1'.repeat(64),
            '2'.repeat(64),
          ],
        );
        await client.query(
          `INSERT INTO customer_receipts
             (id, tenant_id, proforma_invoice_id, sales_order_id, amount, currency,
              received_at, method, external_reference, recorded_by)
           VALUES ($1,$2,$3,$4,500,'USD',CURRENT_DATE,'bank_transfer','STAGE-2D-PAYMENT',$5)`,
          [CUSTOMER_RECEIPT_ID, TEST_TENANT_ID, PI_ID, SALES_ORDER_ID, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO roles (id, tenant_id, name, is_system)
           VALUES ($1,$2,'Fulfillment none-scope regression',false)`,
          [NONE_SCOPE_ROLE_ID, TEST_TENANT_ID],
        );
        await client.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id)
           VALUES ($1,$2,$3)`,
          [TEST_TENANT_ID, TEST_USER4_ID, NONE_SCOPE_ROLE_ID],
        );
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
           SELECT $1,$2,id,'none' FROM permissions
            WHERE code=ANY($3::text[])`,
          [
            TEST_TENANT_ID,
            NONE_SCOPE_ROLE_ID,
            [
              'fulfillment:view',
              'goods_receipts:manage',
              'goods_receipts:confirm',
              'shipments:manage',
              'order_expenses:record',
            ],
          ],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);
    adminToken = await login(TEST_USER_EMAIL);
    salesToken = await login(TEST_USER2_EMAIL);
    tenant2Token = await login(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);
    noneScopeToken = await login(TEST_USER4_EMAIL);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('enforces tenant scope and freezes the dual-confirmation setting per receipt', async () => {
    const isolated = await request(app.getHttpServer())
      .get(`/api/sales-orders/${SALES_ORDER_ID}/fulfillment`)
      .set(bearer(tenant2Token));
    expect(isolated.status).toBe(404);

    const configured = await request(app.getHttpServer())
      .put('/api/fulfillment/settings')
      .set(bearer(adminToken))
      .send({ require_sales_receipt_confirmation: true });
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);

    const denied = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${PURCHASE_ORDER_ID}/goods-receipts`)
      .set(bearer(salesToken))
      .send({
        batch_number: 'GR-1',
        is_final_batch: false,
        items: [{ purchase_order_item_id: PURCHASE_ITEM_ID, received_quantity: '5' }],
      });
    expect(denied.status).toBe(403);

    const created = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${PURCHASE_ORDER_ID}/goods-receipts`)
      .set(bearer(adminToken))
      .send({
        batch_number: 'GR-1',
        is_final_batch: false,
        file_ids: [QC_FILE_ID],
        items: [{ purchase_order_item_id: PURCHASE_ITEM_ID, received_quantity: '5' }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.sales_confirmation_required).toBe(true);
    firstReceiptId = created.body.id;
    firstReceiptItemId = created.body.items[0].id;

    const inspected = await request(app.getHttpServer())
      .post(`/api/goods-receipts/${firstReceiptId}/inspect`)
      .set(bearer(adminToken))
      .send({
        items: [{ item_id: firstReceiptItemId, accepted_quantity: '4', rejected_quantity: '1' }],
      });
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    expect(inspected.body).toMatchObject({ status: 'inspected', qc_result: 'partial' });

    const confirmed = await request(app.getHttpServer())
      .post(`/api/goods-receipts/${firstReceiptId}/confirm`)
      .set(bearer(salesToken))
      .send({ decision: 'accepted' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.status).toBe('accepted');
    expect(confirmed.body.confirmations).toHaveLength(2);

    const evidence = await withAdmin(async (client) => {
      const exception = await client.query(
        `SELECT exception_type, status FROM business_exceptions
          WHERE context_id = $1 AND exception_type = 'quality_variance'`,
        [PURCHASE_ORDER_ID],
      );
      return exception.rows[0];
    });
    expect(evidence).toEqual({ exception_type: 'quality_variance', status: 'open' });
  });

  it('fails closed for none-scoped fulfillment permissions without mutating data', async () => {
    const before = await withAdmin(async (client) => {
      const result = await client.query<{ receipts: number; shipments: number; expenses: number }>(
        `SELECT
           (SELECT count(*)::integer FROM goods_receipts WHERE sales_order_id=$1) AS receipts,
           (SELECT count(*)::integer FROM shipments WHERE sales_order_id=$1) AS shipments,
           (SELECT count(*)::integer FROM order_expenses WHERE sales_order_id=$1) AS expenses`,
        [SALES_ORDER_ID],
      );
      return result.rows[0];
    });

    await request(app.getHttpServer())
      .get(`/api/sales-orders/${SALES_ORDER_ID}/fulfillment`)
      .set(bearer(noneScopeToken))
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${PURCHASE_ORDER_ID}/goods-receipts`)
      .set(bearer(noneScopeToken))
      .send({
        batch_number: 'GR-NONE-SCOPE',
        is_final_batch: false,
        items: [{ purchase_order_item_id: PURCHASE_ITEM_ID, received_quantity: '1' }],
      })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/goods-receipts/${firstReceiptId}/confirm`)
      .set(bearer(noneScopeToken))
      .send({ decision: 'accepted' })
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/shipments`)
      .set(bearer(noneScopeToken))
      .send({
        idempotency_key: 'shipment:none-scope',
        batch_number: 'SHIP-NONE-SCOPE',
        carrier: 'DHL',
        tracking_number: 'DHL-NONE-SCOPE',
        items: [{ sales_order_item_id: SALES_ITEM_ID, quantity: '1' }],
      })
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/expenses`)
      .set(bearer(noneScopeToken))
      .send({ expense_type: 'freight', amount: '1', currency: 'RMB' })
      .expect(404);

    const after = await withAdmin(async (client) => {
      const result = await client.query<{ receipts: number; shipments: number; expenses: number }>(
        `SELECT
           (SELECT count(*)::integer FROM goods_receipts WHERE sales_order_id=$1) AS receipts,
           (SELECT count(*)::integer FROM shipments WHERE sales_order_id=$1) AS shipments,
           (SELECT count(*)::integer FROM order_expenses WHERE sales_order_id=$1) AS expenses`,
        [SALES_ORDER_ID],
      );
      return result.rows[0];
    });
    expect(after).toEqual(before);
  });

  it('persists final and over-receipt batches with quantity exceptions and auto confirmation', async () => {
    const second = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${PURCHASE_ORDER_ID}/goods-receipts`)
      .set(bearer(adminToken))
      .send({
        batch_number: 'GR-2',
        is_final_batch: true,
        items: [{ purchase_order_item_id: PURCHASE_ITEM_ID, received_quantity: '5' }],
      });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondInspected = await request(app.getHttpServer())
      .post(`/api/goods-receipts/${second.body.id}/inspect`)
      .set(bearer(adminToken))
      .send({
        items: [
          { item_id: second.body.items[0].id, accepted_quantity: '5', rejected_quantity: '0' },
        ],
      });
    expect(secondInspected.body.status).toBe('inspected');
    await request(app.getHttpServer())
      .post(`/api/goods-receipts/${second.body.id}/confirm`)
      .set(bearer(salesToken))
      .send({ decision: 'accepted' })
      .expect(200);

    await request(app.getHttpServer())
      .put('/api/fulfillment/settings')
      .set(bearer(adminToken))
      .send({ require_sales_receipt_confirmation: false })
      .expect(200);
    const over = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${PURCHASE_ORDER_ID}/goods-receipts`)
      .set(bearer(adminToken))
      .send({
        batch_number: 'GR-3',
        is_final_batch: false,
        items: [{ purchase_order_item_id: PURCHASE_ITEM_ID, received_quantity: '1' }],
      });
    expect(over.status, JSON.stringify(over.body)).toBe(201);
    expect(over.body.items[0].quantity_variance).toBe('1.000');
    const overInspected = await request(app.getHttpServer())
      .post(`/api/goods-receipts/${over.body.id}/inspect`)
      .set(bearer(adminToken))
      .send({
        items: [{ item_id: over.body.items[0].id, accepted_quantity: '1', rejected_quantity: '0' }],
      });
    expect(overInspected.status, JSON.stringify(overInspected.body)).toBe(200);
    expect(overInspected.body).toMatchObject({ status: 'accepted', qc_result: 'passed' });
    expect(overInspected.body.confirmations).toHaveLength(1);

    const state = await withAdmin(async (client) => {
      const purchaseOrder = await client.query(`SELECT status FROM purchase_orders WHERE id = $1`, [
        PURCHASE_ORDER_ID,
      ]);
      const exception = await client.query(
        `SELECT count(*)::integer AS count FROM business_exceptions
          WHERE context_id = $1 AND exception_type = 'quantity_variance'`,
        [PURCHASE_ORDER_ID],
      );
      return { purchaseStatus: purchaseOrder.rows[0].status, count: exception.rows[0].count };
    });
    expect(state).toEqual({ purchaseStatus: 'received', count: 1 });
  });

  it('blocks over-shipment and freezes precise expense FX snapshots', async () => {
    const exceeded = await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/shipments`)
      .set(bearer(salesToken))
      .send({
        idempotency_key: 'shipment:stage2d:over',
        batch_number: 'SHIP-OVER',
        carrier: 'DHL',
        tracking_number: 'DHL-OVER',
        items: [{ sales_order_item_id: SALES_ITEM_ID, quantity: '11' }],
      });
    expect(exceeded.status).toBe(409);
    expect(exceeded.body.code).toBe('SHIPMENT_QUANTITY_EXCEEDED');

    const shipment = await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/shipments`)
      .set(bearer(salesToken))
      .send({
        idempotency_key: 'shipment:stage2d:one',
        batch_number: 'SHIP-1',
        carrier: 'DHL',
        tracking_number: 'DHL-001',
        items: [{ sales_order_item_id: SALES_ITEM_ID, quantity: '5' }],
      });
    expect(shipment.status, JSON.stringify(shipment.body)).toBe(201);
    shipmentId = shipment.body.id;

    const expense = await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/expenses`)
      .set(bearer(salesToken))
      .send({
        shipment_id: shipmentId,
        expense_type: 'freight',
        amount: '10.0050',
        currency: 'USD',
      });
    expect(expense.status, JSON.stringify(expense.body)).toBe(201);
    expect(expense.body).toMatchObject({ status: 'pending_fx', amount_rmb: null });
    pendingExpenseId = expense.body.id;

    const completed = await request(app.getHttpServer())
      .post(`/api/order-expenses/${pendingExpenseId}/complete-fx`)
      .set(bearer(salesToken))
      .send({
        fx_rate_to_rmb: '7.12345678',
        fx_source: 'bank-advice-2026-07-31',
        fx_captured_at: '2026-07-31T08:00:00.000Z',
      });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body).toMatchObject({
      status: 'complete',
      amount: '10.0050',
      currency: 'USD',
      fx_rate_to_rmb: '7.12345678',
      fx_source: 'bank-advice-2026-07-31',
      amount_rmb: '71.27',
    });
    const immutable = await request(app.getHttpServer())
      .post(`/api/order-expenses/${pendingExpenseId}/complete-fx`)
      .set(bearer(salesToken))
      .send({
        fx_rate_to_rmb: '8',
        fx_source: 'retry',
        fx_captured_at: '2026-07-31T09:00:00.000Z',
      });
    expect(immutable.status).toBe(409);
    expect(immutable.body.code).toBe('EXPENSE_FX_ALREADY_FROZEN');
  });

  it('tracks, delivers and links payment milestones without coupling receipt state', async () => {
    const dispatched = await request(app.getHttpServer())
      .post(`/api/shipments/${shipmentId}/dispatch`)
      .set(bearer(salesToken));
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(dispatched.body.status).toBe('dispatched');

    const inTransit = await request(app.getHttpServer())
      .post(`/api/shipments/${shipmentId}/logistics-events`)
      .set(bearer(salesToken))
      .send({
        idempotency_key: 'shipment:stage2d:transit-one',
        event_type: 'in_transit',
        location: 'Shenzhen',
        description: 'Export scan',
        occurred_at: new Date(Date.now() + 1000).toISOString(),
      });
    expect(inTransit.status, JSON.stringify(inTransit.body)).toBe(201);

    const linked = await request(app.getHttpServer())
      .post(`/api/shipments/${shipmentId}/customer-receipts`)
      .set(bearer(salesToken))
      .send({ customer_receipt_id: CUSTOMER_RECEIPT_ID });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(linked.body.status).toBe('recorded');

    const delivered = await request(app.getHttpServer())
      .post(`/api/shipments/${shipmentId}/deliver`)
      .set(bearer(salesToken))
      .send({
        delivered_at: new Date(Date.now() + 2000).toISOString(),
        received_by: 'Buyer Contact One',
        attachment_file_ids: [DELIVERY_FILE_ID],
        note: 'Customer signed batch one',
      });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.status).toBe('delivered');

    const finalShipment = await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/shipments`)
      .set(bearer(salesToken))
      .send({
        idempotency_key: 'shipment:stage2d:two',
        batch_number: 'SHIP-2',
        carrier: 'FedEx',
        tracking_number: 'FEDEX-002',
        items: [{ sales_order_item_id: SALES_ITEM_ID, quantity: '5' }],
      });
    expect(finalShipment.status, JSON.stringify(finalShipment.body)).toBe(201);
    const rmbExpense = await request(app.getHttpServer())
      .post(`/api/sales-orders/${SALES_ORDER_ID}/expenses`)
      .set(bearer(salesToken))
      .send({
        shipment_id: finalShipment.body.id,
        expense_type: 'insurance',
        amount: '12.3456',
        currency: 'RMB',
      });
    expect(rmbExpense.status, JSON.stringify(rmbExpense.body)).toBe(201);
    expect(rmbExpense.body).toMatchObject({
      fx_rate_to_rmb: '1.00000000',
      fx_source: 'currency_identity',
      amount_rmb: '12.35',
      status: 'complete',
    });
    await request(app.getHttpServer())
      .post(`/api/shipments/${finalShipment.body.id}/dispatch`)
      .set(bearer(salesToken))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/shipments/${finalShipment.body.id}/logistics-events`)
      .set(bearer(salesToken))
      .send({
        idempotency_key: 'shipment:stage2d:transit-two',
        event_type: 'in_transit',
        occurred_at: new Date(Date.now() + 2500).toISOString(),
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/shipments/${finalShipment.body.id}/deliver`)
      .set(bearer(salesToken))
      .send({
        delivered_at: new Date(Date.now() + 3000).toISOString(),
        received_by: 'Buyer Contact Final',
        attachment_file_ids: [DELIVERY_FILE_ID],
        note: 'Customer signed final batch',
      })
      .expect(200);

    const view = await request(app.getHttpServer())
      .get(`/api/sales-orders/${SALES_ORDER_ID}/fulfillment`)
      .set(bearer(salesToken));
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.aggregate_status).toBe('delivered');
    expect(view.body.items[0]).toMatchObject({
      quantity: '10.000',
      accepted_quantity: '10.000',
      shipped_quantity: '10.000',
      delivered_quantity: '10.000',
      available_quantity: '0.000',
    });
    expect(JSON.stringify(view.body)).not.toContain('supplier_id');
    expect(view.body.shipments[0].receipts[0].status).toBe('recorded');

    const evidence = await withAdmin(async (client) => {
      const receipt = await client.query(
        `SELECT COALESCE(decision.decision, 'recorded') AS status
           FROM customer_receipts receipt
           LEFT JOIN customer_receipt_decisions decision ON decision.receipt_id = receipt.id
          WHERE receipt.id = $1`,
        [CUSTOMER_RECEIPT_ID],
      );
      const exceptions = await client.query(
        `SELECT exception_type, count(*)::integer AS count
           FROM business_exceptions
          WHERE context_id IN ($1,$2,$3)
          GROUP BY exception_type ORDER BY exception_type`,
        [PURCHASE_ORDER_ID, SALES_ORDER_ID, shipmentId],
      );
      return { receiptStatus: receipt.rows[0].status, exceptions: exceptions.rows };
    });
    expect(evidence.receiptStatus).toBe('recorded');
    expect(evidence.exceptions).toEqual(
      expect.arrayContaining([
        { exception_type: 'missing_expense', count: 1 },
        { exception_type: 'quality_variance', count: 1 },
        { exception_type: 'quantity_variance', count: 1 },
      ]),
    );
    expect((await verifyChain(`tenant:${TEST_TENANT_ID}`)).ok).toBe(true);
  });
});
