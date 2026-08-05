import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { closePool, verifyChain } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import { TEST_ADMIN_EMAIL, TEST_PASSWORD, TEST_TENANT_SLUG, TEST_USER_EMAIL } from './fixtures';

// Phase 1L tenant onboarding integration (plan §6.2). Covers atomic provision
// (3 rows in one tx), password security (no plaintext in response/audit),
// new owner login + chain verify, error paths (409/400/401), and rollback
// completeness. supertest over real HTTP on kirindesk_test.

describe('Tenant Onboarding API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let platformToken: string;
  const createdTenantIds: string[] = [];

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

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  // Build a unique slug per test to avoid conflicts across runs.
  let seq = 0;
  function slug(): string {
    return `qa-onboard-${Date.now()}-${++seq}`;
  }

  function validDto(overrides: Record<string, unknown> = {}) {
    return {
      name: 'QA New Tenant',
      slug: slug(),
      ownerEmail: `owner-${Date.now()}-${seq}@qa.local`,
      ownerPassword: 'TestPass123!',
      ownerName: 'QA Owner',
      ...overrides,
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);

    const plat = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });
    expect(plat.status).toBe(200);
    platformToken = plat.body.accessToken as string;
  });

  afterEach(async () => {
    // Clean up any tenants created during the test. Done after each to keep
    // the DB tidy for subsequent cases. Uses owner connection (bypasses RLS).
    if (createdTenantIds.length === 0) return;
    const ids = [...createdTenantIds];
    createdTenantIds.length = 0;
    await withAdmin(async (c) => {
      // audit_logs is append-only (trigger 022) — cannot DELETE. Skip it.
      // The test tenant's audit rows are harmless orphans after the tenant is removed.
      for (const id of ids) {
        await c.query(
          `DELETE FROM user_roles WHERE user_id IN
          (SELECT id FROM users WHERE tenant_id = $1)`,
          [id],
        );
        await c.query(`DELETE FROM users WHERE tenant_id = $1`, [id]);
        await c.query(`DELETE FROM audit_log_chains WHERE tenant_id = $1`, [id]);
        await c.query(`DELETE FROM tenant_quota_usage WHERE tenant_id = $1`, [id]);
        await c.query(`DELETE FROM tenant_notification_settings WHERE tenant_id = $1`, [id]);
        await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
      }
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // ── Normal provision ────────────────────────────────────────────────────

  it('POST /api/platform/tenants → 201, response has tenant + owner, no password leak', async () => {
    const dto = validDto();
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(dto);

    expect(res.status).toBe(201);
    expect(res.body.tenant.slug).toBe(dto.slug);
    expect(res.body.tenant.status).toBe('active');
    expect(res.body.owner.email).toBe(dto.ownerEmail);
    expect(res.body.owner.isOwner).toBe(true);

    // password must never appear in the response body
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('TestPass');

    createdTenantIds.push(res.body.tenant.id as string);
  });

  it('all three rows land atomically in the DB', async () => {
    const dto = validDto();
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(dto);
    expect(res.status).toBe(201);
    const tenantId = res.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    await withAdmin(async (c) => {
      // tenants row
      const t = await c.query(`SELECT status, owner_user_id FROM tenants WHERE id = $1`, [
        tenantId,
      ]);
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0].status).toBe('active');
      expect(t.rows[0].owner_user_id).toBe(res.body.owner.id);

      // owner users row
      const u = await c.query(
        `SELECT is_tenant_owner, status FROM users WHERE id = $1 AND tenant_id = $2`,
        [res.body.owner.id, tenantId],
      );
      expect(u.rows).toHaveLength(1);
      expect(u.rows[0].is_tenant_owner).toBe(true);
      expect(u.rows[0].status).toBe('active');

      // genesis audit_log_chains row — last_hash will have advanced after the
      // post-commit audit write; just assert the row exists, not the hash value.
      const ch = await c.query(`SELECT id FROM audit_log_chains WHERE chain_key = $1`, [
        `tenant:${tenantId}`,
      ]);
      expect(ch.rows).toHaveLength(1);
    });
  });

  it('password stored as bcrypt hash, not plaintext', async () => {
    const dto = validDto();
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(dto);
    expect(res.status).toBe(201);
    createdTenantIds.push(res.body.tenant.id as string);

    await withAdmin(async (c) => {
      const u = await c.query(`SELECT password_hash FROM users WHERE id = $1`, [res.body.owner.id]);
      expect(u.rows[0].password_hash).toMatch(/^\$2b\$/);
      expect(u.rows[0].password_hash).not.toBe(dto.ownerPassword);
    });
  });

  it('new owner can login and reach a business endpoint', async () => {
    const dto = validDto();
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(dto);
    expect(res.status).toBe(201);
    createdTenantIds.push(res.body.tenant.id as string);

    // owner login — proves password correct + slug/status active
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: dto.ownerEmail, password: dto.ownerPassword, tenantSlug: dto.slug });
    expect(login.status).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');
    expect(login.body.accessToken.length).toBeGreaterThan(10);

    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set(bearer(login.body.accessToken as string));
    expect(me.status).toBe(200);
    expect(me.body.permissions).toEqual(
      expect.objectContaining({
        'inquiries:view': 'all',
        'quotations:manage': 'all',
        'finance_reviews:review': 'all',
        'after_sales:execute': 'all',
      }),
    );
  });

  it('audit_log_chains supports verify-chain from genesis', async () => {
    const dto = validDto();
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(dto);
    expect(res.status).toBe(201);
    const tenantId = res.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    const result = await verifyChain(`tenant:${tenantId}`);
    expect(result.ok).toBe(true);
  });

  it('audit logs tenant.created with platform_admin actor, no password in metadata', async () => {
    const dto = validDto();
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(dto);
    expect(res.status).toBe(201);
    const tenantId = res.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    await withAdmin(async (c) => {
      const audit = await c.query(
        `SELECT action, actor_type, metadata_json::text AS meta
           FROM audit_logs WHERE tenant_id = $1 AND action = 'tenant.created'`,
        [tenantId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_type).toBe('platform_admin');
      expect(audit.rows[0].meta).toContain(dto.slug);
      expect(audit.rows[0].meta).toContain(dto.ownerEmail);
      expect(audit.rows[0].meta).not.toContain('password');
      expect(audit.rows[0].meta).not.toContain('TestPass');
    });
  });

  // ── Error paths ─────────────────────────────────────────────────────────

  it('slug conflict → 409, no new rows in DB (rollback)', async () => {
    const dto = validDto();
    // First provision succeeds
    const first = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(dto);
    expect(first.status).toBe(201);
    createdTenantIds.push(first.body.tenant.id as string);

    // Same slug again → 409
    const dup = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send({ ...dto, ownerEmail: `other-${Date.now()}@qa.local` });
    expect(dup.status).toBe(409);

    // DB: still only one tenants row for that slug
    await withAdmin(async (c) => {
      const t = await c.query(`SELECT id FROM tenants WHERE slug = $1`, [dto.slug]);
      expect(t.rows).toHaveLength(1);
    });
  });

  it('slug with uppercase → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(validDto({ slug: 'BadSlug' }));
    expect(res.status).toBe(400);
  });

  it('slug starting with hyphen → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(validDto({ slug: '-bad-start' }));
    expect(res.status).toBe(400);
  });

  it('ownerPassword too short → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(validDto({ ownerPassword: '1234567' }));
    expect(res.status).toBe(400);
  });

  it('ownerEmail invalid → 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(validDto({ ownerEmail: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('missing required field (name) → 400', async () => {
    const dto = validDto();
    const { name: _, ...withoutName } = dto;
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(withoutName);
    expect(res.status).toBe(400);
  });

  it('unknown extra field → 400 (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(platformToken))
      .send(validDto({ extraField: 'hack' }));
    expect(res.status).toBe(400);
  });

  it('tenant token on provision endpoint → 401', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: TEST_USER_EMAIL, password: TEST_PASSWORD, tenantSlug: TEST_TENANT_SLUG });
    const tenantToken = login.body.accessToken as string;

    const res = await request(app.getHttpServer())
      .post('/api/platform/tenants')
      .set(bearer(tenantToken))
      .send(validDto());
    expect(res.status).toBe(401);
  });

  it('no token on provision endpoint → 401', async () => {
    const res = await request(app.getHttpServer()).post('/api/platform/tenants').send(validDto());
    expect(res.status).toBe(401);
  });
});
