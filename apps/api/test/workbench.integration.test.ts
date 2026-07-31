import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { closePool, verifyChain } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import { withTenantContext } from '../src/database/context';
import { AuditService } from '../src/audit/audit.service';
import { BusinessExceptionsService } from '../src/workbench/business-exceptions.service';
import {
  TEST_PASSWORD,
  TEST_TENANT2_SLUG,
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_USER3_EMAIL,
  TEST_USER_EMAIL,
  TEST_USER_ID,
} from './fixtures';

const BUSINESS_USER_ID = '90000000-0000-4000-8000-000000000001';
const PROCUREMENT_USER_ID = '90000000-0000-4000-8000-000000000002';
const FINANCE_USER_ID = '90000000-0000-4000-8000-000000000003';
const APPROVER_USER_ID = '90000000-0000-4000-8000-000000000004';
const NO_PERMISSION_USER_ID = '90000000-0000-4000-8000-000000000005';

const USERS = [
  { id: BUSINESS_USER_ID, email: 'workbench-business@test.local', name: 'Workbench Business' },
  {
    id: PROCUREMENT_USER_ID,
    email: 'workbench-procurement@test.local',
    name: 'Workbench Procurement',
  },
  { id: FINANCE_USER_ID, email: 'workbench-finance@test.local', name: 'Workbench Finance' },
  { id: APPROVER_USER_ID, email: 'workbench-approver@test.local', name: 'Workbench Approver' },
  { id: NO_PERMISSION_USER_ID, email: 'workbench-none@test.local', name: 'Workbench None' },
] as const;

const ROLE_SPECS = [
  {
    id: '91000000-0000-4000-8000-000000000001',
    userId: BUSINESS_USER_ID,
    name: 'Workbench Business Role',
    grants: {
      'workbench:view': 'own',
      'business_events:view': 'own',
      'business_exceptions:view': 'own',
      'business_exceptions:resolve': 'own',
      'customers:view': 'own',
      'inquiries:view': 'own',
      'orders:view': 'own',
    },
  },
  {
    id: '91000000-0000-4000-8000-000000000002',
    userId: PROCUREMENT_USER_ID,
    name: 'Workbench Procurement Role',
    grants: {
      'workbench:view': 'all',
      'business_events:view': 'assigned',
      'business_exceptions:view': 'assigned',
      'business_exceptions:resolve': 'assigned',
      'quotations:view': 'all',
      'procurement:view': 'all',
      'suppliers:view': 'all',
    },
  },
  {
    id: '91000000-0000-4000-8000-000000000003',
    userId: FINANCE_USER_ID,
    name: 'Workbench Finance Role',
    grants: {
      'workbench:view': 'all',
      'business_events:view': 'all',
      'business_exceptions:view': 'all',
      'business_exceptions:close': 'all',
      'finance:view': 'all',
      'reports:view': 'all',
      'commission_tables:view': 'all',
    },
  },
  {
    id: '91000000-0000-4000-8000-000000000004',
    userId: APPROVER_USER_ID,
    name: 'Workbench Approver Role',
    grants: {
      'workbench:view': 'all',
      'business_events:view': 'all',
      'business_exceptions:view': 'all',
      'business_exceptions:assign': 'all',
      'orders:approve': 'all',
      'procurement:approve': 'all',
    },
  },
] as const;

describe('Stage 2G role workbench and credential chain (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let exceptions: BusinessExceptionsService;
  let audit: AuditService;
  const tokens = new Map<string, string>();
  const exceptionIds: string[] = [];
  const contextIds: string[] = [];

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

  async function login(email: string, slug = TEST_TENANT_SLUG) {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: slug });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    await withAdmin(async (client) => {
      for (const user of USERS) {
        await client.query(
          `INSERT INTO users (id, tenant_id, email, password_hash, name, status)
           SELECT $1, $2, $3, password_hash, $4, 'active'
             FROM users WHERE id = $5`,
          [user.id, TEST_TENANT_ID, user.email, user.name, TEST_USER_ID],
        );
      }
      for (const role of ROLE_SPECS) {
        await client.query(
          `INSERT INTO roles (id, tenant_id, name, is_system) VALUES ($1, $2, $3, true)`,
          [role.id, TEST_TENANT_ID, role.name],
        );
        await client.query(
          `INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
          [TEST_TENANT_ID, role.userId, role.id],
        );
        for (const [code, scope] of Object.entries(role.grants)) {
          await client.query(
            `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
             SELECT $1, $2, id, $3 FROM permissions WHERE code = $4`,
            [TEST_TENANT_ID, role.id, scope, code],
          );
        }
      }
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);
    exceptions = app.get(BusinessExceptionsService);
    audit = app.get(AuditService);

    tokens.set('admin', await login(TEST_USER_EMAIL));
    for (const user of USERS) tokens.set(user.name, await login(user.email));
    tokens.set('tenant2', await login(TEST_USER3_EMAIL, TEST_TENANT2_SLUG));

    const types = [
      'price_variance',
      'quantity_variance',
      'missing_expense',
      'duplicate_customer',
    ] as const;
    for (const [index, type] of types.entries()) {
      const contextId = randomUUID();
      contextIds.push(contextId);
      const opened = await exceptions.open(
        { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, dataScope: 'all' },
        {
          contextType: index === 3 ? 'customer' : 'sales_order',
          contextId,
          type,
          severity: index === 0 ? 'critical' : 'medium',
          summary: `Sensitive exception summary ${index}`,
          ownerUserId: index === 0 ? BUSINESS_USER_ID : TEST_USER_ID,
        },
      );
      exceptionIds.push(opened.id);
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('returns server-computed permissions and rejects an unprivileged workbench route', async () => {
    const me = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set(bearer(tokens.get('Workbench Business')!));
    expect(me.status).toBe(200);
    expect(me.body.permissions).toEqual(
      expect.objectContaining({
        'workbench:view': 'own',
        'inquiries:view': 'own',
        'orders:view': 'own',
      }),
    );
    expect(me.body.permissions).not.toHaveProperty('suppliers:view');

    const denied = await request(app.getHttpServer())
      .get('/api/workbench')
      .set(bearer(tokens.get('Workbench None')!));
    expect(denied.status).toBe(403);
    expect((await request(app.getHttpServer()).get('/api/workbench')).status).toBe(401);
  });

  it('builds distinct business, procurement, finance, approver, and admin workbenches', async () => {
    const cases = [
      { token: tokens.get('Workbench Business')!, expected: 'business', forbidden: 'procurement' },
      {
        token: tokens.get('Workbench Procurement')!,
        expected: 'procurement',
        forbidden: 'business',
      },
      { token: tokens.get('Workbench Finance')!, expected: 'finance', forbidden: 'business' },
      { token: tokens.get('Workbench Approver')!, expected: 'approver', forbidden: 'finance' },
    ];
    for (const roleCase of cases) {
      const response = await request(app.getHttpServer())
        .get('/api/workbench')
        .set(bearer(roleCase.token));
      expect(response.status).toBe(200);
      expect(response.body.capabilities).toContain(roleCase.expected);
      expect(response.body.capabilities).not.toContain(roleCase.forbidden);
    }

    const admin = await request(app.getHttpServer())
      .get('/api/workbench')
      .set(bearer(tokens.get('admin')!));
    expect(admin.status).toBe(200);
    expect(admin.body.capabilities).toEqual(
      expect.arrayContaining(['business', 'procurement', 'finance', 'approver', 'admin']),
    );
    expect(JSON.stringify(admin.body)).not.toContain('Sensitive exception summary');
  });

  it('enforces exception data scopes and tenant RLS', async () => {
    const admin = await request(app.getHttpServer())
      .get('/api/business-exceptions?pageSize=100')
      .set(bearer(tokens.get('admin')!));
    expect(admin.status).toBe(200);
    for (const type of [
      'price_variance',
      'quantity_variance',
      'missing_expense',
      'duplicate_customer',
    ]) {
      expect(admin.body.data.some((row: { type: string }) => row.type === type)).toBe(true);
    }

    const business = await request(app.getHttpServer())
      .get('/api/business-exceptions?pageSize=100')
      .set(bearer(tokens.get('Workbench Business')!));
    expect(business.status).toBe(200);
    expect(business.body.data.map((row: { id: string }) => row.id)).toEqual([exceptionIds[0]]);

    const tenant2 = await request(app.getHttpServer())
      .get('/api/business-exceptions?pageSize=100')
      .set(bearer(tokens.get('tenant2')!));
    expect(tenant2.status).toBe(200);
    expect(tenant2.body.data).toEqual([]);

    const wrongTenantCount = await withTenantContext(
      pool,
      {
        tenantId: '44444444-4444-4444-4444-444444444444',
        userId: '66666666-6666-6666-6666-666666666666',
        actorType: 'tenant_user',
      },
      async (client) => {
        const result = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM business_exceptions WHERE id = ANY($1::uuid[])`,
          [exceptionIds],
        );
        return result.rows[0].count;
      },
    );
    expect(wrongTenantCount).toBe('0');
  });

  it('assigns, starts, resolves, and closes with server-side transitions and CAS', async () => {
    const assigned = await request(app.getHttpServer())
      .post(`/api/business-exceptions/${exceptionIds[0]}/assign`)
      .set(bearer(tokens.get('Workbench Approver')!))
      .send({ assigneeUserId: BUSINESS_USER_ID, expectedVersion: 1 });
    expect(assigned.status).toBe(201);
    expect(assigned.body.status).toBe('assigned');
    expect(assigned.body.version).toBe(2);

    const stale = await request(app.getHttpServer())
      .post(`/api/business-exceptions/${exceptionIds[0]}/assign`)
      .set(bearer(tokens.get('Workbench Approver')!))
      .send({ assigneeUserId: PROCUREMENT_USER_ID, expectedVersion: 1 });
    expect(stale.status).toBe(409);

    const started = await request(app.getHttpServer())
      .post(`/api/business-exceptions/${exceptionIds[0]}/start`)
      .set(bearer(tokens.get('Workbench Business')!))
      .send({ expectedVersion: 2 });
    expect(started.status).toBe(201);
    expect(started.body.status).toBe('in_progress');

    const resolved = await request(app.getHttpServer())
      .post(`/api/business-exceptions/${exceptionIds[0]}/resolve`)
      .set(bearer(tokens.get('Workbench Business')!))
      .send({ expectedVersion: 3, resolution: 'Verified against source document' });
    expect(resolved.status).toBe(201);
    expect(resolved.body.status).toBe('resolved');

    const closed = await request(app.getHttpServer())
      .post(`/api/business-exceptions/${exceptionIds[0]}/close`)
      .set(bearer(tokens.get('Workbench Finance')!))
      .send({ expectedVersion: 4 });
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('closed');
    expect(closed.body.version).toBe(5);
  });

  it('projects a permission-scoped credential timeline without sensitive fields', async () => {
    const procurementAssigned = await request(app.getHttpServer())
      .post(`/api/business-exceptions/${exceptionIds[1]}/assign`)
      .set(bearer(tokens.get('Workbench Approver')!))
      .send({ assigneeUserId: PROCUREMENT_USER_ID, expectedVersion: 1 });
    expect(procurementAssigned.status).toBe(201);

    const procurementTimeline = await request(app.getHttpServer())
      .get(`/api/business-events?chainType=sales_order&chainId=${contextIds[1]}&pageSize=100`)
      .set(bearer(tokens.get('Workbench Procurement')!));
    expect(procurementTimeline.status).toBe(200);
    expect(
      procurementTimeline.body.data.some(
        (event: { eventType: string }) => event.eventType === 'business_exception.assigned',
      ),
    ).toBe(true);

    const secretQuotationId = randomUUID();
    await audit.log({
      tenantId: TEST_TENANT_ID,
      actorType: 'tenant_user',
      actorId: TEST_USER_ID,
      action: 'supplier_quotation.overwritten',
      resourceType: 'supplier_quotation',
      resourceId: secretQuotationId,
      before: { source_text: 'SECRET SUPPLIER CONTENT' },
      after: { source_text: 'UPDATED SECRET SUPPLIER CONTENT' },
    });

    const timeline = await request(app.getHttpServer())
      .get(`/api/business-events?chainType=sales_order&chainId=${contextIds[0]}&pageSize=100`)
      .set(bearer(tokens.get('Workbench Business')!));
    expect(timeline.status).toBe(200);
    expect(timeline.body.data.length).toBeGreaterThanOrEqual(5);
    const serialized = JSON.stringify(timeline.body);
    for (const forbidden of [
      'Sensitive exception summary',
      'Verified against source document',
      'SECRET SUPPLIER CONTENT',
      secretQuotationId,
      'source_text',
      'before',
      'after',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const tenant2 = await request(app.getHttpServer())
      .get('/api/business-events?pageSize=100')
      .set(bearer(tokens.get('tenant2')!));
    expect(tenant2.status).toBe(200);
    expect(JSON.stringify(tenant2.body)).not.toContain(exceptionIds[0]);
  });

  it('keeps business events append-only and the tenant audit chain valid', async () => {
    const eventId = await withAdmin(async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM business_events WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`,
        [TEST_TENANT_ID],
      );
      return result.rows[0].id;
    });
    await expect(
      withAdmin((client) =>
        client.query(`UPDATE business_events SET event_type = 'tampered' WHERE id = $1`, [eventId]),
      ),
    ).rejects.toThrow(/append-only/);

    const verification = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(verification.ok).toBe(true);
  });
});
