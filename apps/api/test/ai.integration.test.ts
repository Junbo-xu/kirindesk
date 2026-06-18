import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import type { Pool } from 'pg';
import request from 'supertest';
import { closePool, verifyChain } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import { STORAGE_PROVIDER } from '../src/storage/storage-provider.interface';
import { FakeStorageProvider } from './fake-storage';
import {
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_TENANT2_SLUG,
  TEST_USER_EMAIL,
  TEST_USER2_EMAIL,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
} from './fixtures';

const PDF = Buffer.from('%PDF-1.4 fake pdf bytes for ai/ocr testing');

describe('AI/OCR API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let storage: FakeStorageProvider;
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

  // provider_invocations and audit_logs have FORCE RLS, so the app pool (which
  // sets no tenant context outside a request) reads zero rows. The verification
  // queries below use the superuser connection (DATABASE_URL), which bypasses
  // RLS — same approach as the commission-payouts suite.
  const { Client } = pg;
  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // Uploads a file as the given user and returns its id. OCR needs a real
  // in-scope file to run over (plan §3.1: fileId in, never raw bytes).
  async function uploadAs(token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(token))
      .attach('file', PDF, { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    storage = new FakeStorageProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STORAGE_PROVIDER)
      .useValue(storage)
      .compile();
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

  let adminFileId: string; // uploaded by admin
  let salesFileId: string; // uploaded by sales (scope=own)
  let adminOcrId: string; // an OCR invocation by admin

  // --- auth + permission gates ---

  it('POST /api/ai/ocr with no token returns 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .send({ fileId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(401);
  });

  it('POST /api/ai/ocr with a platform token returns 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(platformToken))
      .send({ fileId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(401);
  });

  it('POST /api/ai/ocr with a tenant user lacking permission returns 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(nopermToken))
      .send({ fileId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(403);
  });

  it('GET /api/ai/ocr without permission returns 403', async () => {
    const res = await request(app.getHttpServer()).get('/api/ai/ocr').set(bearer(nopermToken));
    expect(res.status).toBe(403);
  });

  // --- input validation ---

  it('POST /api/ai/ocr with a non-uuid fileId returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(adminToken))
      .send({ fileId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('POST /api/ai/ocr over an unknown / out-of-scope file returns 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(adminToken))
      .send({ fileId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(404);
  });

  // --- mock OCR success path ---

  it('admin runs OCR over its file -> deterministic invoice fields', async () => {
    adminFileId = await uploadAs(adminToken);
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(adminToken))
      .send({ fileId: adminFileId, docType: 'invoice' });
    expect(res.status).toBe(201);
    expect(res.body.invocation.providerName).toBe('mock');
    expect(res.body.invocation.providerType).toBe('ocr');
    expect(res.body.invocation.status).toBe('success');
    expect(res.body.invocation.sourceFileId).toBe(adminFileId);
    expect(res.body.confidence).toBe(0.95);
    expect(res.body.text).toContain('[[MOCK OCR]]');
    expect(res.body.fields).toEqual([
      { key: 'invoice_no', value: 'MOCK-INV-0001', confidence: 0.99 },
      { key: 'amount', value: '1000.00', confidence: 0.97 },
    ]);
    adminOcrId = res.body.invocation.id;
    // Response must not leak the raw row internals.
    expect(res.body.invocation.tenant_id).toBeUndefined();
    expect(res.body.invocation.request_json).toBeUndefined();
    expect(res.body.invocation.response_json).toBeUndefined();
  });

  // --- audit double-write (plan §5) ---

  it('a provider_invocations row was written with summaries only (no raw text)', async () => {
    const { rows } = await withAdmin((c) =>
      c.query(
        `SELECT provider_type, provider_name, action, status, source_file_id,
                request_json, response_json, invoked_by, duration_ms
           FROM provider_invocations WHERE id = $1`,
        [adminOcrId],
      ),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.provider_type).toBe('ocr');
    expect(row.provider_name).toBe('mock');
    expect(row.action).toBe('ocr.extract');
    expect(row.status).toBe('success');
    expect(row.source_file_id).toBe(adminFileId);
    expect(row.duration_ms).toBe(5);
    // Summaries only — the full OCR text is never persisted (plan §5.3/§5.6).
    expect(row.request_json).toEqual({ fileId: adminFileId, docType: 'invoice' });
    expect(row.response_json).toEqual({
      fieldCount: 2,
      confidence: 0.95,
      textLength: expect.any(Number),
    });
    expect(JSON.stringify(row.response_json)).not.toContain('MOCK OCR');
  });

  it('an audit_logs event was written linking to the invocation', async () => {
    const { rows } = await withAdmin((c) =>
      c.query(
        `SELECT action, resource_type, resource_id, metadata_json
           FROM audit_logs
          WHERE resource_type = 'provider_invocation' AND resource_id = $1`,
        [adminOcrId],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('provider.ocr.invoked');
    expect(rows[0].metadata_json.providerType).toBe('ocr');
    expect(rows[0].metadata_json.status).toBe('success');
    expect(rows[0].metadata_json.fileId).toBe(adminFileId);
  });

  // --- failure path still records both layers (plan §5.2) ---

  it('a provider error returns 500 but still records invocation + audit', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(adminToken))
      .send({ fileId: adminFileId, docType: '__force_error__' });
    expect(res.status).toBe(500);

    const inv = await withAdmin((c) =>
      c.query(
        `SELECT id, status, response_json FROM provider_invocations
          WHERE source_file_id = $1 AND status = 'error' ORDER BY created_at DESC LIMIT 1`,
        [adminFileId],
      ),
    );
    expect(inv.rows).toHaveLength(1);
    expect(inv.rows[0].response_json).toEqual({ reason: 'provider_error' });

    const aud = await withAdmin((c) =>
      c.query(
        `SELECT action FROM audit_logs
          WHERE resource_type = 'provider_invocation' AND resource_id = $1`,
        [inv.rows[0].id],
      ),
    );
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0].action).toBe('provider.ocr.failed');
  });

  // --- AI completion path ---

  it('admin runs an AI completion -> deterministic output, tokensUsed null', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/complete')
      .set(bearer(adminToken))
      .send({ task: 'extract-order-fields', input: 'minimized text' });
    expect(res.status).toBe(201);
    expect(res.body.invocation.providerType).toBe('ai');
    expect(res.body.invocation.status).toBe('success');
    expect(res.body.invocation.tokensUsed).toBeNull();
    expect(JSON.parse(res.body.output)).toEqual({
      order_no: 'MOCK-ORD-0001',
      amount: '2000.00',
      customer: 'MOCK CUSTOMER',
    });
  });

  it('AI completion records only the input length, never the input text', async () => {
    const secret = 'super-secret-business-input';
    const res = await request(app.getHttpServer())
      .post('/api/ai/complete')
      .set(bearer(adminToken))
      .send({ task: 'summarize', input: secret });
    expect(res.status).toBe(201);
    const { rows } = await withAdmin((c) =>
      c.query(`SELECT request_json FROM provider_invocations WHERE id = $1`, [
        res.body.invocation.id,
      ]),
    );
    expect(rows[0].request_json).toEqual({ task: 'summarize', inputLength: secret.length });
    expect(JSON.stringify(rows[0].request_json)).not.toContain(secret);
  });

  it('POST /api/ai/complete without ai:process and a no-perm user returns 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/complete')
      .set(bearer(nopermToken))
      .send({ task: 'summarize', input: 'x' });
    expect(res.status).toBe(403);
  });

  // --- list + dataScope (plan §6.4) ---

  it('sales (scope=own) runs OCR over its own file', async () => {
    salesFileId = await uploadAs(salesToken);
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(salesToken))
      .send({ fileId: salesFileId, docType: 'order' });
    expect(res.status).toBe(201);
    expect(res.body.invocation.status).toBe('success');
  });

  it('sales (scope=own) cannot OCR the admin file -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/ai/ocr')
      .set(bearer(salesToken))
      .send({ fileId: adminFileId });
    expect(res.status).toBe(404);
  });

  it('admin (scope=all) lists OCR invocations including the sales one', async () => {
    const res = await request(app.getHttpServer()).get('/api/ai/ocr').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const fileIds = res.body.data.map((i: { sourceFileId: string }) => i.sourceFileId);
    expect(fileIds).toContain(adminFileId);
    expect(fileIds).toContain(salesFileId);
    // List must only contain ocr-type invocations.
    expect(res.body.data.every((i: { providerType: string }) => i.providerType === 'ocr')).toBe(
      true,
    );
  });

  it('sales (scope=own) lists only its own OCR invocations', async () => {
    const res = await request(app.getHttpServer()).get('/api/ai/ocr').set(bearer(salesToken));
    expect(res.status).toBe(200);
    const fileIds = res.body.data.map((i: { sourceFileId: string }) => i.sourceFileId);
    expect(fileIds).toContain(salesFileId);
    expect(fileIds).not.toContain(adminFileId);
  });

  it('getOne: sales cannot read the admin OCR invocation (scope=own) -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/ai/ocr/${adminOcrId}`)
      .set(bearer(salesToken));
    expect(res.status).toBe(404);
  });

  it('getOne: tenant2 cannot read a tenant1 invocation (RLS) -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/ai/ocr/${adminOcrId}`)
      .set(bearer(tenant2Token));
    expect(res.status).toBe(404);
  });

  it('GET /api/ai/ocr/:id returns the summary for an in-scope invocation', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/ai/ocr/${adminOcrId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(adminOcrId);
    expect(res.body.providerType).toBe('ocr');
  });

  // --- audit chain integrity ---

  it('audit chain is intact after ai/ocr operations', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });
});
