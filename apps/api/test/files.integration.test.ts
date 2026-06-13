import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
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
  TEST_USER_ID,
  TEST_USER_EMAIL,
  TEST_USER2_EMAIL,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
} from './fixtures';

const PDF = Buffer.from('%PDF-1.4 fake pdf bytes for testing');

describe('Files API (integration)', () => {
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

  beforeAll(async () => {
    storage = new FakeStorageProvider();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Swap the real S3 provider for the in-memory fake so the suite is
      // hermetic (no MinIO dependency in CI).
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

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // Files created during the run; ids shared across ordered tests.
  let adminFileId: string; // uploaded by admin
  let salesFileId: string; // uploaded by sales (scope=own)

  // --- auth + permission gates ---

  it('GET /api/files with no token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/files');
    expect(res.status).toBe(401);
  });

  it('GET /api/files with a platform token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/files').set(bearer(platformToken));
    expect(res.status).toBe(401);
  });

  it('GET /api/files with a tenant user lacking permission returns 403', async () => {
    const res = await request(app.getHttpServer()).get('/api/files').set(bearer(nopermToken));
    expect(res.status).toBe(403);
  });

  it('POST /api/files with no permission returns 403', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(nopermToken))
      .attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(403);
  });

  // --- upload ---

  it('admin uploads a PDF -> 201, sha256 computed, bytes in storage', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(adminToken))
      .field('purpose', 'pi')
      .attach('file', PDF, { filename: 'invoice.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.original_name).toBe('invoice.pdf');
    expect(res.body.mime_type).toBe('application/pdf');
    expect(res.body.size_bytes).toBe(String(PDF.length));
    expect(res.body.purpose).toBe('pi');
    expect(res.body.uploaded_by).toBe(TEST_USER_ID);
    // sha256 is present and 64 hex chars
    expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    // storage_key must NOT be exposed in the response
    expect(res.body.storage_key).toBeUndefined();
    expect(res.body.tenant_id).toBeUndefined();
    adminFileId = res.body.id;
    // bytes actually landed in (fake) storage
    expect(storage.objects.size).toBeGreaterThan(0);
  });

  it('upload with no file part returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(adminToken))
      .field('purpose', 'pi');
    expect(res.status).toBe(400);
  });

  it('upload of a disallowed MIME type returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(adminToken))
      .attach('file', Buffer.from('#!/bin/sh\necho hi'), {
        filename: 'evil.sh',
        contentType: 'application/x-sh',
      });
    expect(res.status).toBe(400);
  });

  it('sales (scope=own) uploads a file', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(salesToken))
      .attach('file', PDF, { filename: 'sales.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    salesFileId = res.body.id;
  });

  // --- list + dataScope ---

  it('admin (scope=all) lists both files', async () => {
    const res = await request(app.getHttpServer()).get('/api/files').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((f: { id: string }) => f.id);
    expect(ids).toContain(adminFileId);
    expect(ids).toContain(salesFileId);
  });

  it('sales (scope=own) lists only its own file', async () => {
    const res = await request(app.getHttpServer()).get('/api/files').set(bearer(salesToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.map((f: { id: string }) => f.id);
    expect(ids).toContain(salesFileId);
    expect(ids).not.toContain(adminFileId);
  });

  it('list filters by purpose', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/files?purpose=pi')
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.every((f: { purpose: string }) => f.purpose === 'pi')).toBe(true);
  });

  it('list searches by original_name', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/files?q=invoice')
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.some((f: { id: string }) => f.id === adminFileId)).toBe(true);
  });

  // --- getOne + scope/tenant isolation ---

  it('sales cannot getOne admin file (scope=own) -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/files/${adminFileId}`)
      .set(bearer(salesToken));
    expect(res.status).toBe(404);
  });

  it('tenant2 cannot getOne tenant1 file (RLS) -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/files/${adminFileId}`)
      .set(bearer(tenant2Token));
    expect(res.status).toBe(404);
  });

  // --- download token + public download ---

  it('admin mints a download token, then downloads the bytes', async () => {
    const tok = await request(app.getHttpServer())
      .post(`/api/files/${adminFileId}/token`)
      .set(bearer(adminToken));
    expect(tok.status).toBe(201);
    expect(typeof tok.body.token).toBe('string');
    expect(tok.body.token.length).toBeGreaterThanOrEqual(64);

    const dl = await request(app.getHttpServer()).get(
      `/api/files/download?token=${tok.body.token}`,
    );
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['content-disposition']).toContain('invoice.pdf');
    expect(Buffer.from(dl.body).equals(PDF)).toBe(true);
  });

  it('a download token is single-use (second use -> 404)', async () => {
    const tok = await request(app.getHttpServer())
      .post(`/api/files/${adminFileId}/token`)
      .set(bearer(adminToken));
    const t = tok.body.token;
    const first = await request(app.getHttpServer()).get(`/api/files/download?token=${t}`);
    expect(first.status).toBe(200);
    const second = await request(app.getHttpServer()).get(`/api/files/download?token=${t}`);
    expect(second.status).toBe(404);
  });

  it('a bogus token -> 404', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/files/download?token=${'a'.repeat(64)}`,
    );
    expect(res.status).toBe(404);
  });

  it('download with no token -> 404', async () => {
    const res = await request(app.getHttpServer()).get('/api/files/download');
    expect(res.status).toBe(404);
  });

  it('sales cannot mint a token for admin file (scope=own) -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/files/${adminFileId}/token`)
      .set(bearer(salesToken));
    expect(res.status).toBe(404);
  });

  // --- delete ---

  it('sales cannot delete admin file (scope=own) -> 404', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/api/files/${adminFileId}`)
      .set(bearer(salesToken));
    expect(res.status).toBe(404);
  });

  it('admin soft-deletes its file -> 200, then it is gone from list', async () => {
    const del = await request(app.getHttpServer())
      .delete(`/api/files/${adminFileId}`)
      .set(bearer(adminToken));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ id: adminFileId, deleted: true });

    const res = await request(app.getHttpServer()).get('/api/files').set(bearer(adminToken));
    const ids = res.body.data.map((f: { id: string }) => f.id);
    expect(ids).not.toContain(adminFileId);
  });

  it('getOne a soft-deleted file -> 404', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/files/${adminFileId}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(404);
  });

  // --- audit chain integrity ---

  it('audit chain is intact after file operations', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });
});
