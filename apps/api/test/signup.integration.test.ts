// Phase 2B self-service signup integration. Enables Redis + a low rate-limit
// max FOR THIS FILE so the 429 path is exercised against real Redis (docker).
// Must be set BEFORE AppModule is imported/constructed so the RedisModule
// factory and the rate-limit guard read them.
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.TRUST_PROXY = 'true';
process.env.SIGNUP_RATE_LIMIT_MAX = '3';
process.env.SIGNUP_RATE_LIMIT_WINDOW_SEC = '60';

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

const FREE_PLAN_ID = 'b0000000-0000-0000-0000-000000000001';

describe('Tenant Self-Service Signup API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
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

  // Unique slug/email/IP per test to avoid cross-run collisions and rate-limit
  // bucket contention (each test gets its own IP bucket).
  let seq = 0;
  function unique() {
    return `${Date.now()}-${++seq}`;
  }
  function validDto(overrides: Record<string, unknown> = {}) {
    const u = unique();
    return {
      tenantName: 'QA Signup Tenant',
      slug: `qa-signup-${u}`,
      ownerEmail: `signup-${u}@qa.local`,
      ownerPassword: 'TestPass123!',
      ownerName: 'QA Signup Owner',
      ...overrides,
    };
  }
  let ipSeq = 0;
  function freshIp(): string {
    return `10.77.${Math.floor(Math.random() * 250)}.${++ipSeq}`;
  }
  function post(dto: Record<string, unknown>, ip: string) {
    return request(app.getHttpServer())
      .post('/api/auth/signup')
      .set('X-Forwarded-For', ip)
      .send(dto);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);
  });

  afterEach(async () => {
    if (createdTenantIds.length === 0) return;
    const ids = [...createdTenantIds];
    createdTenantIds.length = 0;
    await withAdmin(async (c) => {
      for (const id of ids) {
        await c.query(
          `DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`,
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

  // ── Normal signup ─────────────────────────────────────────────────────────

  it('POST /api/auth/signup → 201 with tenant + owner, no password leak', async () => {
    const dto = validDto();
    const res = await post(dto, freshIp());

    expect(res.status).toBe(201);
    expect(res.body.tenant.slug).toBe(dto.slug);
    expect(res.body.tenant.status).toBe('active');
    expect(res.body.owner.email).toBe(dto.ownerEmail);
    expect(res.body.owner.isOwner).toBe(true);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('TestPass');

    createdTenantIds.push(res.body.tenant.id as string);
  });

  it('binds the free plan and marks created_via=self_signup in the DB', async () => {
    const dto = validDto();
    const res = await post(dto, freshIp());
    expect(res.status).toBe(201);
    const tenantId = res.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    await withAdmin(async (c) => {
      const t = await c.query(
        `SELECT plan_id, plan_assigned_at, created_via FROM tenants WHERE id = $1`,
        [tenantId],
      );
      expect(t.rows).toHaveLength(1);
      expect(t.rows[0].plan_id).toBe(FREE_PLAN_ID);
      expect(t.rows[0].plan_assigned_at).not.toBeNull();
      expect(t.rows[0].created_via).toBe('self_signup');
    });
  });

  it('creates the quota_usage genesis row with user_count=1', async () => {
    const dto = validDto();
    const res = await post(dto, freshIp());
    expect(res.status).toBe(201);
    const tenantId = res.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    await withAdmin(async (c) => {
      const q = await c.query(`SELECT user_count FROM tenant_quota_usage WHERE tenant_id = $1`, [
        tenantId,
      ]);
      expect(q.rows).toHaveLength(1);
      expect(Number(q.rows[0].user_count)).toBe(1);
    });
  });

  it('new owner can login immediately', async () => {
    const dto = validDto();
    const res = await post(dto, freshIp());
    expect(res.status).toBe(201);
    createdTenantIds.push(res.body.tenant.id as string);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: dto.ownerEmail, password: dto.ownerPassword, tenantSlug: dto.slug });
    expect(login.status).toBe(200);
    expect(typeof login.body.accessToken).toBe('string');
    expect(login.body.accessToken.length).toBeGreaterThan(10);
  });

  it('audits tenant.created as tenant_user with createdVia, no password; chain verifies', async () => {
    const dto = validDto();
    const res = await post(dto, freshIp());
    expect(res.status).toBe(201);
    const tenantId = res.body.tenant.id as string;
    createdTenantIds.push(tenantId);

    await withAdmin(async (c) => {
      const audit = await c.query(
        `SELECT actor_type, actor_id, metadata_json::text AS meta
           FROM audit_logs WHERE tenant_id = $1 AND action = 'tenant.created'`,
        [tenantId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_type).toBe('tenant_user');
      expect(audit.rows[0].actor_id).toBe(res.body.owner.id);
      expect(audit.rows[0].meta).toContain('self_signup');
      expect(audit.rows[0].meta).toContain(dto.ownerEmail);
      expect(audit.rows[0].meta).not.toContain('password');
      expect(audit.rows[0].meta).not.toContain('TestPass');
    });

    const result = await verifyChain(`tenant:${tenantId}`);
    expect(result.ok).toBe(true);
  });

  // ── Validation / conflict ───────────────────────────────────────────────

  it('duplicate slug → 409, only one tenant row', async () => {
    const dto = validDto();
    const ip = freshIp();
    const first = await post(dto, ip);
    expect(first.status).toBe(201);
    createdTenantIds.push(first.body.tenant.id as string);

    const dup = await post({ ...dto, ownerEmail: `other-${unique()}@qa.local` }, ip);
    expect(dup.status).toBe(409);

    await withAdmin(async (c) => {
      const t = await c.query(`SELECT id FROM tenants WHERE slug = $1`, [dto.slug]);
      expect(t.rows).toHaveLength(1);
    });
  });

  it('invalid email format → 400', async () => {
    const res = await post(validDto({ ownerEmail: 'not-an-email' }), freshIp());
    expect(res.status).toBe(400);
  });

  it('password too short → 400', async () => {
    const res = await post(validDto({ ownerPassword: '1234567' }), freshIp());
    expect(res.status).toBe(400);
  });

  it('uppercase slug → 400', async () => {
    const res = await post(validDto({ slug: 'BadSlug' }), freshIp());
    expect(res.status).toBe(400);
  });

  it('unknown extra field → 400 (forbidNonWhitelisted)', async () => {
    const res = await post(validDto({ hack: 'x' }), freshIp());
    expect(res.status).toBe(400);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  it('rate limits by IP: 4th signup from one IP → 429 with Retry-After', async () => {
    const ip = freshIp(); // dedicated bucket, max=3 for this file
    for (let i = 0; i < 3; i++) {
      const ok = await post(validDto(), ip);
      expect(ok.status).toBe(201);
      createdTenantIds.push(ok.body.tenant.id as string);
    }
    const limited = await post(validDto(), ip);
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a different IP is not affected by another IP hitting the limit', async () => {
    const ipA = freshIp();
    for (let i = 0; i < 3; i++) {
      const ok = await post(validDto(), ipA);
      expect(ok.status).toBe(201);
      createdTenantIds.push(ok.body.tenant.id as string);
    }
    expect((await post(validDto(), ipA)).status).toBe(429);

    // Fresh IP still allowed.
    const other = await post(validDto(), freshIp());
    expect(other.status).toBe(201);
    createdTenantIds.push(other.body.tenant.id as string);
  });
});
