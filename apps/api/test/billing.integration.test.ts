import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { closePool } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import { MockPaymentProvider } from '../src/billing/mock-payment-provider';
import {
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_TENANT2_SLUG,
  TEST_USER_EMAIL,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
} from './fixtures';

// Phase 2A billing integration tests (plan §6): amount accuracy, idempotent
// issue, double-pay rejection, provider-failure-does-not-pollute, cross-tenant.

describe('Billing API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let tenant2Token: string;
  let noPermToken: string;
  let platformToken: string;

  const { Client } = pg;
  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: process.env['DATABASE_URL'] });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function login(email: string, slug: string): Promise<string> {
    const r = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: slug });
    expect(r.status).toBe(200);
    return r.body.accessToken as string;
  }

  // Issues an invoice for tenant1 via the platform endpoint; returns the body.
  async function issueForTenant1(period?: 'monthly' | 'yearly') {
    const r = await request(app.getHttpServer())
      .post(`/api/platform/tenants/${TEST_TENANT_ID}/invoices`)
      .set(bearer(platformToken))
      .send(period ? { billingPeriod: period } : {});
    return r;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);

    adminToken = await login(TEST_USER_EMAIL, TEST_TENANT_SLUG);
    tenant2Token = await login(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);
    noPermToken = await login(TEST_USER4_EMAIL, TEST_TENANT_SLUG);

    const plat = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });
    expect(plat.status).toBe(200);
    platformToken = plat.body.accessToken as string;
  });

  afterEach(async () => {
    MockPaymentProvider.reset();
    // Remove all billing rows from both test tenants (payments before invoices,
    // FK order). RLS does not apply to the admin connection.
    await withAdmin(async (c) => {
      await c.query(`DELETE FROM billing_payments`);
      await c.query(`DELETE FROM billing_invoices`);
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // ── 1. issue: amount matches the plan price, currency derived server-side ──
  it('issues an invoice whose amount equals the tenant plan price', async () => {
    const expected = await withAdmin(async (c) => {
      const { rows } = await c.query<{ price_monthly: string; currency: string }>(
        `SELECT p.price_monthly::text AS price_monthly, p.currency
           FROM tenants t
           JOIN plans p ON p.id = COALESCE(t.plan_id, 'b0000000-0000-0000-0000-000000000002')
          WHERE t.id = $1`,
        [TEST_TENANT_ID],
      );
      return rows[0];
    });

    const res = await issueForTenant1('monthly');
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(Number(expected.price_monthly).toFixed(2));
    expect(res.body.currency).toBe(expected.currency);
    expect(res.body.status).toBe('pending');
    expect(res.body.billingPeriod).toBe('monthly');
  });

  // ── 2. issue is idempotent per open period (no double-billing) ─────────────
  it('returns the same pending invoice on a repeated issue (200, idempotent)', async () => {
    const first = await issueForTenant1('monthly');
    expect(first.status).toBe(201);
    const second = await issueForTenant1('monthly');
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);

    const list = await request(app.getHttpServer())
      .get('/api/billing/invoices')
      .set(bearer(adminToken));
    expect(list.body.total).toBe(1);
  });

  // ── 3. pay success → paid + immutable succeeded payment row ────────────────
  it('pays a pending invoice: invoice→paid and one succeeded payment recorded', async () => {
    const issued = await issueForTenant1('monthly');
    const id = issued.body.id as string;

    const pay = await request(app.getHttpServer())
      .post(`/api/billing/invoices/${id}/pay`)
      .set(bearer(adminToken));
    expect(pay.status).toBe(200);
    expect(pay.body.status).toBe('paid');
    expect(pay.body.paidAt).not.toBeNull();

    await withAdmin(async (c) => {
      const { rows } = await c.query(
        `SELECT status, provider, provider_ref, amount_cents::text AS amount_cents
           FROM billing_payments WHERE invoice_id = $1`,
        [id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('succeeded');
      expect(rows[0].provider).toBe('mock');
      expect(rows[0].provider_ref).toContain('MOCK-PAY-');
    });
  });

  // ── 4. double-pay is rejected (409) and no second payment row ──────────────
  it('rejects paying an already-paid invoice with 409', async () => {
    const issued = await issueForTenant1('monthly');
    const id = issued.body.id as string;

    const first = await request(app.getHttpServer())
      .post(`/api/billing/invoices/${id}/pay`)
      .set(bearer(adminToken));
    expect(first.status).toBe(200);

    const second = await request(app.getHttpServer())
      .post(`/api/billing/invoices/${id}/pay`)
      .set(bearer(adminToken));
    expect(second.status).toBe(409);

    await withAdmin(async (c) => {
      const { rows } = await c.query(
        `SELECT COUNT(*)::int AS n FROM billing_payments WHERE invoice_id = $1`,
        [id],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  // ── 5. provider failure → 502, invoice stays pending, failed row recorded ──
  it('provider failure does not pollute invoice state (stays pending, failed payment)', async () => {
    const issued = await issueForTenant1('monthly');
    const id = issued.body.id as string;

    MockPaymentProvider.failNext = true;
    const pay = await request(app.getHttpServer())
      .post(`/api/billing/invoices/${id}/pay`)
      .set(bearer(adminToken));
    expect(pay.status).toBe(502);

    // Invoice unchanged.
    const get = await request(app.getHttpServer())
      .get(`/api/billing/invoices/${id}`)
      .set(bearer(adminToken));
    expect(get.body.status).toBe('pending');
    expect(get.body.paidAt).toBeNull();

    // A failed payment row exists; no succeeded row.
    await withAdmin(async (c) => {
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM billing_payments WHERE invoice_id = $1`,
        [id],
      );
      expect(rows.map((r) => r.status)).toEqual(['failed']);
    });

    // Retry now succeeds — the invoice was payable throughout.
    const retry = await request(app.getHttpServer())
      .post(`/api/billing/invoices/${id}/pay`)
      .set(bearer(adminToken));
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('paid');
  });

  // ── 6. cross-tenant isolation: tenant2 cannot see/pay tenant1's invoice ────
  it('isolates invoices across tenants (opaque 404)', async () => {
    const issued = await issueForTenant1('monthly');
    const id = issued.body.id as string;

    const get = await request(app.getHttpServer())
      .get(`/api/billing/invoices/${id}`)
      .set(bearer(tenant2Token));
    expect(get.status).toBe(404);

    const pay = await request(app.getHttpServer())
      .post(`/api/billing/invoices/${id}/pay`)
      .set(bearer(tenant2Token));
    expect(pay.status).toBe(404);

    const list = await request(app.getHttpServer())
      .get('/api/billing/invoices')
      .set(bearer(tenant2Token));
    expect(list.body.total).toBe(0);
  });

  // ── 7. RBAC: 401 without token, 403 without billing perms ──────────────────
  it('returns 401 without a token', async () => {
    const r = await request(app.getHttpServer()).get('/api/billing/invoices');
    expect(r.status).toBe(401);
  });

  it('returns 403 for a user without billing:view', async () => {
    const r = await request(app.getHttpServer())
      .get('/api/billing/invoices')
      .set(bearer(noPermToken));
    expect(r.status).toBe(403);
  });

  // ── 8. platform issue requires platform token (tenant token → 401) ─────────
  it('rejects platform issue with a tenant token (401)', async () => {
    const r = await request(app.getHttpServer())
      .post(`/api/platform/tenants/${TEST_TENANT_ID}/invoices`)
      .set(bearer(adminToken))
      .send({ billingPeriod: 'monthly' });
    expect(r.status).toBe(401);
  });
});
