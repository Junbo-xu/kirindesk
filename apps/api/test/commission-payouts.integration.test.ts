import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { closePool } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import {
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_TENANT2_ID,
  TEST_TENANT2_SLUG,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  TEST_USER2_ID,
  TEST_USER2_EMAIL,
  TEST_USER3_ID,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_PASSWORD,
} from './fixtures';

const { Client } = pg;

// Phase 1F-F: commission payout / disbursement. Boots the real Nest app with
// the same global ValidationPipe as src/main.ts. Role matrix (from fixtures):
//   admin  (TEST_USER)  -> all commission perms at scope ALL
//   sales  (TEST_USER2) -> all commission perms at scope OWN  (own-only reads)
//   noperm (TEST_USER4) -> no roles (401/403 gate)
//   t2admin(TEST_USER3) -> tenant2 admin (cross-tenant isolation)
//
// Settlements are seeded directly via the admin (superuser) connection — the
// payout layer is what's under test; building the order->settlement chain is
// 1F-E's concern. Each seeded settlement is `locked` with two lines:
//   sales (TEST_USER2): 600.00, admin (TEST_USER): 400.00  => total 1000.00
describe('Commission Payouts (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string;
  let salesToken: string;
  let nopermToken: string;
  let tenant2Token: string;

  let seq = 0;

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

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // Seeds a locked settlement + table + two lines in the given tenant and
  // returns the settlement id. Amounts: sales 600.00, owner-user 400.00.
  async function seedLockedSettlement(
    tenantId: string,
    lockedBy: string,
    salesUserId: string,
    ownerUserId: string,
  ): Promise<string> {
    seq += 1;
    return withAdmin(async (c) => {
      const table = await c.query<{ id: string }>(
        `INSERT INTO commission_tables (tenant_id, name, default_rate, status, created_by)
         VALUES ($1, $2, 5.0, 'active', $3) RETURNING id`,
        [tenantId, `T-${seq}`, lockedBy],
      );
      const tableId = table.rows[0].id;
      const settlement = await c.query<{ id: string }>(
        `INSERT INTO commission_settlements
           (tenant_id, commission_table_id, period_start, period_end, caliber, status,
            snapshot, total_commission_base, total_basis_base, uncosted_count, locked_by)
         VALUES ($1, $2, '2026-01-01', '2026-03-31', 'realized', 'locked',
                 '{}'::jsonb, 1000.00, 20000.00, 0, $3) RETURNING id`,
        [tenantId, tableId, lockedBy],
      );
      const settlementId = settlement.rows[0].id;
      await c.query(
        `INSERT INTO commission_settlement_lines
           (tenant_id, settlement_id, salesperson_user_id, basis_base, rate_applied, commission_base)
         VALUES ($1, $2, $3, 12000.00, 5.0, 600.00),
                ($1, $2, $4, 8000.00, 5.0, 400.00)`,
        [tenantId, settlementId, salesUserId, ownerUserId],
      );
      return settlementId;
    });
  }

  // Marks a settlement unlocked-by-supersede so it is no longer current-locked.
  async function supersede(settlementId: string, tenantId: string): Promise<void> {
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO commission_settlements
           (tenant_id, commission_table_id, period_start, period_end, caliber, status,
            snapshot, total_commission_base, total_basis_base, uncosted_count,
            locked_by, unlocked_by, unlocked_at, supersedes)
         SELECT tenant_id, commission_table_id, period_start, period_end, caliber, 'unlocked',
                snapshot, total_commission_base, total_basis_base, uncosted_count,
                locked_by, locked_by, now(), id
           FROM commission_settlements WHERE id = $1`,
        [settlementId],
      );
    });
    void tenantId;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // --- auth + permission gates ---

  it('list payouts with no token -> 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/commission/payouts');
    expect(res.status).toBe(401);
  });

  it('create payout without commission_payouts:disburse -> 403', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const res = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(nopermToken))
      .send({ settlementId: sId });
    expect(res.status).toBe(403);
  });

  // --- create: copy + only-locked + idempotency ---

  it('admin creates a payout from a locked settlement -> 201, amounts copied', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const res = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.totalPayoutBase).toBe('1000.00');
    expect(res.body.currency).toBe('RMB');
    expect(res.body.lines).toHaveLength(2);
    const amounts = res.body.lines.map((l: { amountBase: string }) => l.amountBase).sort();
    expect(amounts).toEqual(['400.00', '600.00']);
    expect(res.body.lines.every((l: { status: string }) => l.status === 'pending')).toBe(true);
  });

  it('creating a second payout for the same settlement is idempotent -> 200, same id', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const first = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    expect(first.status).toBe(201);
    const second = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);

    // Exactly one live payout row exists for the settlement.
    const count = await withAdmin((c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM commission_payouts WHERE settlement_id = $1`,
        [sId],
      ),
    );
    expect(count.rows[0].n).toBe('1');
  });

  it('creating a payout against a non-current-locked settlement -> 409', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    await supersede(sId, TEST_TENANT_ID);
    const res = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    expect(res.status).toBe(409);
  });

  it('creating a payout for an unknown settlement -> 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: '99999999-9999-4999-8999-999999999999' });
    expect(res.status).toBe(404);
  });

  // --- frozen amounts (DB trigger, plan §3 D7 / §8.1) ---

  it('the disbursed amount columns are immutable (trigger blocks UPDATE)', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const created = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    const payoutId = created.body.id as string;

    await expect(
      withAdmin((c) =>
        c.query(`UPDATE commission_payouts SET total_payout_base = 1.00 WHERE id = $1`, [payoutId]),
      ),
    ).rejects.toThrow(/immutable/);

    await expect(
      withAdmin((c) =>
        c.query(`UPDATE commission_payout_lines SET amount_base = 1.00 WHERE payout_id = $1`, [
          payoutId,
        ]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  // --- lifecycle: pay line, pay batch, illegal transitions ---

  it('pay a single line -> line paid, batch stays open (no auto-close)', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const created = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    const payoutId = created.body.id as string;
    const lineId = created.body.lines[0].id as string;

    const paid = await request(app.getHttpServer())
      .post(`/api/commission/payouts/${payoutId}/lines/${lineId}/pay`)
      .set(bearer(adminToken));
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('open');
    const line = paid.body.lines.find((l: { id: string }) => l.id === lineId);
    expect(line.status).toBe('paid');
    expect(line.paidAt).not.toBeNull();
  });

  it('pay the batch -> batch paid, all lines swept to paid, date/ref captured', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const created = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    const payoutId = created.body.id as string;

    const res = await request(app.getHttpServer())
      .post(`/api/commission/payouts/${payoutId}/pay`)
      .set(bearer(adminToken))
      .send({ payoutDate: '2026-04-02', externalRef: 'BANK-001' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(res.body.payoutDate).toBe('2026-04-02');
    expect(res.body.externalRef).toBe('BANK-001');
    expect(res.body.lines.every((l: { status: string }) => l.status === 'paid')).toBe(true);

    // Re-paying a paid batch -> 409.
    const again = await request(app.getHttpServer())
      .post(`/api/commission/payouts/${payoutId}/pay`)
      .set(bearer(adminToken))
      .send({ payoutDate: '2026-04-03' });
    expect(again.status).toBe(409);
  });

  it('pay the batch without payoutDate -> 400', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const created = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    const res = await request(app.getHttpServer())
      .post(`/api/commission/payouts/${created.body.id}/pay`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  // --- void / reverse + separation of duties ---

  it('void a paid batch -> all void; settlement freed for a new payout', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const created = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    const payoutId = created.body.id as string;
    await request(app.getHttpServer())
      .post(`/api/commission/payouts/${payoutId}/pay`)
      .set(bearer(adminToken))
      .send({ payoutDate: '2026-04-02' });

    const voided = await request(app.getHttpServer())
      .post(`/api/commission/payouts/${payoutId}/void`)
      .set(bearer(adminToken))
      .send({ reason: 'bank transfer bounced' });
    expect(voided.status).toBe(200);
    expect(voided.body.status).toBe('void');
    expect(voided.body.lines.every((l: { status: string }) => l.status === 'void')).toBe(true);

    // Re-voiding -> 409.
    const again = await request(app.getHttpServer())
      .post(`/api/commission/payouts/${payoutId}/void`)
      .set(bearer(adminToken))
      .send({ reason: 'again' });
    expect(again.status).toBe(409);

    // The settlement is now free to receive a fresh payout.
    const recreated = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    expect(recreated.status).toBe(201);
    expect(recreated.body.id).not.toBe(payoutId);
  });

  it('void without a reason -> 400', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const created = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    const res = await request(app.getHttpServer())
      .post(`/api/commission/payouts/${created.body.id}/void`)
      .set(bearer(adminToken))
      .send({});
    expect(res.status).toBe(400);
  });

  // --- dataScope: own-scope sees only own line; narrowing != 403 ---

  it('own-scope salesperson sees only their own line in a batch', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const created = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    const payoutId = created.body.id as string;

    // sales (own-scope) has a line (TEST_USER2) -> can see the batch, one line.
    const salesView = await request(app.getHttpServer())
      .get(`/api/commission/payouts/${payoutId}`)
      .set(bearer(salesToken));
    expect(salesView.status).toBe(200);
    expect(salesView.body.lines).toHaveLength(1);
    expect(salesView.body.lines[0].salespersonUserId).toBe(TEST_USER2_ID);

    // admin (all-scope) sees both lines.
    const adminView = await request(app.getHttpServer())
      .get(`/api/commission/payouts/${payoutId}`)
      .set(bearer(adminToken));
    expect(adminView.body.lines).toHaveLength(2);
  });

  it('own-scope salesperson list is scoped, not 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/commission/payouts')
      .set(bearer(salesToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // --- cross-tenant isolation (RLS) ---

  it('tenant2 admin cannot see or pay a tenant1 payout -> 404', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const created = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(adminToken))
      .send({ settlementId: sId });
    const payoutId = created.body.id as string;

    const view = await request(app.getHttpServer())
      .get(`/api/commission/payouts/${payoutId}`)
      .set(bearer(tenant2Token));
    expect(view.status).toBe(404);

    const pay = await request(app.getHttpServer())
      .post(`/api/commission/payouts/${payoutId}/pay`)
      .set(bearer(tenant2Token))
      .send({ payoutDate: '2026-04-02' });
    expect(pay.status).toBe(404);
  });

  it('tenant2 admin cannot create a payout from a tenant1 settlement -> 404', async () => {
    const sId = await seedLockedSettlement(
      TEST_TENANT_ID,
      TEST_USER_ID,
      TEST_USER2_ID,
      TEST_USER_ID,
    );
    const res = await request(app.getHttpServer())
      .post('/api/commission/payouts')
      .set(bearer(tenant2Token))
      .send({ settlementId: sId });
    expect(res.status).toBe(404);
    void TEST_TENANT2_ID;
    void TEST_USER3_ID;
  });
});
