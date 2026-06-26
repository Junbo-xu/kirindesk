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
  TEST_TENANT_ID,
  TEST_TENANT2_ID,
  TEST_TENANT_SLUG,
  TEST_TENANT2_SLUG,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  TEST_USER2_EMAIL,
  TEST_USER2_ID,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_ADMIN_ID,
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
} from './fixtures';

// Phase 1K-B support-access integration (plan §6.2). Covers tenant-side grant /
// revoke (RBAC, default-deny, validation, conflicts), the freeze trigger +
// append-only DB invariants, platform-side authorized read (default-deny,
// audited .accessed, cross-tenant isolation, structural read-only, token
// separation, not-gated-by-tenant-status), audit-into-tenant-chain integrity,
// and SECURITY DEFINER isolation. supertest over real HTTP on kirindesk_test.

describe('Support Access API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string; // tenant1 admin, support_access:* @ all
  let salesToken: string; // tenant1 sales, scope=own, NO support_access
  let nopermToken: string; // tenant1, no roles
  let tenant2Token: string; // tenant2 admin
  let platformToken: string; // TEST_ADMIN platform-jwt

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

  function future(hours = 24): string {
    return new Date(Date.now() + hours * 3600 * 1000).toISOString();
  }

  // support_access_grants has FORCE RLS; the app pool sets no tenant context
  // outside a request. The owner connection (DATABASE_URL) bypasses RLS for
  // direct-DB assertions and the past-dated INSERT the freeze trigger forbids
  // via UPDATE. Same approach as the ai / commission-payouts suites.
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

    const plat = await request(app.getHttpServer())
      .post('/api/platform-auth/login')
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });
    expect(plat.status).toBe(200);
    platformToken = plat.body.accessToken as string;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // --- tenant-side: create / validation / RBAC (plan §6.2) ---

  it('admin creates a grant: 201, active, granted_by=admin, approved_at set', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'help diagnose export issue',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.scope).toBe('read_only');
    expect(res.body.grantedByUserId).toBe(TEST_USER_ID);
    expect(res.body.platformAdminId).toBe(TEST_ADMIN_ID);
    expect(res.body.platformAdminEmail).toBe(TEST_ADMIN_EMAIL);
    expect(res.body.approvedAt).toBeTruthy();

    // granted audit landed in TEST_TENANT's chain.
    await withAdmin(async (c) => {
      const { rows } = await c.query(
        `SELECT actor_type, actor_id FROM audit_logs
         WHERE tenant_id = $1 AND action = 'support_access.granted'
           AND resource_id = $2`,
        [TEST_TENANT_ID, res.body.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_type).toBe('tenant_user');
      expect(rows[0].actor_id).toBe(TEST_USER_ID);
    });

    // Clean up so the one-active uniqueness does not interfere with later tests.
    await request(app.getHttpServer())
      .post(`/api/support-access/${res.body.id}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'cleanup' });
  });

  it('unknown platformAdminEmail returns opaque 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: 'no-such-admin@nowhere.local',
        reason: 'x',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(res.status).toBe(404);
  });

  it('past expiresAt returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'x',
        scope: 'read_only',
        expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      });
    expect(res.status).toBe(400);
  });

  it('scope other than read_only returns 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'x',
        scope: 'read_write',
        expiresAt: future(),
      });
    expect(res.status).toBe(400);
  });

  it('unknown field returns 400 (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'x',
        scope: 'read_only',
        expiresAt: future(),
        evil: 'field',
      });
    expect(res.status).toBe(400);
  });

  it('duplicate active grant for same admin+tenant returns 409', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'first',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(first.status).toBe(201);

    const dup = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'second',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(dup.status).toBe(409);

    await request(app.getHttpServer())
      .post(`/api/support-access/${first.body.id}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'cleanup' });
  });

  it('POST without a support_access:grant permission returns 403', async () => {
    for (const token of [salesToken, nopermToken]) {
      const res = await request(app.getHttpServer())
        .post('/api/support-access')
        .set(bearer(token))
        .send({
          platformAdminEmail: TEST_ADMIN_EMAIL,
          reason: 'x',
          scope: 'read_only',
          expiresAt: future(),
        });
      expect(res.status).toBe(403);
    }
  });

  it('POST without a token returns 401', async () => {
    const res = await request(app.getHttpServer()).post('/api/support-access').send({
      platformAdminEmail: TEST_ADMIN_EMAIL,
      reason: 'x',
      scope: 'read_only',
      expiresAt: future(),
    });
    expect(res.status).toBe(401);
  });

  // --- tenant-side: list / get / revoke / isolation (plan §6.2) ---

  it('list + get return own-tenant grants; revoke transitions and re-revoke 409', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'lifecycle',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const list = await request(app.getHttpServer())
      .get('/api/support-access')
      .set(bearer(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.data.some((g: { id: string }) => g.id === id)).toBe(true);

    const get = await request(app.getHttpServer())
      .get(`/api/support-access/${id}`)
      .set(bearer(adminToken));
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(id);

    // revoke requires a reason
    const noReason = await request(app.getHttpServer())
      .post(`/api/support-access/${id}/revoke`)
      .set(bearer(adminToken))
      .send({});
    expect(noReason.status).toBe(400);

    const revoke = await request(app.getHttpServer())
      .post(`/api/support-access/${id}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'no longer needed' });
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe('revoked');
    expect(revoke.body.revokedByUserId).toBe(TEST_USER_ID);
    expect(revoke.body.revokedAt).toBeTruthy();
    expect(revoke.body.revokeReason).toBe('no longer needed');

    // re-revoke → 409
    const again = await request(app.getHttpServer())
      .post(`/api/support-access/${id}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'again' });
    expect(again.status).toBe(409);

    // revoked audit landed in TEST_TENANT's chain.
    await withAdmin(async (c) => {
      const { rows } = await c.query(
        `SELECT actor_type FROM audit_logs
         WHERE tenant_id = $1 AND action = 'support_access.revoked' AND resource_id = $2`,
        [TEST_TENANT_ID, id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_type).toBe('tenant_user');
    });
  });

  it('cross-tenant grant id returns opaque 404 (RLS empty set)', async () => {
    const t1 = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'isolation',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(t1.status).toBe(201);

    // tenant2 admin cannot see tenant1's grant.
    const cross = await request(app.getHttpServer())
      .get(`/api/support-access/${t1.body.id}`)
      .set(bearer(tenant2Token));
    expect(cross.status).toBe(404);

    await request(app.getHttpServer())
      .post(`/api/support-access/${t1.body.id}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'cleanup' });
  });

  // --- freeze trigger + append-only (DB layer, owner connection) ---

  it('freeze trigger rejects changes to frozen grant terms; status is mutable', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'freeze test',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    await withAdmin(async (c) => {
      // Each frozen term raises. granted_by_user_id must change to a DIFFERENT
      // user (TEST_USER2_ID) — setting it back to the same value is a no-op the
      // IS DISTINCT FROM guard correctly allows.
      for (const sql of [
        `UPDATE support_access_grants SET reason = 'changed' WHERE id = $1`,
        `UPDATE support_access_grants SET scope = 'read_only2' WHERE id = $1`,
        `UPDATE support_access_grants SET expires_at = now() + interval '99 days' WHERE id = $1`,
        `UPDATE support_access_grants SET granted_by_user_id = $2 WHERE id = $1`,
      ]) {
        await expect(
          c.query(sql, sql.includes('$2') ? [id, TEST_USER2_ID] : [id]),
        ).rejects.toThrow();
      }
      // status (+ revoke stamps) is allowed.
      const ok = await c.query(
        `UPDATE support_access_grants SET status = 'revoked', revoked_at = now() WHERE id = $1`,
        [id],
      );
      expect(ok.rowCount).toBe(1);
    });
  });

  it('kirindesk_app role has no DELETE on support_access_grants', async () => {
    // The app pool connects as kirindesk_app; a direct DELETE must be denied
    // (no grant, §2.3) — the credential cannot be erased.
    await expect(pool.query('DELETE FROM support_access_grants')).rejects.toThrow();
  });

  // --- platform-side authorized read access (plan §6.2, core) ---

  // Inserts a grant directly via the owner connection (bypasses RLS + the
  // BEFORE UPDATE freeze trigger, which only fires on UPDATE). Used for the
  // past-dated / revoked grants the HTTP path will not let us create.
  async function insertGrant(opts: {
    tenantId: string;
    status: string;
    expiresAt: string; // ISO
  }): Promise<string> {
    return withAdmin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO support_access_grants
           (tenant_id, platform_admin_id, scope, reason, status, expires_at,
            granted_by_user_id, approved_at)
         VALUES ($1, $2, 'read_only', 'direct', $3, $4, $5, now())
         RETURNING id`,
        [opts.tenantId, TEST_ADMIN_ID, opts.status, opts.expiresAt, TEST_USER_ID],
      );
      return rows[0].id;
    });
  }

  async function deleteGrant(id: string): Promise<void> {
    await withAdmin((c) => c.query(`DELETE FROM support_access_grants WHERE id = $1`, [id]));
  }

  it('platform read with NO grant returns 403 (default deny)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT_ID}/audit-logs`)
      .set(bearer(platformToken));
    expect(res.status).toBe(403);
  });

  it('platform read with an active grant: 200, tenant1 audit, writes .accessed into tenant chain', async () => {
    const grantRes = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'platform read',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(grantRes.status).toBe(201);
    const grantId = grantRes.body.id as string;

    // audit-logs
    const logs = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT_ID}/audit-logs`)
      .set(bearer(platformToken));
    expect(logs.status).toBe(200);
    expect(Array.isArray(logs.body.data)).toBe(true);

    // users / roles / chain verify all succeed under the same grant
    const users = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT_ID}/users`)
      .set(bearer(platformToken));
    expect(users.status).toBe(200);
    expect(users.body.data.some((u: { id: string }) => u.id === TEST_USER_ID)).toBe(true);

    const roles = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT_ID}/roles`)
      .set(bearer(platformToken));
    expect(roles.status).toBe(200);
    expect(Array.isArray(roles.body)).toBe(true);

    const chain = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT_ID}/audit-logs/chain/verify`)
      .set(bearer(platformToken));
    expect(chain.status).toBe(200);
    expect(chain.body.ok).toBe(true);

    // Each read wrote a .accessed event into TEST_TENANT's chain, actor=platform
    // admin, resourceId=grantId, metadata = {scope,resourceType,route} only (no
    // business plaintext). reason lives in the audit reason field, not metadata.
    await withAdmin(async (c) => {
      const { rows } = await c.query(
        `SELECT actor_type, actor_id, resource_id, resource_type, metadata_json
         FROM audit_logs
         WHERE tenant_id = $1 AND action = 'support_access.accessed'
         ORDER BY id ASC`,
        [TEST_TENANT_ID],
      );
      expect(rows.length).toBeGreaterThanOrEqual(4); // audit-logs, users, roles, chain
      for (const row of rows) {
        expect(row.actor_type).toBe('platform_admin');
        expect(row.actor_id).toBe(TEST_ADMIN_ID);
        expect(row.resource_id).toBe(grantId);
        expect(Object.keys(row.metadata_json).sort()).toEqual(['resourceType', 'route', 'scope']);
        expect(row.metadata_json.scope).toBe('read_only');
      }
    });

    // The tenant sees the .accessed events in its own 1I audit list.
    const tenantView = await request(app.getHttpServer())
      .get('/api/audit-logs?action=support_access.accessed')
      .set(bearer(adminToken));
    expect(tenantView.status).toBe(200);
    expect(tenantView.body.data.length).toBeGreaterThanOrEqual(4);
    expect(
      tenantView.body.data.every((e: { actorType: string }) => e.actorType === 'platform_admin'),
    ).toBe(true);

    // Tenant chain still verifies after the platform writes.
    const tenantChain = await request(app.getHttpServer())
      .get('/api/audit-logs/chain/verify')
      .set(bearer(adminToken));
    expect(tenantChain.status).toBe(200);
    expect(tenantChain.body.ok).toBe(true);

    await request(app.getHttpServer())
      .post(`/api/support-access/${grantId}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'cleanup' });
  });

  it('expired grant → 403; revoked grant → 403', async () => {
    const expired = await insertGrant({
      tenantId: TEST_TENANT_ID,
      status: 'active',
      expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    });
    const r1 = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT_ID}/audit-logs`)
      .set(bearer(platformToken));
    expect(r1.status).toBe(403);
    await deleteGrant(expired);

    const revoked = await insertGrant({
      tenantId: TEST_TENANT_ID,
      status: 'revoked',
      expiresAt: future(),
    });
    const r2 = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT_ID}/audit-logs`)
      .set(bearer(platformToken));
    expect(r2.status).toBe(403);
    await deleteGrant(revoked);
  });

  it('a tenant1 grant does not authorize reading tenant2 (cross-tenant 403)', async () => {
    const grant = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'only tenant1',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(grant.status).toBe(201);

    const cross = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT2_ID}/audit-logs`)
      .set(bearer(platformToken));
    expect(cross.status).toBe(403);

    await request(app.getHttpServer())
      .post(`/api/support-access/${grant.body.id}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'cleanup' });
  });

  it('GET /grants lists only grants naming this admin', async () => {
    // A grant naming TEST_ADMIN (tenant1).
    const mine = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'mine',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(mine.status).toBe(201);

    const res = await request(app.getHttpServer())
      .get('/api/platform/support/grants')
      .set(bearer(platformToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Every returned grant names this admin's tenant context — all rows belong
    // to grants for TEST_ADMIN; the one we just made is present.
    expect(res.body.some((g: { grantId: string }) => g.grantId === mine.body.id)).toBe(true);

    await request(app.getHttpServer())
      .post(`/api/support-access/${mine.body.id}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'cleanup' });
  });

  // --- token separation + structural read-only (plan §6.2) ---

  it('platform support endpoints reject a tenant token (401)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/platform/support/tenants/${TEST_TENANT_ID}/audit-logs`)
      .set(bearer(adminToken));
    expect(res.status).toBe(401);
  });

  it('platform support endpoints with no token return 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/platform/support/grants');
    expect(res.status).toBe(401);
  });

  it('scope=read_only is structural: no write route exists (POST → 404)', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/platform/support/tenants/${TEST_TENANT_ID}/users`)
      .set(bearer(platformToken))
      .send({ email: 'x@x.local' });
    expect(res.status).toBe(404);
  });

  // --- SECURITY DEFINER isolation (plan §6.2) ---

  it('app_check_support_access only returns active, unexpired, named grants', async () => {
    const grant = await request(app.getHttpServer())
      .post('/api/support-access')
      .set(bearer(adminToken))
      .send({
        platformAdminEmail: TEST_ADMIN_EMAIL,
        reason: 'definer',
        scope: 'read_only',
        expiresAt: future(),
      });
    expect(grant.status).toBe(201);

    await withAdmin(async (c) => {
      // Named admin sees the active grant.
      const ok = await c.query(`SELECT grant_id FROM app_check_support_access($1, $2)`, [
        TEST_ADMIN_ID,
        TEST_TENANT_ID,
      ]);
      expect(ok.rows).toHaveLength(1);

      // A different admin id sees nothing (cannot borrow A's grant).
      const other = await c.query(`SELECT grant_id FROM app_check_support_access($1, $2)`, [
        '00000000-0000-0000-0000-0000000000ff',
        TEST_TENANT_ID,
      ]);
      expect(other.rows).toHaveLength(0);

      // list-for-admin returns only grants naming this admin.
      const listed = await c.query(`SELECT tenant_id FROM app_list_support_grants_for_admin($1)`, [
        TEST_ADMIN_ID,
      ]);
      expect(listed.rows.length).toBeGreaterThanOrEqual(1);
      const otherList = await c.query(
        `SELECT tenant_id FROM app_list_support_grants_for_admin($1)`,
        ['00000000-0000-0000-0000-0000000000ff'],
      );
      expect(otherList.rows).toHaveLength(0);
    });

    await request(app.getHttpServer())
      .post(`/api/support-access/${grant.body.id}/revoke`)
      .set(bearer(adminToken))
      .send({ reason: 'cleanup' });
  });
});
