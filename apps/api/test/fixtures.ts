import * as bcrypt from 'bcryptjs';
import pg from 'pg';

export const TEST_DB = 'kirindesk_test';

// Fixed identifiers so tests can reference the tenant chain key directly.
export const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const TEST_USER_ID = '22222222-2222-2222-2222-222222222222'; // tenant1 admin, scope=all
export const TEST_ADMIN_ID = '33333333-3333-3333-3333-333333333333'; // platform admin
export const TEST_TENANT2_ID = '44444444-4444-4444-4444-444444444444';
export const TEST_USER2_ID = '55555555-5555-5555-5555-555555555555'; // tenant1 sales, scope=own
export const TEST_USER3_ID = '66666666-6666-6666-6666-666666666666'; // tenant2 admin, scope=all
export const TEST_USER4_ID = '77777777-7777-7777-7777-777777777777'; // tenant1, no roles (no perms)

export const TEST_TENANT_SLUG = 'test-tenant';
export const TEST_TENANT2_SLUG = 'test-tenant-2';
export const TEST_USER_EMAIL = 'test-user@test.local';
export const TEST_ADMIN_EMAIL = 'test-admin@test.local';
export const TEST_USER2_EMAIL = 'test-sales@test.local';
export const TEST_USER3_EMAIL = 'test-user3@test.local';
export const TEST_USER4_EMAIL = 'test-noperm@test.local';
export const TEST_PASSWORD = 'test-password-123';

export const ZERO_HASH = '0'.repeat(64);

// RBAC fixture identifiers (roles are tenant-scoped).
const CRM_MODULE_ID = 'a0000000-0000-0000-0000-000000000001';
const ORDERS_MODULE_ID = 'a0000000-0000-0000-0000-000000000002';
const PROCUREMENT_MODULE_ID = 'a0000000-0000-0000-0000-000000000003';
const FINANCE_MODULE_ID = 'a0000000-0000-0000-0000-000000000004';
const FILES_MODULE_ID = 'a0000000-0000-0000-0000-000000000005';
const SYSTEM_MODULE_ID = 'a0000000-0000-0000-0000-000000000007';
const ADMIN_ROLE_ID = 'a1111111-1111-1111-1111-111111111111'; // tenant1, scope=all
const SALES_ROLE_ID = 'a2222222-2222-2222-2222-222222222222'; // tenant1, scope=own
const T2_ADMIN_ROLE_ID = 'a3333333-3333-3333-3333-333333333333'; // tenant2, scope=all

// The four permissions the customers endpoints require.
export const CUSTOMER_PERMS = [
  'customers:view',
  'customers:create',
  'customers:update',
  'customers:delete',
] as const;

// The sales-orders endpoints' permissions. Phase 1F-C adds orders:approve
// (granted per-role at the role's scope below: admin=all, sales=own), used by
// the approval-workflow transition endpoints. export is still out of scope.
export const ORDER_PERMS = [
  'orders:view',
  'orders:create',
  'orders:update',
  'orders:delete',
  'orders:approve',
] as const;

// The four permissions the suppliers endpoints require.
export const SUPPLIER_PERMS = [
  'suppliers:view',
  'suppliers:create',
  'suppliers:update',
  'suppliers:delete',
] as const;

// The purchase-orders endpoints' permissions. Phase 1F-C adds
// procurement:approve (granted per-role at the role's scope below), used by the
// approval-workflow transition endpoints.
export const PROCUREMENT_ORDER_PERMS = [
  'procurement:view',
  'procurement:create',
  'procurement:update',
  'procurement:delete',
  'procurement:approve',
] as const;

// The permissions the files endpoints require (view/upload/download/delete).
export const FILE_PERMS = ['files:view', 'files:upload', 'files:download', 'files:delete'] as const;

// The permissions the tenant-settings endpoints require (system module).
export const TENANT_SETTINGS_PERMS = ['tenant_settings:view', 'tenant_settings:update'] as const;

// Phase 1F-E commission rate tables / settlements (finance module).
export const COMMISSION_PERMS = [
  'commission_tables:view',
  'commission_tables:lock',
  'commission_tables:unlock',
] as const;

// Phase 1F-F payout / disbursement (finance module). Separate codes so the
// disburse / reverse duties are independently grantable (separation of duties).
export const COMMISSION_PAYOUT_PERMS = [
  'commission_payouts:view',
  'commission_payouts:disburse',
  'commission_payouts:reverse',
] as const;

// All permissions granted to each fixture role, with their owning module id.
const SEED_PERMS: { code: string; moduleId: string }[] = [
  ...CUSTOMER_PERMS.map((code) => ({ code, moduleId: CRM_MODULE_ID })),
  ...ORDER_PERMS.map((code) => ({ code, moduleId: ORDERS_MODULE_ID })),
  ...SUPPLIER_PERMS.map((code) => ({ code, moduleId: PROCUREMENT_MODULE_ID })),
  ...PROCUREMENT_ORDER_PERMS.map((code) => ({ code, moduleId: PROCUREMENT_MODULE_ID })),
  ...FILE_PERMS.map((code) => ({ code, moduleId: FILES_MODULE_ID })),
  ...TENANT_SETTINGS_PERMS.map((code) => ({ code, moduleId: SYSTEM_MODULE_ID })),
  ...COMMISSION_PERMS.map((code) => ({ code, moduleId: FINANCE_MODULE_ID })),
  ...COMMISSION_PAYOUT_PERMS.map((code) => ({ code, moduleId: FINANCE_MODULE_ID })),
];

interface RoleSpec {
  roleId: string;
  tenantId: string;
  name: string;
  scope: string;
  userId: string;
}

const ROLE_SPECS: RoleSpec[] = [
  {
    roleId: ADMIN_ROLE_ID,
    tenantId: TEST_TENANT_ID,
    name: 'Admin',
    scope: 'all',
    userId: TEST_USER_ID,
  },
  {
    roleId: SALES_ROLE_ID,
    tenantId: TEST_TENANT_ID,
    name: 'Sales',
    scope: 'own',
    userId: TEST_USER2_ID,
  },
  {
    roleId: T2_ADMIN_ROLE_ID,
    tenantId: TEST_TENANT2_ID,
    name: 'Admin',
    scope: 'all',
    userId: TEST_USER3_ID,
  },
];

// Writes the minimal fixture into kirindesk_test only. Asserts the connection
// is on the test database before any write. Does NOT reuse the dev seed.
//
// The admin connection (kirindesk superuser) bypasses RLS, so tenant-scoped
// rows are inserted without setting app.current_tenant_id. modules/permissions
// are global tables (no tenant_id, no RLS); they are seeded idempotently here
// because the integration setup runs migrations only, never the dev seed.
export async function seedFixture(adminConnectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminConnectionString });
  await client.connect();
  try {
    const guard = await client.query('SELECT current_database() AS db');
    if (guard.rows[0]?.db !== TEST_DB) {
      throw new Error(
        `Refusing to seed: connected to "${guard.rows[0]?.db}", expected "${TEST_DB}"`,
      );
    }

    const passwordHash = bcrypt.hashSync(TEST_PASSWORD, 10);

    // --- tenants ---
    await client.query(
      `INSERT INTO tenants (id, name, slug, status) VALUES
         ($1, 'Test Tenant', $2, 'active'),
         ($3, 'Test Tenant 2', $4, 'active')`,
      [TEST_TENANT_ID, TEST_TENANT_SLUG, TEST_TENANT2_ID, TEST_TENANT2_SLUG],
    );

    // --- users ---
    await client.query(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, status, is_tenant_owner) VALUES
         ($1, $2, $3, $11, 'Test User', 'active', true),
         ($4, $2, $5, $11, 'Test Sales', 'active', false),
         ($6, $7, $8, $11, 'Test User 3', 'active', true),
         ($9, $2, $10, $11, 'Test No Perm', 'active', false)`,
      [
        TEST_USER_ID,
        TEST_TENANT_ID,
        TEST_USER_EMAIL,
        TEST_USER2_ID,
        TEST_USER2_EMAIL,
        TEST_USER3_ID,
        TEST_TENANT2_ID,
        TEST_USER3_EMAIL,
        TEST_USER4_ID,
        TEST_USER4_EMAIL,
        passwordHash,
      ],
    );

    await client.query(
      `INSERT INTO platform_admins (id, email, password_hash, name, status)
       VALUES ($1, $2, $3, 'Test Admin', 'active')`,
      [TEST_ADMIN_ID, TEST_ADMIN_EMAIL, passwordHash],
    );

    // --- modules + permissions (global, idempotent) ---
    await client.query(
      `INSERT INTO modules (id, code, name, sort_order) VALUES
         ($1, 'crm', '客户管理', 1),
         ($2, 'orders', '订单管理', 2),
         ($3, 'procurement', '采购管理', 3),
         ($4, 'files', '文件管理', 5),
         ($5, 'system', '系统管理', 7),
         ($6, 'finance', '财务管理', 4)
       ON CONFLICT (code) DO NOTHING`,
      [
        CRM_MODULE_ID,
        ORDERS_MODULE_ID,
        PROCUREMENT_MODULE_ID,
        FILES_MODULE_ID,
        SYSTEM_MODULE_ID,
        FINANCE_MODULE_ID,
      ],
    );

    for (const { code, moduleId } of SEED_PERMS) {
      const action = code.split(':')[1];
      await client.query(
        `INSERT INTO permissions (module_id, code, name, action) VALUES ($1, $2, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [moduleId, code, action],
      );
    }

    const allCodes = SEED_PERMS.map((p) => p.code);
    const permRes = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM permissions WHERE code = ANY($1)`,
      [allCodes],
    );
    const permId: Record<string, string> = {};
    for (const r of permRes.rows) permId[r.code] = r.id;

    // --- roles, user_roles, role_permissions ---
    for (const spec of ROLE_SPECS) {
      await client.query(
        `INSERT INTO roles (id, tenant_id, name, is_system) VALUES ($1, $2, $3, true)`,
        [spec.roleId, spec.tenantId, spec.name],
      );
      await client.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
        [spec.tenantId, spec.userId, spec.roleId],
      );
      for (const code of allCodes) {
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
           VALUES ($1, $2, $3, $4)`,
          [spec.tenantId, spec.roleId, permId[code], spec.scope],
        );
      }
    }

    // --- audit chains (must exist or AuditService silently rolls back) ---
    await client.query(
      `INSERT INTO audit_log_chains (chain_key, tenant_id, last_hash) VALUES
         ($1, $2, $5),
         ($3, $4, $5),
         ('platform', NULL, $5)`,
      [
        `tenant:${TEST_TENANT_ID}`,
        TEST_TENANT_ID,
        `tenant:${TEST_TENANT2_ID}`,
        TEST_TENANT2_ID,
        ZERO_HASH,
      ],
    );
  } finally {
    await client.end();
  }
}
