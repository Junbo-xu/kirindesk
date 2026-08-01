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

const ids = {
  approver: 'f2000000-0000-4000-8000-000000000001',
  approverRole: 'f2000000-0000-4000-8000-000000000002',
  customer: 'f2000000-0000-4000-8000-000000000003',
  supplier: 'f2000000-0000-4000-8000-000000000004',
  inquiry: 'f2000000-0000-4000-8000-000000000005',
  inquiryItem: 'f2000000-0000-4000-8000-000000000006',
  quotation: 'f2000000-0000-4000-8000-000000000007',
  quotationLine: 'f2000000-0000-4000-8000-000000000008',
  selection: 'f2000000-0000-4000-8000-000000000009',
  gate: 'f2000000-0000-4000-8000-000000000010',
  procurementConfig: 'f2000000-0000-4000-8000-000000000011',
  procurementRequest: 'f2000000-0000-4000-8000-000000000012',
  procurementRequestItem: 'f2000000-0000-4000-8000-000000000013',
  purchaseOrder: 'f2000000-0000-4000-8000-000000000014',
  purchaseOrderItem: 'f2000000-0000-4000-8000-000000000015',
  purchasePrice: 'f2000000-0000-4000-8000-000000000016',
  receipt: 'f2000000-0000-4000-8000-000000000017',
  freight: 'f2000000-0000-4000-8000-000000000018',
  secondApprover: 'f2000000-0000-4000-8000-000000000019',
};

describe('Stage 2F samples and after-sales (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let salesToken: string;
  let tenant2Token: string;
  let approverToken: string;
  let secondApproverToken: string;
  let sampleId: string;
  let sampleItemId: string;
  let convertedOrderId: string;
  let convertedPiId: string;
  let convertedSelectionId: string;
  let convertedPiItemId: string;
  let convertedOrderItemId: string;

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function login(email: string, slug = TEST_TENANT_SLUG): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: slug });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
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
      const snapshot = {
        quotation_id: ids.quotation,
        quotation_version: 1,
        supplier_id: ids.supplier,
        currency: 'RMB',
        line: {
          id: ids.quotationLine,
          inquiry_item_id: ids.inquiryItem,
          quantity: '10.000',
          unit_price: '50.0000',
        },
        inquiry_item: {
          id: ids.inquiryItem,
          inquiry_id: ids.inquiry,
          description: 'Frozen sample widget',
          quantity: '10.000',
          unit: 'pcs',
        },
      };
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO users
             (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
           SELECT $1, tenant_id, 'stage-2f-approver@test.local', password_hash,
                  'Stage 2F Approver', 'active', false
             FROM users WHERE id = $2`,
          [ids.approver, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO users
             (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
           SELECT $1, tenant_id, 'stage-2f-second-approver@test.local', password_hash,
                  'Stage 2F Second Approver', 'active', false
             FROM users WHERE id = $2`,
          [ids.secondApprover, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO roles (id, tenant_id, name, is_system)
           VALUES ($1,$2,'Stage 2F Approver',true)`,
          [ids.approverRole, TEST_TENANT_ID],
        );
        await client.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id)
           VALUES ($1,$2,$3), ($1,$4,$3)`,
          [TEST_TENANT_ID, ids.approver, ids.approverRole, ids.secondApprover],
        );
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
           SELECT $1,$2,id,'all' FROM permissions
            WHERE code = ANY($3::text[])`,
          [TEST_TENANT_ID, ids.approverRole, ['after_sales:view', 'after_sales:approve']],
        );
        await client.query(
          `INSERT INTO customers (id, tenant_id, owner_user_id, company_name, country)
           VALUES ($1,$2,$3,'Stage 2F Customer','DE')`,
          [ids.customer, TEST_TENANT_ID, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO suppliers (id, tenant_id, owner_user_id, company_name, country)
           VALUES ($1,$2,$3,'Stage 2F Supplier','CN')`,
          [ids.supplier, TEST_TENANT_ID, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO inquiries
             (id, tenant_id, owner_user_id, customer_code, customer_country,
              customer_message, status, submitted_at, customer_id)
           VALUES ($1,$2,$3,'STAGE-2F','DE','Original frozen customer request',
                   'selected',now(),$4)`,
          [ids.inquiry, TEST_TENANT_ID, TEST_USER2_ID, ids.customer],
        );
        await client.query(
          `INSERT INTO inquiry_items
             (id, tenant_id, inquiry_id, line_no, description, specifications, quantity, unit)
           VALUES ($1,$2,$3,1,'Frozen sample widget','black finish',10,'pcs')`,
          [ids.inquiryItem, TEST_TENANT_ID, ids.inquiry],
        );
        await client.query(
          `INSERT INTO supplier_quotations
             (id, tenant_id, inquiry_id, supplier_id, entered_by, version,
              currency, valid_until, source_text)
           VALUES ($1,$2,$3,$4,$5,1,'RMB','2099-12-31','confidential source')`,
          [ids.quotation, TEST_TENANT_ID, ids.inquiry, ids.supplier, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO supplier_quotation_lines
             (id, tenant_id, inquiry_id, quotation_id, inquiry_item_id,
              quantity, unit_price, minimum_quantity, lead_time_days, terms)
           VALUES ($1,$2,$3,$4,$5,10,50,1,7,'cash')`,
          [ids.quotationLine, TEST_TENANT_ID, ids.inquiry, ids.quotation, ids.inquiryItem],
        );
        await client.query(
          `INSERT INTO quote_selection_snapshots
             (id, tenant_id, inquiry_id, inquiry_item_id, quotation_id,
              quotation_line_id, quotation_version, selected_by, snapshot_json,
              sales_currency, sales_unit_price, purchase_to_sales_fx_rate,
              fx_rate_source, fx_captured_at, purchase_unit_cost, gross_profit_unit,
              gross_margin_bps, margin_threshold_bps, margin_status,
              margin_formula_version)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,'RMB',100,1,
                   'currency_identity',now(),50,50,500,1500,
                   'below_threshold','gross_margin_bps_v1')`,
          [
            ids.selection,
            TEST_TENANT_ID,
            ids.inquiry,
            ids.inquiryItem,
            ids.quotation,
            ids.quotationLine,
            TEST_USER2_ID,
            JSON.stringify(snapshot),
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
    approverToken = await login('stage-2f-approver@test.local');
    secondApproverToken = await login('stage-2f-second-approver@test.local');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('persists the sample lifecycle, redacts own-scope data, and converts frozen facts', async () => {
    const missingMarginApproval = await request(app.getHttpServer())
      .post('/api/sample-orders')
      .set(bearer(salesToken))
      .send({
        inquiry_id: ids.inquiry,
        recipient_name: 'Buyer Contact',
        recipient_phone: '+49 30 123456',
        recipient_address: 'Customer warehouse, Berlin',
        recipient_country: 'DE',
        shipping_fee: '12.50',
        shipping_currency: 'RMB',
        note: 'First sample batch',
        items: [{ selection_id: ids.selection, quantity: '2.000' }],
      });
    expect(missingMarginApproval.status).toBe(409);
    expect(missingMarginApproval.body.code).toBe('SAMPLE_MARGIN_APPROVAL_REQUIRED');

    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO quote_selection_margin_approvals
           (tenant_id, selection_id, approved_by, reason)
         VALUES ($1,$2,$3,'Independent commercial margin approval')`,
        [TEST_TENANT_ID, ids.selection, ids.approver],
      );
    });

    const created = await request(app.getHttpServer())
      .post('/api/sample-orders')
      .set(bearer(salesToken))
      .send({
        inquiry_id: ids.inquiry,
        recipient_name: 'Buyer Contact',
        recipient_phone: '+49 30 123456',
        recipient_address: 'Customer warehouse, Berlin',
        recipient_country: 'DE',
        shipping_fee: '12.50',
        shipping_currency: 'RMB',
        note: 'First sample batch',
        items: [{ selection_id: ids.selection, quantity: '2.000' }],
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', owner_user_id: TEST_USER2_ID });
    expect(created.body.items[0]).not.toHaveProperty('supplier_id');
    expect(created.body.items[0]).not.toHaveProperty('purchase_unit_cost');
    expect(created.body.items[0]).not.toHaveProperty('source_snapshot');
    sampleId = created.body.id as string;
    sampleItemId = created.body.items[0].id as string;

    const adminView = await request(app.getHttpServer())
      .get(`/api/sample-orders/${sampleId}`)
      .set(bearer(adminToken));
    expect(adminView.status).toBe(200);
    expect(adminView.body.items[0]).toMatchObject({
      supplier_id: ids.supplier,
      purchase_unit_cost: '50.0000',
      source_selection_id: ids.selection,
    });
    expect(adminView.body.items[0].source_snapshot).toMatchObject({
      quotation_id: ids.quotation,
      quotation_version: 1,
      sample_margin_approval: {
        approved_by: ids.approver,
        reason: 'Independent commercial margin approval',
      },
    });

    const isolated = await request(app.getHttpServer())
      .get(`/api/sample-orders/${sampleId}`)
      .set(bearer(tenant2Token));
    expect(isolated.status).toBe(404);

    const overAllocated = await request(app.getHttpServer())
      .post('/api/sample-orders')
      .set(bearer(salesToken))
      .send({
        inquiry_id: ids.inquiry,
        recipient_name: 'Buyer Contact',
        recipient_phone: '+49 30 123456',
        recipient_address: 'Customer warehouse, Berlin',
        recipient_country: 'DE',
        shipping_fee: '0',
        shipping_currency: 'RMB',
        items: [{ selection_id: ids.selection, quantity: '9.000' }],
      });
    expect(overAllocated.status).toBe(409);
    expect(overAllocated.body.code).toBe('SAMPLE_QUANTITY_EXCEEDED');

    const submitted = await request(app.getHttpServer())
      .post(`/api/sample-orders/${sampleId}/submit`)
      .set(bearer(salesToken));
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('pending_approval');

    const approved = await request(app.getHttpServer())
      .post(`/api/sample-orders/${sampleId}/decision`)
      .set(bearer(adminToken))
      .send({ decision: 'approved', reason: 'Sample budget approved' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe('approved');

    const dispatched = await request(app.getHttpServer())
      .post(`/api/sample-orders/${sampleId}/dispatch`)
      .set(bearer(adminToken))
      .send({
        carrier: 'DHL',
        tracking_number: 'SAMPLE-TRACK-2F',
        dispatched_at: '2026-07-30T08:00:00.000Z',
      });
    expect(dispatched.status, JSON.stringify(dispatched.body)).toBe(200);
    expect(dispatched.body.status).toBe('dispatched');

    const delivered = await request(app.getHttpServer())
      .post(`/api/sample-orders/${sampleId}/deliver`)
      .set(bearer(adminToken))
      .send({ received_by: 'Buyer Contact', delivered_at: '2026-07-31T08:00:00.000Z' });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body.status).toBe('delivered');

    const confirmed = await request(app.getHttpServer())
      .post(`/api/sample-orders/${sampleId}/confirm`)
      .set(bearer(salesToken))
      .send({ feedback: 'Approved for production order' });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.status).toBe('confirmed');

    await withAdmin(async (client) => {
      await client.query(`UPDATE supplier_quotation_lines SET unit_price = 999 WHERE id = $1`, [
        ids.quotationLine,
      ]);
    });

    const converted = await request(app.getHttpServer())
      .post(`/api/sample-orders/${sampleId}/convert`)
      .set(bearer(salesToken))
      .send({
        payment_terms: 'Full payment before production',
        items: [{ sample_item_id: sampleItemId, quantity: '5.000' }],
      });
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect(converted.body.sample_order.status).toBe('converted');
    convertedOrderId = converted.body.sample_order.conversion.sales_order_id as string;
    convertedPiId = converted.body.sample_order.conversion.proforma_invoice_id as string;

    const duplicate = await request(app.getHttpServer())
      .post(`/api/sample-orders/${sampleId}/convert`)
      .set(bearer(salesToken))
      .send({
        payment_terms: 'Full payment before production',
        items: [{ sample_item_id: sampleItemId, quantity: '5.000' }],
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('SAMPLE_NOT_CONVERTIBLE');

    await withAdmin(async (client) => {
      const generated = await client.query<{
        selection_id: string;
        pi_item_id: string;
        order_item_id: string;
        selection_price: string;
        pi_price: string;
        quotation_price: string;
        margin_approved_by: string;
        margin_approval_reason: string;
        snapshot: Record<string, unknown>;
      }>(
        `SELECT pi_item.selection_id, pi_item.id AS pi_item_id,
                order_item.id AS order_item_id,
                selection.sales_unit_price::text AS selection_price,
                pi_item.unit_price::text AS pi_price,
                quotation_line.unit_price::text AS quotation_price,
                margin_approval.approved_by AS margin_approved_by,
                margin_approval.reason AS margin_approval_reason,
                selection.snapshot_json AS snapshot
           FROM proforma_invoice_items pi_item
           JOIN quote_selection_snapshots selection ON selection.id = pi_item.selection_id
           JOIN supplier_quotation_lines quotation_line ON quotation_line.id = $3
           JOIN quote_selection_margin_approvals margin_approval
             ON margin_approval.selection_id = selection.id
            AND margin_approval.tenant_id = selection.tenant_id
           JOIN sales_order_items order_item
             ON order_item.order_id = $2 AND order_item.line_no = pi_item.line_no
          WHERE pi_item.proforma_invoice_id = $1`,
        [convertedPiId, convertedOrderId, ids.quotationLine],
      );
      expect(generated.rows[0]).toMatchObject({
        selection_price: '100.0000',
        pi_price: '100.0000',
        quotation_price: '999.0000',
        margin_approved_by: ids.approver,
        margin_approval_reason: 'Independent commercial margin approval',
      });
      expect(generated.rows[0].selection_id).not.toBe(ids.selection);
      expect(generated.rows[0].snapshot).toMatchObject({
        quotation_version: 1,
        sample_conversion: { sample_order_id: sampleId },
      });
      convertedSelectionId = generated.rows[0].selection_id;
      convertedPiItemId = generated.rows[0].pi_item_id;
      convertedOrderItemId = generated.rows[0].order_item_id;
    });
  });

  it('aggregates a converted sample chain from either credential without sensitive fields', async () => {
    for (const [chainType, chainId] of [
      ['sample_order', sampleId],
      ['sales_order', convertedOrderId],
    ]) {
      const timeline = await request(app.getHttpServer())
        .get(`/api/business-events?chainType=${chainType}&chainId=${chainId}&pageSize=100`)
        .set(bearer(adminToken));
      expect(timeline.status, JSON.stringify(timeline.body)).toBe(200);
      expect(timeline.body.data.map((event: { eventType: string }) => event.eventType)).toEqual(
        expect.arrayContaining([
          'sample_order.created',
          'inquiry.created_from_sample',
          'sales_order.created_from_sample',
        ]),
      );
      const serialized = JSON.stringify(timeline.body);
      for (const forbidden of [
        'Original frozen customer request',
        'Customer warehouse, Berlin',
        'Full payment before production',
        'confidential source',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }

    const tenant2 = await request(app.getHttpServer())
      .get(`/api/business-events?chainType=sample_order&chainId=${sampleId}&pageSize=100`)
      .set(bearer(tenant2Token));
    expect(tenant2.status).toBe(200);
    expect(tenant2.body.data).toEqual([]);
  });

  it('enforces frozen multi-level approval and appends finance revisions without mutation', async () => {
    await withAdmin(async (client) => {
      const sourceSnapshot = {
        source_selection_id: convertedSelectionId,
        frozen_purchase_unit_cost: '50.0000',
      };
      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO procurement_gate_evaluations
             (id, tenant_id, sales_order_id, proforma_invoice_id, status,
              order_amount, confirmed_amount, required_amount, currency,
              required_ratio_bps, proof_required, config_enabled,
              blocking_reasons, evaluated_by)
           VALUES ($1,$2,$3,$4,'open',500,500,500,'RMB',10000,false,true,'[]',$5)`,
          [ids.gate, TEST_TENANT_ID, convertedOrderId, convertedPiId, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO procurement_approval_configs
             (id, tenant_id, version, is_active, price_variance_threshold_bps, created_by)
           VALUES ($1,$2,9200,false,500,$3)`,
          [ids.procurementConfig, TEST_TENANT_ID, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO procurement_requests
             (id, tenant_id, sales_order_id, request_number, requested_by,
              approval_config_id, approval_config_version, gate_evaluation_id,
              gate_status, price_variance_threshold_bps, status, completed_at)
           VALUES ($1,$2,$3,'PR-STAGE-2F',$4,$5,9200,$6,'open',500,'approved',now())`,
          [
            ids.procurementRequest,
            TEST_TENANT_ID,
            convertedOrderId,
            TEST_USER2_ID,
            ids.procurementConfig,
            ids.gate,
          ],
        );
        await client.query(
          `INSERT INTO procurement_request_items
             (id, tenant_id, request_id, sales_order_item_id, proforma_invoice_item_id,
              selection_id, supplier_id, line_no, description, quantity, unit,
              currency, expected_unit_price, expected_line_total, selection_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,'Frozen sample widget',5,'pcs',
                   'RMB',50,250,$8)`,
          [
            ids.procurementRequestItem,
            TEST_TENANT_ID,
            ids.procurementRequest,
            convertedOrderItemId,
            convertedPiItemId,
            convertedSelectionId,
            ids.supplier,
            JSON.stringify(sourceSnapshot),
          ],
        );
        await client.query(
          `INSERT INTO purchase_orders
             (id, tenant_id, supplier_id, owner_user_id, order_number, pi_number,
              currency, total_amount, status, source_procurement_request_id,
              expected_total_amount, final_total_amount, placed_by, placed_at)
           VALUES ($1,$2,$3,$4,'PO-STAGE-2F','PI-STAGE-2F','RMB',250,'placed',
                   $5,250,250,$4,now())`,
          [ids.purchaseOrder, TEST_TENANT_ID, ids.supplier, TEST_USER_ID, ids.procurementRequest],
        );
        await client.query(
          `INSERT INTO purchase_order_items
             (id, tenant_id, order_id, line_no, description, unit, quantity,
              unit_price, line_total, source_procurement_request_item_id,
              selection_id, expected_unit_price, final_unit_price,
              expected_line_total, final_line_total, price_variance_amount,
              price_variance_bps, price_variance_status,
              price_variance_threshold_bps, pricing_snapshot,
              price_finalized_by, price_finalized_at)
           VALUES ($1,$2,$3,1,'Frozen sample widget','pcs',5,50,250,$4,$5,
                   50,50,250,250,0,0,'within_tolerance',500,$6,$7,now())`,
          [
            ids.purchaseOrderItem,
            TEST_TENANT_ID,
            ids.purchaseOrder,
            ids.procurementRequestItem,
            convertedSelectionId,
            JSON.stringify(sourceSnapshot),
            TEST_USER_ID,
          ],
        );
        await client.query(
          `INSERT INTO sales_order_purchase_orders
             (tenant_id, sales_order_id, purchase_order_id, procurement_request_id)
           VALUES ($1,$2,$3,$4)`,
          [TEST_TENANT_ID, convertedOrderId, ids.purchaseOrder, ids.procurementRequest],
        );
        await client.query(
          `INSERT INTO purchase_price_snapshots
             (id, tenant_id, purchase_order_id, purchase_order_item_id,
              procurement_request_id, procurement_request_item_id,
              expected_unit_price, final_unit_price, quantity,
              expected_line_total, final_line_total, variance_amount,
              variance_bps, variance_threshold_bps, variance_status, finalized_by)
           VALUES ($1,$2,$3,$4,$5,$6,50,50,5,250,250,0,0,500,
                   'within_tolerance',$7)`,
          [
            ids.purchasePrice,
            TEST_TENANT_ID,
            ids.purchaseOrder,
            ids.purchaseOrderItem,
            ids.procurementRequest,
            ids.procurementRequestItem,
            TEST_USER_ID,
          ],
        );
        await client.query(
          `INSERT INTO customer_receipts
             (id, tenant_id, proforma_invoice_id, sales_order_id, amount,
              currency, received_at, method, external_reference, recorded_by)
           VALUES ($1,$2,$3,$4,500,'RMB',CURRENT_DATE,'bank_transfer',
                   'STAGE-2F-RECEIPT',$5)`,
          [ids.receipt, TEST_TENANT_ID, convertedPiId, convertedOrderId, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO customer_receipt_decisions
             (tenant_id, receipt_id, decision, decided_by)
           VALUES ($1,$2,'confirmed',$3)`,
          [TEST_TENANT_ID, ids.receipt, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO order_expenses
             (id, tenant_id, sales_order_id, expense_type, amount, currency,
              fx_rate_to_rmb, fx_source, fx_captured_at, amount_rmb, status,
              recorded_by, completed_by, completed_at)
           VALUES ($1,$2,$3,'freight',10,'RMB',1,'currency_identity',now(),10,
                   'complete',$4,$4,now())`,
          [ids.freight, TEST_TENANT_ID, convertedOrderId, TEST_USER_ID],
        );
        await client.query(
          `UPDATE sales_orders SET status = 'delivered', updated_at = now() WHERE id = $1`,
          [convertedOrderId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });

    const review = await request(app.getHttpServer())
      .post(`/api/finance/orders/${convertedOrderId}/reviews`)
      .set(bearer(adminToken))
      .send({ decision: 'verified', conversions: [] });
    expect(review.status, JSON.stringify(review.body)).toBe(201);
    expect(review.body).toMatchObject({ version: 1, decision: 'verified', missing_items: [] });

    const profit = await request(app.getHttpServer())
      .post(`/api/finance/orders/${convertedOrderId}/profit-snapshots`)
      .set(bearer(adminToken))
      .send({ status: 'final' });
    expect(profit.status, JSON.stringify(profit.body)).toBe(201);
    expect(profit.body).toMatchObject({
      version: 1,
      formula_version: 'order_profit_rmb_v1',
      refund_rmb: '0.00',
      net_profit_rmb: '240.00',
    });

    const rules = await request(app.getHttpServer())
      .put('/api/finance/commission-rules')
      .set(bearer(adminToken))
      .send({
        rules: [
          { role_type: 'sales', basis_type: 'net_profit', rate_bps: 1000 },
          { role_type: 'procurement', basis_type: 'net_profit', rate_bps: 500 },
        ],
      });
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);

    const candidate = await request(app.getHttpServer())
      .post(`/api/finance/orders/${convertedOrderId}/commission-candidates`)
      .set(bearer(adminToken))
      .send({
        allocations: [
          {
            role_type: 'sales',
            participants: [{ user_id: ids.approver, share_bps: 10000 }],
          },
          {
            role_type: 'procurement',
            participants: [{ user_id: ids.secondApprover, share_bps: 10000 }],
          },
        ],
      });
    expect(candidate.status, JSON.stringify(candidate.body)).toBe(201);
    expect(candidate.body).toMatchObject({ version: 1, total_commission_rmb: '36.00' });

    const locked = await request(app.getHttpServer())
      .post(`/api/finance/commission-candidates/${candidate.body.id}/lock`)
      .set(bearer(adminToken))
      .send({ comment: 'Original settled commission baseline' });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body.status).toBe('locked');

    const config = await request(app.getHttpServer())
      .put('/api/after-sales/approval-config')
      .set(bearer(adminToken))
      .send({
        steps: [{ approver_user_id: ids.approver }, { approver_user_id: ids.secondApprover }],
      });
    expect(config.status, JSON.stringify(config.body)).toBe(200);
    expect(config.body.steps).toHaveLength(2);

    const created = await request(app.getHttpServer())
      .post(`/api/sales-orders/${convertedOrderId}/after-sales-cases`)
      .set(bearer(salesToken))
      .send({
        case_type: 'refund',
        responsibility: 'supplier',
        reason: 'Customer accepted goods with a documented defect allowance',
        requested_amount: '20.00',
        currency: 'RMB',
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      status: 'draft',
      requested_by: TEST_USER2_ID,
      requested_amount: '20.00',
    });
    const caseId = created.body.id as string;

    const isolated = await request(app.getHttpServer())
      .get(`/api/after-sales-cases/${caseId}`)
      .set(bearer(tenant2Token));
    expect(isolated.status).toBe(404);

    const submitted = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/submit`)
      .set(bearer(salesToken));
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'pending_approval', current_approval_step: 1 });

    const skipped = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/decisions`)
      .set(bearer(secondApproverToken))
      .send({ decision: 'approved' });
    expect(skipped.status).toBe(403);
    expect(skipped.body.code).toBe('AFTER_SALES_WRONG_APPROVER');

    const firstDecision = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/decisions`)
      .set(bearer(approverToken))
      .send({ decision: 'approved' });
    expect(firstDecision.status, JSON.stringify(firstDecision.body)).toBe(200);
    expect(firstDecision.body).toMatchObject({
      status: 'pending_approval',
      current_approval_step: 2,
    });

    const prematureStart = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/start`)
      .set(bearer(adminToken));
    expect(prematureStart.status).toBe(409);
    expect(prematureStart.body.code).toBe('AFTER_SALES_CASE_NOT_APPROVED');

    const secondDecision = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/decisions`)
      .set(bearer(secondApproverToken))
      .send({ decision: 'approved' });
    expect(secondDecision.status, JSON.stringify(secondDecision.body)).toBe(200);
    expect(secondDecision.body.status).toBe('approved');

    const unauthorizedStart = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/start`)
      .set(bearer(salesToken));
    expect(unauthorizedStart.status).toBe(403);

    const started = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/start`)
      .set(bearer(adminToken));
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.status).toBe('executing');

    const amountMismatch = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/execute`)
      .set(bearer(adminToken))
      .send({
        amount: '19.99',
        fx_rate_to_rmb: '1',
        fx_source: 'currency_identity',
        fx_captured_at: '2026-08-01T00:00:00.000Z',
        external_reference: 'REFUND-STAGE-2F-001',
      });
    expect(amountMismatch.status).toBe(409);
    expect(amountMismatch.body.code).toBe('AFTER_SALES_AMOUNT_MISMATCH');

    const executed = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/execute`)
      .set(bearer(adminToken))
      .send({
        amount: '20.00',
        fx_rate_to_rmb: '1',
        fx_source: 'currency_identity',
        fx_captured_at: '2026-08-01T00:00:00.000Z',
        external_reference: 'REFUND-STAGE-2F-001',
      });
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    expect(executed.body.case.status).toBe('completed');
    expect(executed.body.revision.adjustment).toMatchObject({
      amount: '20.00',
      amount_rmb: '20.00',
      adjustment_type: 'refund',
    });
    expect(executed.body.revision.profit_snapshot).toMatchObject({
      version: 2,
      supersedes_id: profit.body.id,
      formula_version: 'order_profit_rmb_v2',
      refund_rmb: '20.00',
      net_profit_rmb: '220.00',
    });
    expect(executed.body.revision.commission_candidate).toMatchObject({
      version: 2,
      supersedes_id: candidate.body.id,
      status: 'calculated',
      total_commission_rmb: '33.00',
      is_current: true,
    });
    const revisedCandidateId = executed.body.revision.commission_candidate.id as string;

    const duplicateExecution = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/execute`)
      .set(bearer(adminToken))
      .send({
        amount: '20.00',
        fx_rate_to_rmb: '1',
        fx_source: 'currency_identity',
        fx_captured_at: '2026-08-01T00:00:00.000Z',
        external_reference: 'REFUND-STAGE-2F-001',
      });
    expect(duplicateExecution.status).toBe(409);
    expect(duplicateExecution.body.code).toBe('AFTER_SALES_CASE_NOT_EXECUTING');

    await withAdmin(async (client) => {
      const history = await client.query<{
        version: number;
        refund_rmb: string;
        net_profit_rmb: string;
      }>(
        `SELECT version, refund_rmb::text AS refund_rmb,
                net_profit_rmb::text AS net_profit_rmb
           FROM profit_snapshots WHERE sales_order_id = $1 ORDER BY version`,
        [convertedOrderId],
      );
      expect(history.rows).toEqual([
        { version: 1, refund_rmb: '0.00', net_profit_rmb: '240.00' },
        { version: 2, refund_rmb: '20.00', net_profit_rmb: '220.00' },
      ]);
      const commissionHistory = await client.query<{
        version: number;
        supersedes_id: string | null;
        lock_id: string | null;
      }>(
        `SELECT candidate.version, candidate.supersedes_id, lock.id AS lock_id
           FROM commission_candidates_v2 candidate
           LEFT JOIN commission_candidate_locks_v2 lock ON lock.candidate_id = candidate.id
          WHERE candidate.sales_order_id = $1 ORDER BY candidate.version`,
        [convertedOrderId],
      );
      expect(commissionHistory.rows).toEqual([
        { version: 1, supersedes_id: null, lock_id: expect.any(String) },
        { version: 2, supersedes_id: candidate.body.id, lock_id: null },
      ]);
    });

    const prematureClose = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/close`)
      .set(bearer(adminToken));
    expect(prematureClose.status).toBe(409);
    expect(prematureClose.body.code).toBe('AFTER_SALES_REVISED_COMMISSION_NOT_LOCKED');

    const revisedLock = await request(app.getHttpServer())
      .post(`/api/finance/commission-candidates/${revisedCandidateId}/lock`)
      .set(bearer(adminToken))
      .send({ comment: 'Locked after-sales commission revision' });
    expect(revisedLock.status, JSON.stringify(revisedLock.body)).toBe(200);
    expect(revisedLock.body).toMatchObject({ version: 2, status: 'locked', is_current: true });

    const closed = await request(app.getHttpServer())
      .post(`/api/after-sales-cases/${caseId}/close`)
      .set(bearer(adminToken));
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.status).toBe('closed');

    const chain = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(chain.ok, chain.failedAt?.reason).toBe(true);
  });
});
