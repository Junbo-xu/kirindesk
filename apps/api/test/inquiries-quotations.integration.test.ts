import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type { Pool } from 'pg';
import request from 'supertest';
import { closePool } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import {
  AI_PROVIDER,
  type AiCompleteInput,
  type AiProvider,
} from '../src/ai/ai-provider.interface';
import { AiProviderException, AiRateLimitException, AiTimeoutException } from '../src/ai/ai.errors';
import {
  QUOTATION_PERMS,
  TEST_PASSWORD,
  TEST_TENANT2_SLUG,
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_USER2_EMAIL,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_USER4_ID,
  TEST_USER_EMAIL,
} from './fixtures';

type ProviderMode = 'success' | 'timeout' | 'rate_limited' | 'invalid' | 'failed';

class ContractAiProvider implements AiProvider {
  readonly name = 'deepseek-contract-test-double';
  mode: ProviderMode = 'success';

  async complete(input: AiCompleteInput) {
    if (this.mode === 'timeout') throw new AiTimeoutException(15_000);
    if (this.mode === 'rate_limited') throw new AiRateLimitException();
    if (this.mode === 'failed') throw new AiProviderException('complete');
    if (this.mode === 'invalid') {
      return {
        provider: this.name,
        output: '{not-json',
        tokensUsed: 3,
        durationMs: 4,
      };
    }

    const prompt = JSON.parse(input.input) as {
      inquiry: {
        items: Array<{
          inquiry_item_id: string;
          description: string;
          specifications: string | null;
          quantity: string;
          unit: string;
        }>;
      };
    };
    return {
      provider: this.name,
      output: JSON.stringify({
        summary: 'Sanitized product requirements',
        items: prompt.inquiry.items,
      }),
      tokensUsed: 21,
      durationMs: 8,
    };
  }
}

describe('Stage 2A inquiry and quotation workflow (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let provider: ContractAiProvider;
  let salesToken: string;
  let procurementToken: string;
  let adminToken: string;
  let tenant2Token: string;

  let inquiryId: string;
  let inquiryItemIds: string[];
  let taskId: string;
  let supplierId: string;
  let quotationId: string;
  let currentQuotation: Record<string, unknown>;

  const { Client } = pg;

  async function withAdmin<T>(callback: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await callback(client);
    } finally {
      await client.end();
    }
  }

  async function login(email: string, tenantSlug = TEST_TENANT_SLUG): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function grantProcurementRole(): Promise<void> {
    await withAdmin(async (client) => {
      const roleId = '88888888-8888-8888-8888-888888888888';
      await client.query(
        `INSERT INTO roles (id, tenant_id, name, is_system)
         VALUES ($1, $2, 'Procurement Test', true)`,
        [roleId, TEST_TENANT_ID],
      );
      await client.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
        [TEST_TENANT_ID, TEST_USER4_ID, roleId],
      );
      await client.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
         SELECT $1, $2, id, 'all'
           FROM permissions
          WHERE code = ANY($3)`,
        [TEST_TENANT_ID, roleId, [...QUOTATION_PERMS, 'suppliers:view', 'suppliers:create']],
      );
    });
  }

  async function createAndSubmitInquiry(label: string) {
    const created = await request(app.getHttpServer())
      .post('/api/inquiries')
      .set(bearer(salesToken))
      .send({
        customer_code: `PRIVATE-${label}`,
        customer_country: 'DE',
        customer_message: `Buyer ${label} buyer-${label.toLowerCase()}@example.test +49 151 23456789`,
        items: [
          {
            description: 'Steel bottle',
            specifications: '750ml',
            quantity: '100.000',
            unit: 'pcs',
            target_price_usd: '2.5000',
          },
        ],
      });
    expect(created.status).toBe(201);
    const submitted = await request(app.getHttpServer())
      .post(`/api/inquiries/${created.body.id}/submit`)
      .set(bearer(salesToken));
    expect(submitted.status).toBe(201);
    return {
      inquiryId: created.body.id as string,
      itemId: created.body.items[0].id as string,
      taskId: submitted.body.quote_task.id as string,
    };
  }

  function quotationPayload(expectedVersion: number, unitPrice: string, currency = 'USD') {
    return {
      supplier_id: supplierId,
      expected_version: expectedVersion,
      currency,
      valid_until: '2099-12-31',
      source_text: 'Supplier confidential source quotation',
      lines: inquiryItemIds.map((itemId, index) => ({
        inquiry_item_id: itemId,
        variant_key: 'finish',
        variant_value: index === 0 ? 'matte' : 'gloss',
        quantity: index === 0 ? '100.000' : '25.500',
        unit_price: unitPrice,
        minimum_quantity: '10.000',
        lead_time_days: 14,
        terms: '30% deposit',
      })),
    };
  }

  beforeAll(async () => {
    provider = new ContractAiProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);

    await grantProcurementRole();
    adminToken = await login(TEST_USER_EMAIL);
    salesToken = await login(TEST_USER2_EMAIL);
    procurementToken = await login(TEST_USER4_EMAIL);
    tenant2Token = await login(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('enforces role gates in both directions', async () => {
    const procurementInquiry = await request(app.getHttpServer())
      .get('/api/inquiries')
      .set(bearer(procurementToken));
    expect(procurementInquiry.status).toBe(403);

    const salesTasks = await request(app.getHttpServer())
      .get('/api/quote-tasks')
      .set(bearer(salesToken));
    expect(salesTasks.status).toBe(403);
  });

  it('persists a multi-line inquiry with exact decimal strings and submits atomically', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/inquiries')
      .set(bearer(salesToken))
      .send({
        customer_code: 'PRIVATE-ACME',
        customer_country: 'US',
        customer_message: 'Contact Alice at alice@private-acme.test or +1 415 555 0199',
        items: [
          {
            description: 'Steel bottle',
            specifications: '750ml, matte',
            quantity: '100.000',
            unit: 'pcs',
            target_price_usd: '2.5000',
          },
          {
            description: 'Gift carton',
            specifications: 'Recycled kraft',
            quantity: '25.500',
            unit: 'carton',
            target_price_usd: '0.7500',
          },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.items.map((item: { quantity: string }) => item.quantity)).toEqual([
      '100.000',
      '25.500',
    ]);
    expect(
      created.body.items.map((item: { target_price_usd: string }) => item.target_price_usd),
    ).toEqual(['2.5000', '0.7500']);
    inquiryId = created.body.id;
    inquiryItemIds = created.body.items.map((item: { id: string }) => item.id);

    const submitted = await request(app.getHttpServer())
      .post(`/api/inquiries/${inquiryId}/submit`)
      .set(bearer(salesToken));
    expect(submitted.status).toBe(201);
    expect(submitted.body.inquiry.status).toBe('submitted');
    expect(submitted.body.quote_task.sanitization_status).toBe('pending');
    taskId = submitted.body.quote_task.id;
  });

  it('enforces tenant RLS and keeps raw customer fields out of procurement responses', async () => {
    const crossTenantInquiry = await request(app.getHttpServer())
      .get(`/api/inquiries/${inquiryId}`)
      .set(bearer(tenant2Token));
    expect(crossTenantInquiry.status).toBe(404);

    const task = await request(app.getHttpServer())
      .get(`/api/quote-tasks/${taskId}`)
      .set(bearer(procurementToken));
    expect(task.status).toBe(200);
    expect(task.body).not.toHaveProperty('customer_code');
    expect(task.body).not.toHaveProperty('customer_message');
    expect(JSON.stringify(task.body)).not.toContain('alice@private-acme.test');

    const crossTenantTasks = await request(app.getHttpServer())
      .get('/api/quote-tasks')
      .set(bearer(tenant2Token));
    expect(crossTenantTasks.status).toBe(200);
    expect(crossTenantTasks.body).toEqual([]);
  });

  it('drives structured success through the provider contract without claiming a real provider', async () => {
    provider.mode = 'success';
    const response = await request(app.getHttpServer())
      .post(`/api/inquiries/${inquiryId}/sanitize`)
      .set(bearer(salesToken));
    expect(response.status).toBe(201);
    expect(response.body.sanitization_status).toBe('ready');
    expect(response.body.provider_name).toBe('deepseek-contract-test-double');
    expect(response.body.items).toHaveLength(2);
    expect(response.body).not.toHaveProperty('customer_message');
  });

  it('persists timeout, rate-limit, parse and provider failures and supports retry/manual correction', async () => {
    const timeout = await createAndSubmitInquiry('TIMEOUT');
    provider.mode = 'timeout';
    const timedOut = await request(app.getHttpServer())
      .post(`/api/inquiries/${timeout.inquiryId}/sanitize`)
      .set(bearer(salesToken));
    expect(timedOut.body.sanitization_status).toBe('timeout');
    expect(timedOut.body.last_error_code).toBe('timeout');

    const limited = await createAndSubmitInquiry('LIMIT');
    provider.mode = 'rate_limited';
    const rateLimited = await request(app.getHttpServer())
      .post(`/api/inquiries/${limited.inquiryId}/sanitize`)
      .set(bearer(salesToken));
    expect(rateLimited.body.sanitization_status).toBe('rate_limited');
    provider.mode = 'success';
    const retried = await request(app.getHttpServer())
      .post(`/api/inquiries/${limited.inquiryId}/sanitize`)
      .set(bearer(salesToken));
    expect(retried.body.sanitization_status).toBe('ready');
    expect(retried.body.attempt_count).toBe(2);

    const invalid = await createAndSubmitInquiry('INVALID');
    provider.mode = 'invalid';
    const parseFailed = await request(app.getHttpServer())
      .post(`/api/inquiries/${invalid.inquiryId}/sanitize`)
      .set(bearer(salesToken));
    expect(parseFailed.body.sanitization_status).toBe('parse_failed');
    const corrected = await request(app.getHttpServer())
      .put(`/api/quote-tasks/${invalid.taskId}/manual`)
      .set(bearer(procurementToken))
      .send({
        summary: 'Manually sanitized product requirements',
        items: [
          {
            inquiry_item_id: invalid.itemId,
            description: 'Steel bottle',
            specifications: '750ml',
            quantity: '100.000',
            unit: 'pcs',
          },
        ],
      });
    expect(corrected.status).toBe(200);
    expect(corrected.body.sanitization_status).toBe('manually_corrected');
    expect(corrected.body.provider_name).toBe('manual');

    const failed = await createAndSubmitInquiry('FAILED');
    provider.mode = 'failed';
    const providerFailed = await request(app.getHttpServer())
      .post(`/api/inquiries/${failed.inquiryId}/sanitize`)
      .set(bearer(salesToken));
    expect(providerFailed.body.sanitization_status).toBe('provider_failed');
  });

  it('recovers an abandoned processing lease on a later retry', async () => {
    const abandoned = await createAndSubmitInquiry('ABANDONED');
    await withAdmin(async (client) => {
      await client.query(
        `UPDATE quote_tasks
            SET sanitization_status = 'processing', last_attempted_at = now() - interval '5 minutes'
          WHERE id = $1`,
        [abandoned.taskId],
      );
    });
    provider.mode = 'success';
    const recovered = await request(app.getHttpServer())
      .post(`/api/inquiries/${abandoned.inquiryId}/sanitize`)
      .set(bearer(salesToken));
    expect(recovered.status).toBe(201);
    expect(recovered.body.sanitization_status).toBe('ready');
    expect(recovered.body.attempt_count).toBe(1);
  });

  it('rejects supplier identity in sales-visible quotation fields', async () => {
    const supplier = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(procurementToken))
      .send({
        company_name: 'Secret Dragon Supply Ltd',
        contact_name: 'Procurement Alice',
        email: 'alice@secret-dragon.test',
        phone: '+86 138 0013 8000',
      });
    expect(supplier.status).toBe(201);
    supplierId = supplier.body.id;

    const rejected = await request(app.getHttpServer())
      .put(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(procurementToken))
      .send({
        ...quotationPayload(0, '2.1250'),
        lines: [
          {
            ...quotationPayload(0, '2.1250').lines[0],
            terms: 'Contact Secret Dragon Supply Ltd for payment',
          },
          quotationPayload(0, '2.1250').lines[1],
        ],
      });
    expect(rejected.status).toBe(400);
  });

  it('stores only the current quotation while keeping role-safe projections', async () => {
    const created = await request(app.getHttpServer())
      .put(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(procurementToken))
      .send(quotationPayload(0, '2.1250'));
    expect(created.status).toBe(200);
    expect(created.body.version).toBe(1);
    expect(created.body.lines[0].unit_price).toBe('2.1250');
    quotationId = created.body.id;
    currentQuotation = created.body;

    const sales = await request(app.getHttpServer())
      .get(`/api/inquiries/${inquiryId}/quotations`)
      .set(bearer(salesToken));
    expect(sales.status).toBe(200);
    const serialized = JSON.stringify(sales.body);
    for (const forbidden of [
      supplierId,
      'Secret Dragon Supply Ltd',
      'alice@secret-dragon.test',
      'source_text',
      'supplier_id',
      'entered_by',
      'terms',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const procurement = await request(app.getHttpServer())
      .get(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(procurementToken));
    expect(procurement.body[0].supplier_id).toBe(supplierId);
    expect(procurement.body[0].source_text).toContain('confidential');
  });

  it('allows only one concurrent overwrite for the same expected version', async () => {
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .put(`/api/quote-tasks/${taskId}/quotations`)
        .set(bearer(procurementToken))
        .send(quotationPayload(1, '2.2000', 'USD')),
      request(app.getHttpServer())
        .put(`/api/quote-tasks/${taskId}/quotations`)
        .set(bearer(procurementToken))
        .send(quotationPayload(1, '15.8000', 'RMB')),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    currentQuotation = first.status === 200 ? first.body : second.body;
    expect(currentQuotation.version).toBe(2);

    const current = await request(app.getHttpServer())
      .get(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(procurementToken));
    expect(current.body).toHaveLength(1);
    expect(current.body[0].version).toBe(2);

    const sequence = await request(app.getHttpServer())
      .get(`/api/quotations/${quotationId}/overwrite-sequence`)
      .set(bearer(procurementToken));
    expect(sequence.status).toBe(200);
    expect(sequence.body.complete).toBe(true);
    expect(
      sequence.body.sequence.map((entry: { after: { version: number } }) => entry.after.version),
    ).toEqual([1, 2]);
  });

  it('rolls back quotation changes when the audit insert fails', async () => {
    await withAdmin(async (client) => {
      await client.query(`
        CREATE FUNCTION fail_supplier_quotation_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.resource_type = 'supplier_quotation' THEN
            RAISE EXCEPTION 'forced quotation audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_supplier_quotation_audit
          BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION fail_supplier_quotation_audit();
      `);
    });
    try {
      const failed = await request(app.getHttpServer())
        .put(`/api/quote-tasks/${taskId}/quotations`)
        .set(bearer(procurementToken))
        .send(quotationPayload(2, '9.9999'));
      expect(failed.status).toBe(500);
    } finally {
      await withAdmin(async (client) => {
        await client.query(`
          DROP TRIGGER fail_supplier_quotation_audit ON audit_logs;
          DROP FUNCTION fail_supplier_quotation_audit();
        `);
      });
    }

    const current = await request(app.getHttpServer())
      .get(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(procurementToken));
    expect(current.body[0].version).toBe(2);
    expect(current.body[0].lines[0].unit_price).toBe(
      (currentQuotation.lines as Array<{ unit_price: string }>)[0].unit_price,
    );
  });

  it('rolls back quotation changes when the audit chain head is invalid', async () => {
    await withAdmin(async (client) => {
      await client.query(
        `UPDATE audit_log_chains SET last_hash = repeat('f', 64) WHERE chain_key = $1`,
        [`tenant:${TEST_TENANT_ID}`],
      );
    });
    try {
      const failed = await request(app.getHttpServer())
        .put(`/api/quote-tasks/${taskId}/quotations`)
        .set(bearer(procurementToken))
        .send(quotationPayload(2, '8.8888'));
      expect(failed.status).toBe(500);
    } finally {
      await withAdmin(async (client) => {
        await client.query(
          `UPDATE audit_log_chains c
              SET last_hash = al.row_hash
             FROM audit_logs al
            WHERE c.chain_key = $1 AND al.id = c.last_log_id`,
          [`tenant:${TEST_TENANT_ID}`],
        );
      });
    }

    const current = await request(app.getHttpServer())
      .get(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(procurementToken));
    expect(current.body[0].version).toBe(2);
  });

  it('freezes a self-contained immutable selection while later quotation overwrite remains possible', async () => {
    const line = (currentQuotation.lines as Array<{ id: string; unit_price: string }>)[0];
    const selected = await request(app.getHttpServer())
      .post(`/api/inquiries/${inquiryId}/selections`)
      .set(bearer(salesToken))
      .send({
        quotation_line_id: line.id,
        expected_quotation_version: 2,
        sales_currency: (currentQuotation.currency as string) ?? 'USD',
        sales_unit_price: '3.5000',
      });
    expect(selected.status).toBe(201);
    expect(selected.body.snapshot.line.unit_price).toBe(line.unit_price);
    const serialized = JSON.stringify(selected.body);
    for (const forbidden of [supplierId, 'supplier_id', 'source_text', 'entered_by', 'terms']) {
      expect(serialized).not.toContain(forbidden);
    }

    const overwritten = await request(app.getHttpServer())
      .put(`/api/quote-tasks/${taskId}/quotations`)
      .set(bearer(procurementToken))
      .send(quotationPayload(2, '2.3333'));
    expect(overwritten.status).toBe(200);
    expect(overwritten.body.version).toBe(3);

    const selections = await request(app.getHttpServer())
      .get(`/api/inquiries/${inquiryId}/selections`)
      .set(bearer(salesToken));
    expect(selections.body[0].quotation_version).toBe(2);
    expect(selections.body[0].snapshot.line.unit_price).toBe(line.unit_price);

    await expect(
      withAdmin((client) =>
        client.query(
          `UPDATE quote_selection_snapshots SET snapshot_json = '{}'::jsonb WHERE id = $1`,
          [selected.body.id],
        ),
      ),
    ).rejects.toThrow(/immutable/);
  });

  it('keeps sensitive quotation evidence out of general audit detail/export', async () => {
    const list = await request(app.getHttpServer())
      .get('/api/audit-logs?action=supplier_quotation.created')
      .set(bearer(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);

    const auditId = await withAdmin(async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM audit_logs
          WHERE tenant_id = $1 AND resource_type = 'supplier_quotation'
          ORDER BY id ASC LIMIT 1`,
        [TEST_TENANT_ID],
      );
      return result.rows[0].id;
    });
    const detail = await request(app.getHttpServer())
      .get(`/api/audit-logs/${auditId}`)
      .set(bearer(adminToken));
    expect(detail.status).toBe(404);

    const exported = await request(app.getHttpServer())
      .get('/api/audit-logs/export?resourceType=supplier_quotation')
      .set(bearer(adminToken));
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain(quotationId);

    const sequence = await request(app.getHttpServer())
      .get(`/api/quotations/${quotationId}/overwrite-sequence`)
      .set(bearer(procurementToken));
    expect(sequence.body.current_version).toBe(3);
    expect(sequence.body.sequence).toHaveLength(3);
  });

  it('leaves the tenant audit chain valid', async () => {
    const verification = await request(app.getHttpServer())
      .get('/api/audit-logs/chain/verify')
      .set(bearer(adminToken));
    expect(verification.status).toBe(200);
    expect(verification.body.ok).toBe(true);
  });
});
