import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { closePool, verifyChain } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import {
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_USER_EMAIL,
  TEST_ADMIN_EMAIL,
  TEST_ADMIN_ID,
  TEST_PASSWORD,
  TEST_TENANT2_ID,
  TEST_USER_ID,
  TEST_USER3_ID,
} from './fixtures';

const { Client } = pg;

describe('Auth smoke + audit (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let tenantToken: string;
  let platformToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    pool = app.get<Pool>(APP_POOL);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('tenant login with correct credentials returns 200 + accessToken', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: TEST_USER_EMAIL, password: TEST_PASSWORD, tenantSlug: TEST_TENANT_SLUG });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    tenantToken = res.body.accessToken;
  });

  it('GET /api/auth/me with tenant token returns 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tenantToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(TEST_USER_EMAIL);
    expect(Object.keys(res.body).sort()).toEqual(['email', 'id', 'permissions', 'tenantId']);
    expect(res.body.permissions['workbench:view']).toBe('all');
  });

  it('platform login with correct credentials returns 200 + accessToken', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    platformToken = res.body.accessToken;
  });

  it('GET /api/platform-auth/me with platform token returns 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/platform-auth/me')
      .set('Authorization', `Bearer ${platformToken}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(TEST_ADMIN_EMAIL);
    expect(Object.keys(res.body).sort()).toEqual(['email', 'id']);
  });

  it('tenant token cannot access platform /me (401)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/platform-auth/me')
      .set('Authorization', `Bearer ${tenantToken}`);
    expect(res.status).toBe(401);
  });

  it('platform token cannot access tenant /me (401)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${platformToken}`);
    expect(res.status).toBe(401);
  });

  it('tenant logout revokes the server-side session immediately', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '2001:db8::100')
      .send({ email: TEST_USER_EMAIL, password: TEST_PASSWORD, tenantSlug: TEST_TENANT_SLUG });
    expect(login.status).toBe(200);

    const token = login.body.accessToken as string;
    const logout = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(200);

    const after = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it('platform logout revokes the server-side session immediately', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .set('X-Forwarded-For', '2001:db8::101')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    const token = login.body.accessToken as string;
    const logout = await request(app.getHttpServer())
      .post('/api/platform-auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(200);

    const after = await request(app.getHttpServer())
      .get('/api/platform-auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it('an active token becomes invalid immediately when the account is disabled', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '2001:db8::102')
      .send({ email: TEST_USER_EMAIL, password: TEST_PASSWORD, tenantSlug: TEST_TENANT_SLUG });
    expect(login.status).toBe(200);

    await withAdmin((client) =>
      client.query(`UPDATE users SET status = 'inactive' WHERE id = $1`, [TEST_USER_ID]),
    );
    try {
      const after = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken as string}`);
      expect(after.status).toBe(401);
    } finally {
      await withAdmin((client) =>
        client.query(`UPDATE users SET status = 'active' WHERE id = $1`, [TEST_USER_ID]),
      );
    }
  });

  it('an active token becomes invalid immediately when the tenant is disabled', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '2001:db8::104')
      .send({ email: TEST_USER_EMAIL, password: TEST_PASSWORD, tenantSlug: TEST_TENANT_SLUG });
    expect(login.status).toBe(200);

    await withAdmin((client) =>
      client.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [TEST_TENANT_ID]),
    );
    try {
      const after = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken as string}`);
      expect(after.status).toBe(403);
      expect(after.body.message).toBe('租户已停用');
    } finally {
      await withAdmin((client) =>
        client.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TEST_TENANT_ID]),
      );
    }
  });

  it('an active platform token becomes invalid immediately when the admin is disabled', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .set('X-Forwarded-For', '2001:db8::105')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    await withAdmin((client) =>
      client.query(`UPDATE platform_admins SET status = 'inactive' WHERE id = $1`, [TEST_ADMIN_ID]),
    );
    try {
      const after = await request(app.getHttpServer())
        .get('/api/platform-auth/me')
        .set('Authorization', `Bearer ${login.body.accessToken as string}`);
      expect(after.status).toBe(401);
    } finally {
      await withAdmin((client) =>
        client.query(`UPDATE platform_admins SET status = 'active' WHERE id = $1`, [TEST_ADMIN_ID]),
      );
    }
  });

  it('a session id cannot be replayed as another tenant or user', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', '2001:db8::103')
      .send({ email: TEST_USER_EMAIL, password: TEST_PASSWORD, tenantSlug: TEST_TENANT_SLUG });
    expect(login.status).toBe(200);

    const jwt = new JwtService({ secret: process.env.TENANT_JWT_SECRET });
    const original = jwt.decode(login.body.accessToken as string) as { sid: string };
    const forged = jwt.sign(
      {
        sub: TEST_USER3_ID,
        type: 'tenant_user',
        tenantId: TEST_TENANT2_ID,
        email: 'forged@test.local',
        sid: original.sid,
      },
      { expiresIn: '5m' },
    );

    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${forged}`);
    expect(response.status).toBe(401);
  });

  it('tenant login is rate limited by both IP and normalized identity', async () => {
    const previousMax = process.env.LOGIN_RATE_LIMIT_MAX;
    process.env.LOGIN_RATE_LIMIT_MAX = '2';
    const marker = randomUUID();
    const email = `${marker}@missing.test`;
    const ip = `2001:db8::${createHash('sha256').update(marker).digest('hex').slice(0, 4)}`;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await request(app.getHttpServer())
          .post('/api/auth/login')
          .set('X-Forwarded-For', ip)
          .send({ email, password: 'wrong-password', tenantSlug: TEST_TENANT_SLUG });
        expect(response.status).toBe(401);
      }

      const limited = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: 'wrong-password', tenantSlug: TEST_TENANT_SLUG });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      if (previousMax === undefined) {
        delete process.env.LOGIN_RATE_LIMIT_MAX;
      } else {
        process.env.LOGIN_RATE_LIMIT_MAX = previousMax;
      }
    }
  });

  it('tenant login with wrong password returns 401 Invalid credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: TEST_USER_EMAIL, password: 'wrong-password', tenantSlug: TEST_TENANT_SLUG });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('platform login with wrong password returns 401 Invalid credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  // --- audit + chain assertions (run after the smoke tests above) ---

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it('tenant login_success and login_failed are written to audit_logs', async () => {
    const rows = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT action FROM audit_logs WHERE tenant_id = $1 ORDER BY id ASC`,
        [TEST_TENANT_ID],
      );
      return r.rows;
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('auth:login_success');
    expect(actions).toContain('auth:login_failed');
    expect(actions).toContain('auth:login_rate_limited');
  });

  it('platform login_success is written with tenant_id NULL', async () => {
    const row = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT tenant_id FROM audit_logs
         WHERE action = 'auth:login_success' AND actor_type = 'platform_admin'
         ORDER BY id DESC LIMIT 1`,
      );
      return r.rows[0];
    });
    expect(row).toBeDefined();
    expect(row.tenant_id).toBeNull();
  });

  it('tenant and platform chains advanced past genesis', async () => {
    const chains = await withAdmin(async (c) => {
      const r = await c.query(
        `SELECT chain_key, last_log_id, last_hash FROM audit_log_chains
         WHERE chain_key IN ($1, 'platform')`,
        [`tenant:${TEST_TENANT_ID}`],
      );
      return r.rows;
    });
    expect(chains).toHaveLength(2);
    for (const chain of chains) {
      expect(chain.last_log_id).not.toBeNull();
      expect(chain.last_hash).not.toBe('0'.repeat(64));
    }
  });

  it('verifyChain passes for platform and tenant chains', async () => {
    const platform = await verifyChain('platform');
    const tenant = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(platform.ok).toBe(true);
    expect(tenant.ok).toBe(true);
  });
});
