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
  customer: 'a1000000-0000-4000-8000-000000000001',
  supplier: 'a1000000-0000-4000-8000-000000000002',
  inquiry: 'a1000000-0000-4000-8000-000000000003',
  inquiryItem: 'a1000000-0000-4000-8000-000000000004',
  selection: 'a1000000-0000-4000-8000-000000000005',
  quotation: 'a1000000-0000-4000-8000-000000000006',
  quotationLine: 'a1000000-0000-4000-8000-000000000007',
  pi: 'a1000000-0000-4000-8000-000000000008',
  piSeries: 'a1000000-0000-4000-8000-000000000009',
  piItem: 'a1000000-0000-4000-8000-000000000010',
  order: 'a1000000-0000-4000-8000-000000000011',
  orderItem: 'a1000000-0000-4000-8000-000000000012',
  gate: 'a1000000-0000-4000-8000-000000000013',
  config: 'a1000000-0000-4000-8000-000000000014',
  request: 'a1000000-0000-4000-8000-000000000015',
  requestItem: 'a1000000-0000-4000-8000-000000000016',
  purchaseOrder: 'a1000000-0000-4000-8000-000000000017',
  purchaseItem: 'a1000000-0000-4000-8000-000000000018',
  purchasePrice: 'a1000000-0000-4000-8000-000000000019',
  receipt: 'a1000000-0000-4000-8000-000000000020',
  freight: 'a1000000-0000-4000-8000-000000000021',
  insurance: 'a1000000-0000-4000-8000-000000000022',
  salesParticipant: 'a1000000-0000-4000-8000-000000000023',
  procurementParticipant: 'a1000000-0000-4000-8000-000000000024',
};

const financeConversions = [
  {
    subject_type: 'customer_receipt',
    subject_id: ids.receipt,
    fx_rate_to_rmb: '7.12345678',
    fx_source: 'PBOC_TEST',
    fx_captured_at: '2026-07-30T08:00:00.000Z',
  },
  {
    subject_type: 'purchase_cost',
    subject_id: ids.purchasePrice,
    fx_rate_to_rmb: '7',
    fx_source: 'PBOC_TEST',
    fx_captured_at: '2026-07-30T08:00:00.000Z',
  },
];

describe('Stage 2E finance, profit, and commission (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let salesToken: string;
  let tenant2Token: string;
  let returnedReviewId: string;
  let finalProfitId: string;
  let firstCandidateId: string;
  let secondCandidateId: string;

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
      const selectionSnapshot = {
        quotation_id: ids.quotation,
        quotation_version: 1,
        supplier_id: ids.supplier,
        currency: 'USD',
        valid_until: '2099-12-31',
        line: {
          id: ids.quotationLine,
          inquiry_item_id: ids.inquiryItem,
          quantity: '10.000',
          unit_price: '50.0000',
        },
        inquiry_item: {
          id: ids.inquiryItem,
          inquiry_id: ids.inquiry,
          description: 'Stage 2E Widget',
          quantity: '10.000',
          unit: 'pcs',
        },
      };

      await client.query('BEGIN');
      try {
        await client.query(
          `INSERT INTO users
             (id, tenant_id, email, password_hash, name, status, is_tenant_owner)
           SELECT $1::uuid, tenant_id, 'stage-2e-sales@test.local', password_hash,
                  'Stage 2E Sales', 'active', false
             FROM users WHERE id = $3
           UNION ALL
           SELECT $2::uuid, tenant_id, 'stage-2e-procurement@test.local', password_hash,
                  'Stage 2E Procurement', 'active', false
             FROM users WHERE id = $3`,
          [ids.salesParticipant, ids.procurementParticipant, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO customers
             (id, tenant_id, owner_user_id, company_name, country)
           VALUES ($1,$2,$3,'Stage 2E Customer','US')`,
          [ids.customer, TEST_TENANT_ID, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO suppliers
             (id, tenant_id, owner_user_id, company_name, country)
           VALUES ($1,$2,$3,'Stage 2E Supplier','CN')`,
          [ids.supplier, TEST_TENANT_ID, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO inquiries
             (id, tenant_id, owner_user_id, customer_code, customer_country,
              customer_message, status, submitted_at, customer_id)
           VALUES ($1,$2,$3,'STAGE-2E','US','Stage 2E fixture','selected',now(),$4)`,
          [ids.inquiry, TEST_TENANT_ID, TEST_USER2_ID, ids.customer],
        );
        await client.query(
          `INSERT INTO inquiry_items
             (id, tenant_id, inquiry_id, line_no, description, quantity, unit)
           VALUES ($1,$2,$3,1,'Stage 2E Widget',10,'pcs')`,
          [ids.inquiryItem, TEST_TENANT_ID, ids.inquiry],
        );
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
            ids.selection,
            TEST_TENANT_ID,
            ids.inquiry,
            ids.inquiryItem,
            ids.quotation,
            ids.quotationLine,
            TEST_USER2_ID,
            JSON.stringify(selectionSnapshot),
          ],
        );
        await client.query(
          `INSERT INTO proforma_invoices
             (id, tenant_id, series_id, inquiry_id, customer_id, pi_number, version,
              currency, payment_terms, status, total_amount, created_by, issued_by, issued_at)
           VALUES ($1,$2,$3,$4,$5,'PI-STAGE-2E',1,'USD','Full payment',
                   'issued',1000,$6,$6,now())`,
          [ids.pi, TEST_TENANT_ID, ids.piSeries, ids.inquiry, ids.customer, TEST_USER2_ID],
        );
        await client.query(
          `INSERT INTO proforma_invoice_series_selections (tenant_id, series_id, selection_id)
           VALUES ($1,$2,$3)`,
          [TEST_TENANT_ID, ids.piSeries, ids.selection],
        );
        await client.query(
          `INSERT INTO proforma_invoice_items
             (id, tenant_id, proforma_invoice_id, series_id, selection_id, line_no,
              description, quantity, unit, unit_price, line_total, selection_snapshot)
           VALUES ($1,$2,$3,$4,$5,1,'Stage 2E Widget',10,'pcs',100,1000,$6)`,
          [
            ids.piItem,
            TEST_TENANT_ID,
            ids.pi,
            ids.piSeries,
            ids.selection,
            JSON.stringify(selectionSnapshot),
          ],
        );
        await client.query(
          `INSERT INTO sales_orders
             (id, tenant_id, customer_id, owner_user_id, order_number, pi_number,
              currency, total_amount, status, inquiry_id, source_pi_id)
           VALUES ($1,$2,$3,$4,'SO-STAGE-2E','PI-STAGE-2E','USD',1000,'delivered',$5,$6)`,
          [ids.order, TEST_TENANT_ID, ids.customer, TEST_USER2_ID, ids.inquiry, ids.pi],
        );
        await client.query(
          `INSERT INTO sales_order_items
             (id, tenant_id, order_id, line_no, description, unit, quantity, unit_price, line_total)
           VALUES ($1,$2,$3,1,'Stage 2E Widget','pcs',10,100,1000)`,
          [ids.orderItem, TEST_TENANT_ID, ids.order],
        );
        await client.query(
          `UPDATE proforma_invoices
              SET status = 'customer_confirmed', confirmed_by = $1,
                  confirmed_at = now(), sales_order_id = $2, updated_at = now()
            WHERE id = $3`,
          [TEST_USER2_ID, ids.order, ids.pi],
        );
        await client.query(
          `INSERT INTO procurement_gate_evaluations
             (id, tenant_id, sales_order_id, proforma_invoice_id, status, order_amount,
              confirmed_amount, required_amount, currency, required_ratio_bps,
              proof_required, config_enabled, blocking_reasons, evaluated_by)
           VALUES ($1,$2,$3,$4,'open',1000,1000,1000,'USD',10000,false,true,'[]',$5)`,
          [ids.gate, TEST_TENANT_ID, ids.order, ids.pi, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO procurement_approval_configs
             (id, tenant_id, version, is_active, price_variance_threshold_bps, created_by)
           VALUES ($1,$2,9100,false,500,$3)`,
          [ids.config, TEST_TENANT_ID, TEST_USER_ID],
        );
        await client.query(
          `INSERT INTO procurement_requests
             (id, tenant_id, sales_order_id, request_number, requested_by,
              approval_config_id, approval_config_version, gate_evaluation_id, gate_status,
              price_variance_threshold_bps, status, completed_at)
           VALUES ($1,$2,$3,'PR-STAGE-2E',$4,$5,9100,$6,'open',500,'approved',now())`,
          [ids.request, TEST_TENANT_ID, ids.order, TEST_USER2_ID, ids.config, ids.gate],
        );
        await client.query(
          `INSERT INTO procurement_request_items
             (id, tenant_id, request_id, sales_order_item_id, proforma_invoice_item_id,
              selection_id, supplier_id, line_no, description, quantity, unit, currency,
              expected_unit_price, expected_line_total, selection_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,1,'Stage 2E Widget',10,'pcs','USD',50,500,$8)`,
          [
            ids.requestItem,
            TEST_TENANT_ID,
            ids.request,
            ids.orderItem,
            ids.piItem,
            ids.selection,
            ids.supplier,
            JSON.stringify(selectionSnapshot),
          ],
        );
        await client.query(
          `INSERT INTO purchase_orders
             (id, tenant_id, supplier_id, owner_user_id, order_number, pi_number, currency,
              total_amount, status, source_procurement_request_id, expected_total_amount,
              final_total_amount, placed_by, placed_at)
           VALUES ($1,$2,$3,$4,'PO-STAGE-2E','PI-STAGE-2E','USD',500,'placed',$5,500,500,$4,now())`,
          [ids.purchaseOrder, TEST_TENANT_ID, ids.supplier, TEST_USER_ID, ids.request],
        );
        await client.query(
          `INSERT INTO purchase_order_items
             (id, tenant_id, order_id, line_no, description, unit, quantity, unit_price,
              line_total, source_procurement_request_item_id, selection_id,
              expected_unit_price, final_unit_price, expected_line_total, final_line_total,
              price_variance_amount, price_variance_bps, price_variance_status,
              price_variance_threshold_bps, pricing_snapshot, price_finalized_by, price_finalized_at)
           VALUES ($1,$2,$3,1,'Stage 2E Widget','pcs',10,50,500,$4,$5,
                   50,50,500,500,0,0,'within_tolerance',500,$6,$7,now())`,
          [
            ids.purchaseItem,
            TEST_TENANT_ID,
            ids.purchaseOrder,
            ids.requestItem,
            ids.selection,
            JSON.stringify(selectionSnapshot),
            TEST_USER_ID,
          ],
        );
        await client.query(
          `INSERT INTO sales_order_purchase_orders
             (tenant_id, sales_order_id, purchase_order_id, procurement_request_id)
           VALUES ($1,$2,$3,$4)`,
          [TEST_TENANT_ID, ids.order, ids.purchaseOrder, ids.request],
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
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('enforces permissions and cross-tenant isolation', async () => {
    const forbidden = await request(app.getHttpServer())
      .get('/api/finance/orders')
      .set(bearer(salesToken));
    expect(forbidden.status).toBe(403);

    const isolated = await request(app.getHttpServer())
      .get(`/api/finance/orders/${ids.order}`)
      .set(bearer(tenant2Token));
    expect(isolated.status).toBe(404);
  });

  it('rejects incomplete finalization and appends return evidence', async () => {
    const incomplete = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/reviews`)
      .set(bearer(adminToken))
      .send({ decision: 'verified', conversions: [] });
    expect(incomplete.status).toBe(409);
    expect(incomplete.body).toMatchObject({ code: 'FINANCE_INPUTS_INCOMPLETE' });
    expect(incomplete.body.missing_items).toEqual(
      expect.arrayContaining(['missing_receipt', 'missing_cost', 'missing_freight']),
    );

    const returned = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/reviews`)
      .set(bearer(adminToken))
      .send({ decision: 'returned', reason: '收款、成本和运费资料不完整', conversions: [] });
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect(returned.body).toMatchObject({ version: 1, decision: 'returned' });
    expect(returned.body.items).toHaveLength(3);
    returnedReviewId = returned.body.id;

    const provisional = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/profit-snapshots`)
      .set(bearer(adminToken))
      .send({ status: 'provisional' });
    expect(provisional.status, JSON.stringify(provisional.body)).toBe(201);
    expect(provisional.body).toMatchObject({
      version: 1,
      status: 'provisional',
      revenue_rmb: '0.00',
    });

    const finalBlocked = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/profit-snapshots`)
      .set(bearer(adminToken))
      .send({ status: 'final' });
    expect(finalBlocked.status).toBe(409);
    expect(finalBlocked.body.code).toBe('CURRENT_FINANCE_VERIFICATION_REQUIRED');
  });

  it('freezes exact RMB profit inputs and supports two commission rules', async () => {
    await withAdmin(async (client) => {
      await client.query(
        `INSERT INTO customer_receipts
           (id, tenant_id, proforma_invoice_id, sales_order_id, amount, currency,
            received_at, method, external_reference, recorded_by)
         VALUES ($1,$2,$3,$4,1000,'USD',CURRENT_DATE,'bank_transfer','STAGE-2E-RECEIPT',$5)`,
        [ids.receipt, TEST_TENANT_ID, ids.pi, ids.order, TEST_USER2_ID],
      );
      await client.query(
        `INSERT INTO customer_receipt_decisions
           (tenant_id, receipt_id, decision, decided_by)
         VALUES ($1,$2,'confirmed',$3)`,
        [TEST_TENANT_ID, ids.receipt, TEST_USER_ID],
      );
      await client.query(
        `INSERT INTO purchase_price_snapshots
           (id, tenant_id, purchase_order_id, purchase_order_item_id,
            procurement_request_id, procurement_request_item_id,
            expected_unit_price, final_unit_price, quantity, expected_line_total,
            final_line_total, variance_amount, variance_bps, variance_threshold_bps,
            variance_status, finalized_by)
         VALUES ($1,$2,$3,$4,$5,$6,50,50,10,500,500,0,0,500,'within_tolerance',$7)`,
        [
          ids.purchasePrice,
          TEST_TENANT_ID,
          ids.purchaseOrder,
          ids.purchaseItem,
          ids.request,
          ids.requestItem,
          TEST_USER_ID,
        ],
      );
      await client.query(
        `INSERT INTO order_expenses
           (id, tenant_id, sales_order_id, expense_type, amount, currency,
            fx_rate_to_rmb, fx_source, fx_captured_at, amount_rmb, status,
            recorded_by, completed_by, completed_at)
         VALUES ($1,$3,$4,'freight',100,'RMB',1,'currency_identity',now(),100,'complete',$5,$5,now()),
                ($2,$3,$4,'insurance',10.01,'RMB',1,'currency_identity',now(),10.01,'complete',$5,$5,now())`,
        [ids.freight, ids.insurance, TEST_TENANT_ID, ids.order, TEST_USER_ID],
      );
    });

    const verified = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/reviews`)
      .set(bearer(adminToken))
      .send({
        decision: 'verified',
        conversions: financeConversions,
      });
    expect(verified.status, JSON.stringify(verified.body)).toBe(201);
    expect(verified.body).toMatchObject({ version: 2, decision: 'verified', missing_items: [] });
    expect(verified.body.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const finalProfit = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/profit-snapshots`)
      .set(bearer(adminToken))
      .send({ status: 'final' });
    expect(finalProfit.status, JSON.stringify(finalProfit.body)).toBe(201);
    expect(finalProfit.body).toMatchObject({
      version: 2,
      status: 'final',
      revenue_rmb: '7123.46',
      purchase_cost_rmb: '3500.00',
      freight_rmb: '100.00',
      other_expense_rmb: '10.01',
      gross_profit_rmb: '3623.46',
      net_profit_rmb: '3513.45',
      formula_version: 'order_profit_rmb_v1',
    });
    expect(finalProfit.body.input_snapshot.review_items).toHaveLength(4);
    finalProfitId = finalProfit.body.id;

    const rules = await request(app.getHttpServer())
      .put('/api/finance/commission-rules')
      .set(bearer(adminToken))
      .send({
        rules: [
          { role_type: 'sales', basis_type: 'gross_profit', rate_bps: 1000 },
          { role_type: 'procurement', basis_type: 'net_profit', rate_bps: 500 },
        ],
      });
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    expect(rules.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role_type: 'sales', basis_type: 'gross_profit', version: 1 }),
        expect.objectContaining({ role_type: 'procurement', basis_type: 'net_profit', version: 1 }),
      ]),
    );

    const candidate = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/commission-candidates`)
      .set(bearer(adminToken))
      .send({
        allocations: [
          {
            role_type: 'sales',
            participants: [
              { user_id: ids.salesParticipant, share_bps: 6000 },
              { user_id: ids.procurementParticipant, share_bps: 4000 },
            ],
          },
          {
            role_type: 'procurement',
            participants: [{ user_id: ids.procurementParticipant, share_bps: 10000 }],
          },
        ],
      });
    expect(candidate.status, JSON.stringify(candidate.body)).toBe(201);
    expect(candidate.body).toMatchObject({
      version: 1,
      status: 'calculated',
      profit_snapshot_id: finalProfitId,
      total_commission_rmb: '538.02',
    });
    expect(candidate.body.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role_type: 'sales',
          user_id: ids.salesParticipant,
          share_bps: 6000,
          commission_amount_rmb: '217.41',
        }),
        expect.objectContaining({
          role_type: 'sales',
          user_id: ids.procurementParticipant,
          share_bps: 4000,
          commission_amount_rmb: '144.94',
        }),
        expect.objectContaining({
          role_type: 'procurement',
          user_id: ids.procurementParticipant,
          commission_amount_rmb: '175.67',
        }),
      ]),
    );
    firstCandidateId = candidate.body.id;
  });

  it('requires lock-before-revision and preserves every historical version', async () => {
    const unlockedRevision = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/commission-candidates`)
      .set(bearer(adminToken))
      .send({
        revision_reason: 'Should fail before lock',
        allocations: [
          {
            role_type: 'sales',
            participants: [{ user_id: ids.salesParticipant, share_bps: 10000 }],
          },
          {
            role_type: 'procurement',
            participants: [{ user_id: ids.procurementParticipant, share_bps: 10000 }],
          },
        ],
      });
    expect(unlockedRevision.status).toBe(409);
    expect(unlockedRevision.body.code).toBe('UNLOCKED_COMMISSION_CANDIDATE_EXISTS');

    const locked = await request(app.getHttpServer())
      .post(`/api/finance/commission-candidates/${firstCandidateId}/lock`)
      .set(bearer(adminToken))
      .send({ comment: '2026-07 commission lock' });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body).toMatchObject({ status: 'locked', version: 1 });

    const missingReason = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/commission-candidates`)
      .set(bearer(adminToken))
      .send({
        allocations: [
          {
            role_type: 'sales',
            participants: [{ user_id: ids.salesParticipant, share_bps: 10000 }],
          },
          {
            role_type: 'procurement',
            participants: [{ user_id: ids.procurementParticipant, share_bps: 10000 }],
          },
        ],
      });
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.code).toBe('COMMISSION_REVISION_REASON_REQUIRED');

    const revised = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/commission-candidates`)
      .set(bearer(adminToken))
      .send({
        revision_reason: '按最终责任人重新分配销售提成',
        allocations: [
          {
            role_type: 'sales',
            participants: [{ user_id: ids.salesParticipant, share_bps: 10000 }],
          },
          {
            role_type: 'procurement',
            participants: [{ user_id: ids.procurementParticipant, share_bps: 10000 }],
          },
        ],
      });
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    expect(revised.body).toMatchObject({
      version: 2,
      supersedes_id: firstCandidateId,
      status: 'calculated',
      revision_reason: '按最终责任人重新分配销售提成',
    });
    secondCandidateId = revised.body.id;

    await expect(
      withAdmin(async (client) => {
        await client.query(`UPDATE finance_reviews SET reason = 'overwritten' WHERE id = $1`, [
          returnedReviewId,
        ]);
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      withAdmin(async (client) => {
        await client.query(`UPDATE profit_snapshots SET net_profit_rmb = 0 WHERE id = $1`, [
          finalProfitId,
        ]);
      }),
    ).rejects.toThrow(/append-only/);

    const order = await request(app.getHttpServer())
      .get(`/api/finance/orders/${ids.order}`)
      .set(bearer(adminToken));
    expect(order.status, JSON.stringify(order.body)).toBe(200);
    expect(order.body.finance_reviews.map((row: { version: number }) => row.version)).toEqual([
      2, 1,
    ]);
    expect(order.body.profit_snapshots.map((row: { version: number }) => row.version)).toEqual([
      2, 1,
    ]);
    expect(order.body.commission_candidates.map((row: { version: number }) => row.version)).toEqual(
      [2, 1],
    );

    const returnedAfterCalculation = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/reviews`)
      .set(bearer(adminToken))
      .send({
        decision: 'returned',
        reason: '重新核对发现原始凭证需要补充',
        conversions: [],
      });
    expect(returnedAfterCalculation.status, JSON.stringify(returnedAfterCalculation.body)).toBe(
      201,
    );
    expect(returnedAfterCalculation.body).toMatchObject({ version: 3, decision: 'returned' });

    const staleLock = await request(app.getHttpServer())
      .post(`/api/finance/commission-candidates/${secondCandidateId}/lock`)
      .set(bearer(adminToken))
      .send({ comment: 'Must not lock after finance returned the order' });
    expect(staleLock.status).toBe(409);
    expect(staleLock.body.code).toBe('CURRENT_FINANCE_VERIFICATION_REQUIRED');

    const staleCalculation = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/commission-candidates`)
      .set(bearer(adminToken))
      .send({
        revision_reason: 'Must not recalculate after finance returned the order',
        allocations: [
          {
            role_type: 'sales',
            participants: [{ user_id: ids.salesParticipant, share_bps: 10000 }],
          },
          {
            role_type: 'procurement',
            participants: [{ user_id: ids.procurementParticipant, share_bps: 10000 }],
          },
        ],
      });
    expect(staleCalculation.status).toBe(409);
    expect(staleCalculation.body.code).toBe('CURRENT_FINANCE_VERIFICATION_REQUIRED');

    const reverified = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/reviews`)
      .set(bearer(adminToken))
      .send({ decision: 'verified', conversions: financeConversions });
    expect(reverified.status, JSON.stringify(reverified.body)).toBe(201);
    expect(reverified.body).toMatchObject({ version: 4, decision: 'verified' });

    const replacementProfit = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/profit-snapshots`)
      .set(bearer(adminToken))
      .send({ status: 'final' });
    expect(replacementProfit.status, JSON.stringify(replacementProfit.body)).toBe(201);
    expect(replacementProfit.body).toMatchObject({
      version: 3,
      status: 'final',
      supersedes_id: finalProfitId,
      finance_review_id: reverified.body.id,
      net_profit_rmb: '3513.45',
    });

    const staleReplacementMissingReason = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/commission-candidates`)
      .set(bearer(adminToken))
      .send({
        allocations: [
          {
            role_type: 'sales',
            participants: [{ user_id: ids.salesParticipant, share_bps: 10000 }],
          },
          {
            role_type: 'procurement',
            participants: [{ user_id: ids.procurementParticipant, share_bps: 10000 }],
          },
        ],
      });
    expect(staleReplacementMissingReason.status).toBe(400);
    expect(staleReplacementMissingReason.body.code).toBe('COMMISSION_REVISION_REASON_REQUIRED');

    const obsoleteProfitLock = await request(app.getHttpServer())
      .post(`/api/finance/commission-candidates/${secondCandidateId}/lock`)
      .set(bearer(adminToken))
      .send({ comment: 'Must not lock a candidate connected to an obsolete profit' });
    expect(obsoleteProfitLock.status).toBe(409);
    expect(obsoleteProfitLock.body.code).toBe('COMMISSION_CANDIDATE_STALE');

    const replacementCandidate = await request(app.getHttpServer())
      .post(`/api/finance/orders/${ids.order}/commission-candidates`)
      .set(bearer(adminToken))
      .send({
        revision_reason: 'Replace candidate invalidated by finance re-verification',
        allocations: [
          {
            role_type: 'sales',
            participants: [{ user_id: ids.salesParticipant, share_bps: 10000 }],
          },
          {
            role_type: 'procurement',
            participants: [{ user_id: ids.procurementParticipant, share_bps: 10000 }],
          },
        ],
      });
    expect(replacementCandidate.status, JSON.stringify(replacementCandidate.body)).toBe(201);
    expect(replacementCandidate.body).toMatchObject({
      version: 3,
      supersedes_id: secondCandidateId,
      profit_snapshot_id: replacementProfit.body.id,
      status: 'calculated',
      is_current: true,
    });

    const replacementLock = await request(app.getHttpServer())
      .post(`/api/finance/commission-candidates/${replacementCandidate.body.id}/lock`)
      .set(bearer(adminToken))
      .send({ comment: 'Lock recovered current candidate' });
    expect(replacementLock.status, JSON.stringify(replacementLock.body)).toBe(200);
    expect(replacementLock.body).toMatchObject({ version: 3, status: 'locked' });

    const chain = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(chain.ok, chain.failedAt?.reason).toBe(true);
  });
});
