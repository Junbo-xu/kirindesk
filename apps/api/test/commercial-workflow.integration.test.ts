import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { closePool } from '@kirindesk/database';
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
  TEST_USER_EMAIL,
  TEST_USER_ID,
} from './fixtures';

describe('Stage 2B commercial workflow (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let salesToken: string;
  let adminToken: string;
  let tenant2Token: string;
  let noPermissionToken: string;
  let inquiryId: string;
  let selectionId: string;
  let piV1Id: string;
  let piV2Id: string;
  let orderId: string;
  let proofFileId: string;

  const { Client } = pg;

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

  async function startApplication(): Promise<{ app: INestApplication; pool: Pool }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const startedApp = moduleRef.createNestApplication();
    startedApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await startedApp.init();
    return { app: startedApp, pool: startedApp.get<Pool>(APP_POOL) };
  }

  async function createLeadInquiry(customerCode: string): Promise<string> {
    const inquiry = await request(app.getHttpServer())
      .post('/api/inquiries')
      .set(bearer(salesToken))
      .send({
        customer_code: customerCode,
        customer_country: 'US',
        customer_message: 'Synthetic duplicate-customer concurrency test',
        items: [
          {
            description: 'Test item',
            quantity: '1.000',
            unit: 'pcs',
          },
        ],
      });
    expect(inquiry.status).toBe(201);
    return inquiry.body.id as string;
  }

  async function waitForAdvisoryWaiters(client: pg.Client, expected: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count
           FROM pg_locks
          WHERE locktype = 'advisory' AND granted = false`,
      );
      if (result.rows[0].count >= expected) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Expected ${expected} advisory-lock waiters`);
  }

  async function withHeldDuplicateLock<T>(lockKey: string, action: () => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    let transactionOpen = false;
    let actionPromise: Promise<T> | null = null;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [lockKey]);
      actionPromise = action();
      await waitForAdvisoryWaiters(client, 1);
      await client.query('COMMIT');
      transactionOpen = false;
      return await actionPromise;
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK');
      if (actionPromise) await Promise.allSettled([actionPromise]);
      throw error;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    ({ app, pool } = await startApplication());
    salesToken = await login(TEST_USER2_EMAIL);
    adminToken = await login(TEST_USER_EMAIL);
    tenant2Token = await login(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);
    noPermissionToken = await login(TEST_USER4_EMAIL);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('configures exact margin and payment thresholds with a fail-closed bypass reason', async () => {
    const defaults = await request(app.getHttpServer())
      .get('/api/commercial-settings')
      .set(bearer(adminToken));
    expect(defaults.status).toBe(200);
    expect(defaults.body.minimum_margin_bps).toBe(1500);

    const missingReason = await request(app.getHttpServer())
      .put('/api/commercial-settings')
      .set(bearer(adminToken))
      .send({
        minimum_margin_bps: 2000,
        procurement_gate_enabled: false,
        required_receipt_ratio_bps: 5000,
        receipt_proof_required: true,
      });
    expect(missingReason.status).toBe(400);
    expect(missingReason.body.code).toBe('PROCUREMENT_GATE_BYPASS_REASON_REQUIRED');

    const configured = await request(app.getHttpServer())
      .put('/api/commercial-settings')
      .set(bearer(adminToken))
      .send({
        minimum_margin_bps: 2000,
        procurement_gate_enabled: true,
        required_receipt_ratio_bps: 5000,
        receipt_proof_required: true,
      });
    expect(configured.status).toBe(200);
    expect(configured.body).toEqual({
      minimum_margin_bps: 2000,
      procurement_gate_enabled: true,
      required_receipt_ratio_bps: 5000,
      receipt_proof_required: true,
      bypass_reason: null,
    });
  });

  it('blocks a duplicate lead upgrade and recovers by linking the existing customer', async () => {
    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(salesToken))
      .send({
        company_name: 'Stage 2B Customer',
        email: 'stage-2b-customer@example.test',
        country: 'US',
      });
    expect(customer.status).toBe(201);

    const inquiry = await request(app.getHttpServer())
      .post('/api/inquiries')
      .set(bearer(salesToken))
      .send({
        customer_code: 'STAGE-2B-LEAD',
        customer_country: 'US',
        customer_message: 'Synthetic stage 2B customer request',
        items: [
          {
            description: 'Precision valve',
            specifications: '316L',
            quantity: '3.333',
            unit: 'pcs',
            target_price_usd: '1.5000',
          },
        ],
      });
    expect(inquiry.status).toBe(201);
    inquiryId = inquiry.body.id;

    const duplicate = await request(app.getHttpServer())
      .post(`/api/inquiries/${inquiryId}/customer-upgrade`)
      .set(bearer(salesToken))
      .send({
        company_name: '  stage 2b customer ',
        email: 'STAGE-2B-CUSTOMER@example.test',
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_CUSTOMER');
    expect(duplicate.body.candidates[0].id).toBe(customer.body.id);

    const linked = await request(app.getHttpServer())
      .put(`/api/inquiries/${inquiryId}/customer-link`)
      .set(bearer(salesToken))
      .send({ customer_id: customer.body.id });
    expect(linked.status).toBe(200);
    expect(linked.body.id).toBe(customer.body.id);
  });

  it('blocks cross-owner tenant duplicates without leaking candidate data and lets an administrator recover', async () => {
    const suffix = Date.now();
    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({
        company_name: `Cross Owner Customer ${suffix}`,
        email: `cross-owner-${suffix}@example.test`,
        country: 'US',
      });
    expect(customer.status).toBe(201);
    const crossOwnerInquiryId = await createLeadInquiry(`CROSS-OWNER-${suffix}`);

    const duplicate = await request(app.getHttpServer())
      .post(`/api/inquiries/${crossOwnerInquiryId}/customer-upgrade`)
      .set(bearer(salesToken))
      .send({
        company_name: ` cross owner customer ${suffix} `,
        email: `CROSS-OWNER-${suffix}@example.test`,
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_CUSTOMER');
    expect(duplicate.body).not.toHaveProperty('candidates');

    const unauthorizedLink = await request(app.getHttpServer())
      .put(`/api/inquiries/${crossOwnerInquiryId}/customer-link`)
      .set(bearer(salesToken))
      .send({ customer_id: customer.body.id });
    expect(unauthorizedLink.status).toBe(404);

    const recovered = await request(app.getHttpServer())
      .put(`/api/inquiries/${crossOwnerInquiryId}/customer-link`)
      .set(bearer(adminToken))
      .send({ customer_id: customer.body.id });
    expect(recovered.status).toBe(200);
    expect(recovered.body.id).toBe(customer.body.id);
  });

  it('serializes concurrent upgrades that share only a normalized company name', async () => {
    const suffix = Date.now();
    const companyName = `Company Lock Race ${suffix}`;
    const firstInquiryId = await createLeadInquiry(`COMPANY-RACE-${suffix}-A`);
    const secondInquiryId = await createLeadInquiry(`COMPANY-RACE-${suffix}-B`);
    const responses = await withHeldDuplicateLock(
      `customer_duplicate:${TEST_TENANT_ID}:company:${companyName.toLowerCase()}`,
      () =>
        Promise.all([
          request(app.getHttpServer())
            .post(`/api/inquiries/${firstInquiryId}/customer-upgrade`)
            .set(bearer(salesToken))
            .send({ company_name: companyName, email: `company-a-${suffix}@example.test` }),
          request(app.getHttpServer())
            .post(`/api/inquiries/${secondInquiryId}/customer-upgrade`)
            .set(bearer(salesToken))
            .send({
              company_name: ` ${companyName.toUpperCase()} `,
              email: `company-b-${suffix}@example.test`,
            }),
        ]),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const count = await withAdmin(async (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM customers
          WHERE tenant_id = $1 AND lower(btrim(company_name)) = lower(btrim($2))`,
        [TEST_TENANT_ID, companyName],
      ),
    );
    expect(count.rows[0].count).toBe('1');
  });

  it('serializes concurrent upgrades that share only a normalized email', async () => {
    const suffix = Date.now();
    const email = `email-lock-${suffix}@example.test`;
    const firstInquiryId = await createLeadInquiry(`EMAIL-RACE-${suffix}-A`);
    const secondInquiryId = await createLeadInquiry(`EMAIL-RACE-${suffix}-B`);
    const responses = await withHeldDuplicateLock(
      `customer_duplicate:${TEST_TENANT_ID}:email:${email}`,
      () =>
        Promise.all([
          request(app.getHttpServer())
            .post(`/api/inquiries/${firstInquiryId}/customer-upgrade`)
            .set(bearer(salesToken))
            .send({ company_name: `Email Race A ${suffix}`, email }),
          request(app.getHttpServer())
            .post(`/api/inquiries/${secondInquiryId}/customer-upgrade`)
            .set(bearer(salesToken))
            .send({ company_name: `Email Race B ${suffix}`, email: email.toUpperCase() }),
        ]),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const count = await withAdmin(async (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM customers
          WHERE tenant_id = $1 AND lower(email) = lower($2)`,
        [TEST_TENANT_ID, email],
      ),
    );
    expect(count.rows[0].count).toBe('1');
  });

  it('freezes exact commercial terms and keeps them stable after quotation overwrite', async () => {
    const submitted = await request(app.getHttpServer())
      .post(`/api/inquiries/${inquiryId}/submit`)
      .set(bearer(salesToken));
    expect(submitted.status).toBe(201);
    const taskId = submitted.body.quote_task.id as string;
    const itemId = submitted.body.inquiry.items[0].id as string;

    const corrected = await request(app.getHttpServer())
      .put(`/api/quote-tasks/${taskId}/manual`)
      .set(bearer(adminToken))
      .send({
        summary: 'Synthetic precision valve requirement',
        items: [
          {
            inquiry_item_id: itemId,
            description: 'Precision valve',
            specifications: '316L',
            quantity: '3.333',
            unit: 'pcs',
          },
        ],
      });
    expect(corrected.status).toBe(200);

    const supplier = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: 'Stage 2B Supplier' });
    expect(supplier.status).toBe(201);

    const quotation = await request(app.getHttpServer())
      .put(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(adminToken))
      .send({
        supplier_id: supplier.body.id,
        expected_version: 0,
        currency: 'USD',
        valid_until: '2099-12-31',
        lines: [
          {
            inquiry_item_id: itemId,
            quantity: '3.333',
            unit_price: '1.2345',
          },
        ],
      });
    expect(quotation.status).toBe(200);

    const selected = await request(app.getHttpServer())
      .post(`/api/inquiries/${inquiryId}/selections`)
      .set(bearer(salesToken))
      .send({
        quotation_line_id: quotation.body.lines[0].id,
        expected_quotation_version: 1,
        sales_currency: 'USD',
        sales_unit_price: '1.5000',
      });
    expect(selected.status).toBe(201);
    selectionId = selected.body.id;
    expect(selected.body.commercial).toMatchObject({
      sales_unit_price: '1.5000',
      purchase_to_sales_fx_rate: '1.00000000',
      purchase_unit_cost: '1.2345',
      gross_profit_unit: '0.2655',
      gross_margin_bps: 1770,
      margin_threshold_bps: 2000,
      margin_status: 'below_threshold',
      margin_formula_version: 'gross_margin_bps_v1',
      margin_approved: false,
    });

    const overwritten = await request(app.getHttpServer())
      .put(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(adminToken))
      .send({
        supplier_id: supplier.body.id,
        expected_version: 1,
        currency: 'USD',
        valid_until: '2099-12-31',
        lines: [
          {
            inquiry_item_id: itemId,
            quantity: '3.333',
            unit_price: '9.9999',
          },
        ],
      });
    expect(overwritten.status).toBe(200);

    const selections = await request(app.getHttpServer())
      .get(`/api/inquiries/${inquiryId}/selections`)
      .set(bearer(salesToken));
    expect(selections.body[0].quotation_version).toBe(1);
    expect(selections.body[0].snapshot.line.unit_price).toBe('1.2345');
    expect(selections.body[0].commercial.purchase_unit_cost).toBe('1.2345');
  });

  it('versions PI content, blocks low margin, and exports an audited watermarked document', async () => {
    const created = await request(app.getHttpServer())
      .post(`/api/inquiries/${inquiryId}/proforma-invoices`)
      .set(bearer(salesToken))
      .send({ selection_ids: [selectionId], payment_terms: '50% deposit before procurement' });
    expect(created.status).toBe(201);
    piV1Id = created.body.id;
    expect(created.body.total_amount).toBe('5.00');
    expect(created.body.items[0].selection_snapshot.line.unit_price).toBe('1.2345');

    const blocked = await request(app.getHttpServer())
      .post(`/api/proforma-invoices/${piV1Id}/issue`)
      .set(bearer(salesToken));
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('LOW_MARGIN_APPROVAL_REQUIRED');

    const approved = await request(app.getHttpServer())
      .post(`/api/quote-selections/${selectionId}/margin-approval`)
      .set(bearer(adminToken))
      .send({ reason: 'Strategic first order approved by tenant administrator' });
    expect(approved.status).toBe(201);

    const issuedV1 = await request(app.getHttpServer())
      .post(`/api/proforma-invoices/${piV1Id}/issue`)
      .set(bearer(salesToken));
    expect(issuedV1.status).toBe(201);
    expect(issuedV1.body.status).toBe('issued');

    const revised = await request(app.getHttpServer())
      .post(`/api/proforma-invoices/${piV1Id}/revisions`)
      .set(bearer(salesToken))
      .send({ payment_terms: '50% deposit; balance before shipment' });
    expect(revised.status).toBe(201);
    piV2Id = revised.body.id;
    expect(revised.body.version).toBe(2);
    expect(revised.body.total_amount).toBe('5.00');
    expect(revised.body.items[0].selection_snapshot.line.unit_price).toBe('1.2345');

    const superseded = await request(app.getHttpServer())
      .post(`/api/proforma-invoices/${piV1Id}/customer-confirm`)
      .set(bearer(salesToken));
    expect(superseded.status).toBe(409);
    expect(superseded.body.code).toBe('PI_VERSION_SUPERSEDED');

    const issuedV2 = await request(app.getHttpServer())
      .post(`/api/proforma-invoices/${piV2Id}/issue`)
      .set(bearer(salesToken));
    expect(issuedV2.status).toBe(201);

    const exported = await request(app.getHttpServer())
      .get(`/api/proforma-invoices/${piV2Id}/export`)
      .set(bearer(salesToken));
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('text/html');
    expect(exported.headers['content-disposition']).toContain('.html');
    expect(exported.text).toContain('CONFIDENTIAL / 机密');
    expect(exported.text).toContain(TEST_USER2_EMAIL);
    expect(exported.text).not.toContain('Stage 2B Supplier');

    const forbidden = await request(app.getHttpServer())
      .get(`/api/proforma-invoices/${piV2Id}/export`)
      .set(bearer(noPermissionToken));
    expect(forbidden.status).toBe(403);

    const crossTenant = await request(app.getHttpServer())
      .get(`/api/proforma-invoices/${piV2Id}`)
      .set(bearer(tenant2Token));
    expect(crossTenant.status).toBe(404);
  });

  it('keeps PI issuer and issuance timestamp immutable during confirmation', async () => {
    const before = await withAdmin(async (client) => {
      const result = await client.query<{ issued_by: string; issued_at: string }>(
        `SELECT issued_by, issued_at::text AS issued_at
           FROM proforma_invoices
          WHERE id = $1`,
        [piV2Id],
      );
      return result.rows[0];
    });

    await expect(
      withAdmin(async (client) => {
        await client.query('BEGIN');
        try {
          const identity = await client.query<{ id: string }>(
            `SELECT uuid_generate_v4()::text AS id`,
          );
          const temporaryOrderId = identity.rows[0].id;
          await client.query(
            `INSERT INTO sales_orders
               (id, tenant_id, customer_id, owner_user_id, order_number, pi_number,
                currency, total_amount, status, inquiry_id, source_pi_id)
             SELECT $2::uuid, p.tenant_id, p.customer_id, i.owner_user_id,
                    'SO-IMMUTABLE-' || upper(substr(replace($2::uuid::text, '-', ''), 1, 20)),
                    p.pi_number, p.currency, p.total_amount, 'customer_confirmed',
                    p.inquiry_id, p.id
               FROM proforma_invoices p
               JOIN inquiries i ON i.id = p.inquiry_id AND i.tenant_id = p.tenant_id
              WHERE p.id = $1`,
            [piV2Id, temporaryOrderId],
          );
          await client.query(
            `UPDATE proforma_invoices
                SET status = 'customer_confirmed', issued_by = $2,
                    issued_at = issued_at + interval '1 second', confirmed_by = $3,
                    confirmed_at = now(), sales_order_id = $4, updated_at = now()
              WHERE id = $1`,
            [piV2Id, TEST_USER_ID, TEST_USER2_ID, temporaryOrderId],
          );
        } finally {
          await client.query('ROLLBACK');
        }
      }),
    ).rejects.toThrow(/issuance facts are immutable/);

    const after = await withAdmin(async (client) => {
      const result = await client.query<{ issued_by: string; issued_at: string }>(
        `SELECT issued_by, issued_at::text AS issued_at
           FROM proforma_invoices
          WHERE id = $1`,
        [piV2Id],
      );
      return result.rows[0];
    });
    expect(after).toEqual(before);
  });

  it('creates the order only on customer confirmation and persists a blocked gate snapshot', async () => {
    const confirmed = await request(app.getHttpServer())
      .post(`/api/proforma-invoices/${piV2Id}/customer-confirm`)
      .set(bearer(salesToken));
    expect(confirmed.status).toBe(201);
    orderId = confirmed.body.sales_order.id;
    expect(confirmed.body.sales_order.status).toBe('customer_confirmed');
    expect(confirmed.body.procurement_gate).toMatchObject({
      status: 'blocked',
      order_amount: '5.00',
      confirmed_amount: '0.00',
      required_amount: '2.50',
      blocking_reasons: ['insufficient_confirmed_receipts'],
    });

    const persisted = await request(app.getHttpServer())
      .get(`/api/sales-orders/${orderId}/procurement-gate`)
      .set(bearer(salesToken));
    expect(persisted.status).toBe(200);
    expect(persisted.body.id).toBe(confirmed.body.procurement_gate.id);
  });

  it('requires proof, rejects duplicate receipt facts, and opens the gate only after review', async () => {
    const missingProof = await request(app.getHttpServer())
      .post(`/api/sales-orders/${orderId}/customer-receipts`)
      .set(bearer(salesToken))
      .send({
        amount: '2.49',
        currency: 'USD',
        received_at: '2026-07-31',
        method: 'bank_transfer',
        external_reference: 'STAGE2B-TX-001',
      });
    expect(missingProof.status).toBe(400);
    expect(missingProof.body.code).toBe('RECEIPT_PROOF_REQUIRED');

    proofFileId = await withAdmin(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO files
           (tenant_id, uploaded_by, original_name, storage_key, mime_type,
            size_bytes, sha256, purpose)
         VALUES ($1,$2,'stage-2b-proof.pdf',$3,'application/pdf',12,$4,'receipt_proof')
         RETURNING id`,
        [TEST_TENANT_ID, TEST_USER2_ID, `stage-2b/${Date.now()}`, 'a'.repeat(64)],
      );
      return inserted.rows[0].id;
    });

    const recorded = await request(app.getHttpServer())
      .post(`/api/sales-orders/${orderId}/customer-receipts`)
      .set(bearer(salesToken))
      .send({
        amount: '2.49',
        currency: 'USD',
        received_at: '2026-07-31',
        method: 'bank_transfer',
        external_reference: 'STAGE2B-TX-001',
        proof_file_id: proofFileId,
      });
    expect(recorded.status).toBe(201);
    expect(recorded.body.receipt.status).toBe('recorded');
    expect(recorded.body.receipt.payment_provider_status).toBe('not_verified');
    expect(recorded.body.procurement_gate.confirmed_amount).toBe('0.00');

    const duplicate = await request(app.getHttpServer())
      .post(`/api/sales-orders/${orderId}/customer-receipts`)
      .set(bearer(salesToken))
      .send({
        amount: '2.49',
        currency: 'USD',
        received_at: '2026-07-31',
        method: 'bank_transfer',
        external_reference: 'STAGE2B-TX-001',
        proof_file_id: proofFileId,
      });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_RECEIPT');

    const confirmedFirst = await request(app.getHttpServer())
      .post(`/api/customer-receipts/${recorded.body.receipt.id}/review`)
      .set(bearer(adminToken))
      .send({ decision: 'confirmed' });
    expect(confirmedFirst.status).toBe(201);
    expect(confirmedFirst.body.procurement_gate).toMatchObject({
      status: 'blocked',
      confirmed_amount: '2.49',
      required_amount: '2.50',
    });

    const remainder = await request(app.getHttpServer())
      .post(`/api/sales-orders/${orderId}/customer-receipts`)
      .set(bearer(salesToken))
      .send({
        amount: '0.01',
        currency: 'USD',
        received_at: '2026-07-31',
        method: 'bank_transfer',
        external_reference: 'STAGE2B-TX-002',
        proof_file_id: proofFileId,
      });
    expect(remainder.status).toBe(201);
    const confirmedRemainder = await request(app.getHttpServer())
      .post(`/api/customer-receipts/${remainder.body.receipt.id}/review`)
      .set(bearer(adminToken))
      .send({ decision: 'confirmed' });
    expect(confirmedRemainder.status).toBe(201);
    expect(confirmedRemainder.body.procurement_gate).toMatchObject({
      status: 'open',
      confirmed_amount: '2.50',
      required_amount: '2.50',
      blocking_reasons: [],
    });

    const order = await request(app.getHttpServer())
      .get(`/api/sales-orders/${orderId}`)
      .set(bearer(salesToken));
    expect(order.body.status).toBe('payment_gate_open');

    await expect(
      withAdmin((client) =>
        client.query(`UPDATE customer_receipts SET amount = 99 WHERE id = $1`, [
          recorded.body.receipt.id,
        ]),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('records an explicit gate bypass and restores the configured gate without losing history', async () => {
    const bypassed = await request(app.getHttpServer())
      .put('/api/commercial-settings')
      .set(bearer(adminToken))
      .send({
        minimum_margin_bps: 2000,
        procurement_gate_enabled: false,
        required_receipt_ratio_bps: 5000,
        receipt_proof_required: true,
        bypass_reason: 'Temporary tenant policy exception approved for test',
      });
    expect(bypassed.status).toBe(200);

    const bypassGate = await request(app.getHttpServer())
      .get(`/api/sales-orders/${orderId}/procurement-gate`)
      .set(bearer(adminToken));
    expect(bypassGate.body).toMatchObject({
      status: 'bypassed',
      config_enabled: false,
      bypass_reason: 'Temporary tenant policy exception approved for test',
    });

    await request(app.getHttpServer())
      .put('/api/commercial-settings')
      .set(bearer(adminToken))
      .send({
        minimum_margin_bps: 2000,
        procurement_gate_enabled: true,
        required_receipt_ratio_bps: 5000,
        receipt_proof_required: true,
      })
      .expect(200);
    const restored = await request(app.getHttpServer())
      .get(`/api/sales-orders/${orderId}/procurement-gate`)
      .set(bearer(adminToken));
    expect(restored.body).toMatchObject({ status: 'open', config_enabled: true });

    const historyCount = await withAdmin(async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM procurement_gate_evaluations
          WHERE sales_order_id = $1`,
        [orderId],
      );
      return Number(result.rows[0].count);
    });
    expect(historyCount).toBeGreaterThanOrEqual(7);
  });

  it('keeps the tenant audit chain valid after the complete workflow', async () => {
    const verification = await request(app.getHttpServer())
      .get('/api/audit-logs/chain/verify')
      .set(bearer(adminToken));
    expect(verification.status).toBe(200);
    expect(verification.body.ok).toBe(true);
  });

  it('recovers PI, receipt, and gate state after an application restart', async () => {
    await app.close();
    await pool.end();
    ({ app, pool } = await startApplication());
    salesToken = await login(TEST_USER2_EMAIL);

    const pi = await request(app.getHttpServer())
      .get(`/api/proforma-invoices/${piV2Id}`)
      .set(bearer(salesToken));
    expect(pi.status).toBe(200);
    expect(pi.body).toMatchObject({
      id: piV2Id,
      status: 'customer_confirmed',
      sales_order_id: orderId,
      total_amount: '5.00',
    });

    const receipts = await request(app.getHttpServer())
      .get(`/api/sales-orders/${orderId}/customer-receipts`)
      .set(bearer(salesToken));
    expect(receipts.status).toBe(200);
    expect(receipts.body).toHaveLength(2);
    expect(
      receipts.body.every(
        (receipt: { payment_provider_status: string }) =>
          receipt.payment_provider_status === 'not_verified',
      ),
    ).toBe(true);

    const gate = await request(app.getHttpServer())
      .get(`/api/sales-orders/${orderId}/procurement-gate`)
      .set(bearer(salesToken));
    expect(gate.status).toBe(200);
    expect(gate.body).toMatchObject({
      status: 'open',
      confirmed_amount: '2.50',
      required_amount: '2.50',
    });
  });
});
