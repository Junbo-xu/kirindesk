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
const REPORTS_MODULE_ID = 'a0000000-0000-0000-0000-000000000006';
const SYSTEM_MODULE_ID = 'a0000000-0000-0000-0000-000000000007';
const AI_MODULE_ID = 'a0000000-0000-0000-0000-000000000008';
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

// Phase 1G AI/OCR (ai module). process is separate from view so triggering a
// provider call is independently grantable from reading invocation records.
export const AI_PERMS = ['ocr:view', 'ocr:process', 'ai:view', 'ai:process'] as const;

// Phase 1F-D reports (reports module) and Phase 1I audit viewer (system module).
// Phase 1J data export reuses these same view codes (no separate *:export code),
// so granting them lets the export endpoints be exercised.
export const REPORTS_PERMS = ['reports:view'] as const;
export const AUDIT_PERMS = ['audit_logs:view'] as const;

// Phase 1H user + role management (system module). Added to SEED_PERMS so the
// subscription integration test can POST /api/users (users:create required).
export const USER_MGMT_PERMS = [
  'users:view',
  'users:create',
  'users:update',
  'roles:view',
  'roles:create',
  'roles:update',
  'roles:delete',
] as const;

// Phase 1K-B support access (system module). Granted ONLY to the admin roles
// (scope=all) below — deliberately NOT in SEED_PERMS, whose codes go to every
// fixture role: the sales (scope=own) and no-role users must lack these codes
// so the 403 / default-deny cases hold (plan §6.1). Test fixture only — the
// product seed is separate (§2.7) and the two never couple.
export const SUPPORT_ACCESS_PERMS = [
  'support_access:grant',
  'support_access:revoke',
  'support_access:view',
] as const;

// Phase 2A billing & payment (finance module). view = read invoices, pay = pay
// an invoice. In SEED_PERMS so admin/sales roles hold them; the no-role user
// lacks them for the 403 case.
export const BILLING_PERMS = ['billing:view', 'billing:pay'] as const;
export const FINANCE_PERMS = ['finance:view'] as const;

export const WORKBENCH_PERMS = [
  'workbench:view',
  'business_events:view',
  'business_exceptions:view',
  'business_exceptions:assign',
  'business_exceptions:resolve',
  'business_exceptions:close',
] as const;

export const INQUIRY_PERMS = [
  'inquiries:view',
  'inquiries:create',
  'inquiries:submit',
  'inquiries:sanitize',
] as const;
export const QUOTE_SELECTION_PERMS = ['quote_selections:create', 'quote_selections:view'] as const;
export const QUOTATION_PERMS = [
  'quotations:view',
  'quotations:manage',
  'quotations:audit',
] as const;

const STAGE_2A_PERMS: { code: string; moduleId: string }[] = [
  ...INQUIRY_PERMS.map((code) => ({ code, moduleId: ORDERS_MODULE_ID })),
  ...QUOTE_SELECTION_PERMS.map((code) => ({ code, moduleId: ORDERS_MODULE_ID })),
  ...QUOTATION_PERMS.slice(0, 2).map((code) => ({ code, moduleId: PROCUREMENT_MODULE_ID })),
  { code: 'quotations:audit', moduleId: SYSTEM_MODULE_ID },
];

export const PROFORMA_INVOICE_PERMS = [
  'proforma_invoices:view',
  'proforma_invoices:create',
  'proforma_invoices:issue',
  'proforma_invoices:confirm',
  'proforma_invoices:export',
] as const;
export const CUSTOMER_RECEIPT_PERMS = [
  'customer_receipts:view',
  'customer_receipts:record',
  'customer_receipts:review',
] as const;
export const PROCUREMENT_GATE_PERMS = ['procurement_gate:view'] as const;

const STAGE_2B_PERMS: { code: string; moduleId: string }[] = [
  { code: 'quote_selections:approve_margin', moduleId: ORDERS_MODULE_ID },
  ...PROFORMA_INVOICE_PERMS.map((code) => ({ code, moduleId: ORDERS_MODULE_ID })),
  ...CUSTOMER_RECEIPT_PERMS.map((code) => ({ code, moduleId: FINANCE_MODULE_ID })),
  ...PROCUREMENT_GATE_PERMS.map((code) => ({ code, moduleId: FINANCE_MODULE_ID })),
];

export const FULFILLMENT_PERMS = [
  'fulfillment:view',
  'goods_receipts:manage',
  'goods_receipts:confirm',
  'shipments:manage',
  'order_expenses:record',
] as const;

export const STAGE_2E_FINANCE_PERMS = [
  'finance_reviews:view',
  'finance_reviews:review',
  'profit_snapshots:create',
  'commission_rules:manage',
  'commission_candidates:calculate',
  'commission_candidates:lock',
] as const;

const STAGE_2E_PERMS: { code: string; moduleId: string }[] = STAGE_2E_FINANCE_PERMS.map((code) => ({
  code,
  moduleId: FINANCE_MODULE_ID,
}));

const STAGE_2D_PERMS: { code: string; moduleId: string }[] = [
  { code: 'fulfillment:view', moduleId: ORDERS_MODULE_ID },
  { code: 'goods_receipts:manage', moduleId: PROCUREMENT_MODULE_ID },
  { code: 'goods_receipts:confirm', moduleId: ORDERS_MODULE_ID },
  { code: 'shipments:manage', moduleId: ORDERS_MODULE_ID },
  { code: 'order_expenses:record', moduleId: FINANCE_MODULE_ID },
];

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
  ...BILLING_PERMS.map((code) => ({ code, moduleId: FINANCE_MODULE_ID })),
  ...FINANCE_PERMS.map((code) => ({ code, moduleId: FINANCE_MODULE_ID })),
  ...WORKBENCH_PERMS.slice(0, 2).map((code) => ({ code, moduleId: SYSTEM_MODULE_ID })),
  ...WORKBENCH_PERMS.slice(2).map((code) => ({ code, moduleId: FINANCE_MODULE_ID })),
  ...AI_PERMS.map((code) => ({ code, moduleId: AI_MODULE_ID })),
  ...REPORTS_PERMS.map((code) => ({ code, moduleId: REPORTS_MODULE_ID })),
  ...AUDIT_PERMS.map((code) => ({ code, moduleId: SYSTEM_MODULE_ID })),
  ...USER_MGMT_PERMS.map((code) => ({ code, moduleId: SYSTEM_MODULE_ID })),
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

    // --- plans (seeded in db/seeds but not by pnpm migrate; required by SubscriptionService) ---
    await client.query(
      `INSERT INTO plans (id, code, name, description, price_monthly, price_yearly, currency, max_users, max_storage_gb, ai_quota_monthly, status, sort_order) VALUES
         ('b0000000-0000-0000-0000-000000000001','free','免费版','',0,0,'CNY',3,5,50,'active',1),
         ('b0000000-0000-0000-0000-000000000002','standard','标准版','',299,2990,'CNY',10,50,500,'active',2),
         ('b0000000-0000-0000-0000-000000000003','professional','专业版','',599,5990,'CNY',50,200,2000,'active',3)
       ON CONFLICT (code) DO NOTHING`,
    );

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
         ($6, 'finance', '财务管理', 4),
         ($7, 'ai', 'AI/OCR', 8),
         ($8, 'reports', '报表', 6)
       ON CONFLICT (code) DO NOTHING`,
      [
        CRM_MODULE_ID,
        ORDERS_MODULE_ID,
        PROCUREMENT_MODULE_ID,
        FILES_MODULE_ID,
        SYSTEM_MODULE_ID,
        FINANCE_MODULE_ID,
        AI_MODULE_ID,
        REPORTS_MODULE_ID,
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

    for (const { code, moduleId } of STAGE_2A_PERMS) {
      const action = code.split(':')[1];
      await client.query(
        `INSERT INTO permissions (module_id, code, name, action) VALUES ($1, $2, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [moduleId, code, action],
      );
    }

    for (const { code, moduleId } of STAGE_2B_PERMS) {
      const action = code.split(':')[1];
      await client.query(
        `INSERT INTO permissions (module_id, code, name, action) VALUES ($1, $2, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [moduleId, code, action],
      );
    }

    for (const { code, moduleId } of STAGE_2D_PERMS) {
      const action = code.split(':')[1];
      await client.query(
        `INSERT INTO permissions (module_id, code, name, action) VALUES ($1, $2, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [moduleId, code, action],
      );
    }

    for (const { code, moduleId } of STAGE_2E_PERMS) {
      const action = code.split(':')[1];
      await client.query(
        `INSERT INTO permissions (module_id, code, name, action) VALUES ($1, $2, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [moduleId, code, action],
      );
    }

    // Support-access permission rows (system module). Inserted so they exist,
    // but granted selectively below — NOT via the all-roles loop.
    for (const code of SUPPORT_ACCESS_PERMS) {
      const action = code.split(':')[1];
      await client.query(
        `INSERT INTO permissions (module_id, code, name, action) VALUES ($1, $2, $2, $3)
         ON CONFLICT (code) DO NOTHING`,
        [SYSTEM_MODULE_ID, code, action],
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

    const stage2ePermissionRows = await client.query<{ id: string }>(
      `SELECT id FROM permissions WHERE code = ANY($1)`,
      [STAGE_2E_FINANCE_PERMS as unknown as string[]],
    );
    for (const spec of ROLE_SPECS.filter((row) => row.roleId !== SALES_ROLE_ID)) {
      for (const permission of stage2ePermissionRows.rows) {
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
           VALUES ($1, $2, $3, 'all')`,
          [spec.tenantId, spec.roleId, permission.id],
        );
      }
    }

    const stage2dPermissionRows = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM permissions WHERE code = ANY($1)`,
      [STAGE_2D_PERMS.map(({ code }) => code)],
    );
    for (const spec of ROLE_SPECS) {
      const salesCodes: string[] = [
        'fulfillment:view',
        'goods_receipts:confirm',
        'shipments:manage',
        'order_expenses:record',
      ];
      const allowedCodes =
        spec.roleId === SALES_ROLE_ID ? salesCodes : STAGE_2D_PERMS.map(({ code }) => code);
      for (const permission of stage2dPermissionRows.rows) {
        if (!allowedCodes.includes(permission.code)) continue;
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
           VALUES ($1, $2, $3, $4)`,
          [spec.tenantId, spec.roleId, permission.id, spec.scope],
        );
      }
    }

    const stage2aPermissionRows = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM permissions WHERE code = ANY($1)`,
      [STAGE_2A_PERMS.map(({ code }) => code)],
    );
    for (const spec of ROLE_SPECS) {
      const allowedCodes =
        spec.roleId === SALES_ROLE_ID
          ? [...INQUIRY_PERMS, ...QUOTE_SELECTION_PERMS]
          : STAGE_2A_PERMS.map(({ code }) => code);
      for (const permission of stage2aPermissionRows.rows) {
        if (!allowedCodes.includes(permission.code as (typeof allowedCodes)[number])) continue;
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
           VALUES ($1, $2, $3, $4)`,
          [spec.tenantId, spec.roleId, permission.id, spec.scope],
        );
      }
    }

    const stage2bPermissionRows = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM permissions WHERE code = ANY($1)`,
      [STAGE_2B_PERMS.map(({ code }) => code)],
    );
    for (const spec of ROLE_SPECS) {
      const salesCodes: string[] = [
        ...PROFORMA_INVOICE_PERMS,
        'customer_receipts:view',
        'customer_receipts:record',
        ...PROCUREMENT_GATE_PERMS,
      ];
      const allowedCodes =
        spec.roleId === SALES_ROLE_ID ? salesCodes : STAGE_2B_PERMS.map(({ code }) => code);
      for (const permission of stage2bPermissionRows.rows) {
        if (!allowedCodes.includes(permission.code)) continue;
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
           VALUES ($1, $2, $3, $4)`,
          [spec.tenantId, spec.roleId, permission.id, spec.scope],
        );
      }
    }

    // Support-access grants: ONLY the two admin roles (scope=all). The sales
    // (scope=own) and no-role users get none, so the 403 / default-deny tests
    // hold (plan §6.1). Both tenant admins get them so cross-tenant isolation
    // can be exercised (tenant2 admin authorizing for its own tenant).
    const supportPermRes = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM permissions WHERE code = ANY($1)`,
      [SUPPORT_ACCESS_PERMS as unknown as string[]],
    );
    for (const { id: permissionId } of supportPermRes.rows) {
      for (const { roleId, tenantId } of [
        { roleId: ADMIN_ROLE_ID, tenantId: TEST_TENANT_ID },
        { roleId: T2_ADMIN_ROLE_ID, tenantId: TEST_TENANT2_ID },
      ]) {
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
           VALUES ($1, $2, $3, 'all')`,
          [tenantId, roleId, permissionId],
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

    // --- tenant_quota_usage (required by QuotaGuard; one row per tenant) ---
    await client.query(
      `INSERT INTO tenant_quota_usage (tenant_id, user_count, storage_bytes, ai_calls_month, ai_calls_reset_at, updated_at)
       VALUES
         ($1, 3, 0, 0, date_trunc('month', now()), now()),
         ($2, 1, 0, 0, date_trunc('month', now()), now())`,
      [TEST_TENANT_ID, TEST_TENANT2_ID],
    );

    // --- tenant_notification_settings (required by NotificationService) ---
    await client.query(
      `INSERT INTO tenant_notification_settings (tenant_id, updated_at)
       VALUES ($1, now()), ($2, now())
       ON CONFLICT (tenant_id) DO NOTHING`,
      [TEST_TENANT_ID, TEST_TENANT2_ID],
    );

    // --- tenant_modules: all modules enabled for both tenants (required by ModuleGuard) ---
    // Look up IDs by code at runtime — migration seeds may use different UUIDs than
    // the fixture constants, so hardcoding them causes FK mismatches.
    for (const tenantId of [TEST_TENANT_ID, TEST_TENANT2_ID]) {
      await client.query(
        `INSERT INTO tenant_modules (tenant_id, module_id, enabled)
         SELECT $1, m.id, true FROM modules m
         ON CONFLICT (tenant_id, module_id) DO NOTHING`,
        [tenantId],
      );
    }
  } finally {
    await client.end();
  }
}
