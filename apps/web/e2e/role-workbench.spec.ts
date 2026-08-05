import { APIRequestContext, expect, Page, test } from '@playwright/test';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const PROFESSIONAL_PLAN_ID = 'b0000000-0000-0000-0000-000000000003';

interface RoleSpec {
  key: string;
  name: string;
  email: string;
  permissions: Record<string, 'all' | 'assigned' | 'own'>;
}

const ROLE_SPECS: RoleSpec[] = [
  {
    key: 'business',
    name: 'E2E Business Role',
    email: 'e2e-business@test.local',
    permissions: {
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
    key: 'procurement',
    name: 'E2E Procurement Role',
    email: 'e2e-procurement@test.local',
    permissions: {
      'workbench:view': 'all',
      'business_events:view': 'assigned',
      'business_exceptions:view': 'assigned',
      'business_exceptions:resolve': 'assigned',
      'suppliers:view': 'all',
      'quotations:view': 'all',
      'quotations:manage': 'all',
      'procurement:view': 'all',
    },
  },
  {
    key: 'finance',
    name: 'E2E Finance Role',
    email: 'e2e-finance@test.local',
    permissions: {
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
    key: 'approver',
    name: 'E2E Approver Role',
    email: 'e2e-approver@test.local',
    permissions: {
      'workbench:view': 'all',
      'business_events:view': 'all',
      'business_exceptions:view': 'all',
      'business_exceptions:assign': 'all',
      'orders:approve': 'all',
      'procurement:approve': 'all',
    },
  },
];

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${response.url()} failed: ${response.status()} ${await response.text()}`);
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function loginApi(request: APIRequestContext, path: string, body: Record<string, string>) {
  const response = await request.post(path, { data: body });
  return json<{ accessToken: string }>(response);
}

async function ensureRoleUsers(request: APIRequestContext) {
  const platform = await loginApi(request, '/api/platform-auth/login', {
    email: 'test-admin@test.local',
    password: PASSWORD,
  });
  await json(
    await request.put(`/api/platform/tenants/${TENANT_ID}/subscription`, {
      headers: { Authorization: `Bearer ${platform.accessToken}` },
      data: { planId: PROFESSIONAL_PLAN_ID },
    }),
  );

  const admin = await loginApi(request, '/api/auth/login', {
    email: 'test-user@test.local',
    password: PASSWORD,
    tenantSlug: TENANT_SLUG,
  });
  const headers = { Authorization: `Bearer ${admin.accessToken}` };
  const catalog = await json<Array<{ permissions: Array<{ id: string; code: string }> }>>(
    await request.get('/api/permissions', { headers }),
  );
  const permissionIds = new Map(
    catalog
      .flatMap((module) => module.permissions)
      .map((permission) => [permission.code, permission.id]),
  );
  const roles = await json<Array<{ id: string; name: string }>>(
    await request.get('/api/roles', { headers }),
  );

  for (const spec of ROLE_SPECS) {
    let role = roles.find((candidate) => candidate.name === spec.name);
    if (!role) {
      role = await json<{ id: string; name: string }>(
        await request.post('/api/roles', {
          headers,
          data: { name: spec.name, description: `Real browser role fixture: ${spec.key}` },
        }),
      );
      roles.push(role);
    }
    const grants = Object.entries(spec.permissions).map(([code, dataScope]) => {
      const permissionId = permissionIds.get(code);
      if (!permissionId) throw new Error(`Permission missing from catalog: ${code}`);
      return { permissionId, dataScope };
    });
    await json(
      await request.put(`/api/roles/${role.id}/permissions`, {
        headers,
        data: { permissions: grants },
      }),
    );

    const users = await json<{ data: Array<{ id: string; email: string }> }>(
      await request.get(`/api/users?q=${encodeURIComponent(spec.email)}&pageSize=10`, { headers }),
    );
    const user = users.data.find((candidate) => candidate.email === spec.email);
    if (user) {
      await json(
        await request.put(`/api/users/${user.id}/roles`, {
          headers,
          data: { roleIds: [role.id] },
        }),
      );
    } else {
      await json(
        await request.post('/api/users', {
          headers,
          data: {
            email: spec.email,
            name: `E2E ${spec.key}`,
            password: PASSWORD,
            roleIds: [role.id],
          },
        }),
      );
    }
  }
}

async function loginPage(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('租户标识 (tenant slug)').fill(TENANT_SLUG);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: '角色工作台' })).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  await ensureRoleUsers(request);
});

test('业务角色只看到业务导航和本人范围工作台', async ({ page }) => {
  await loginPage(page, 'e2e-business@test.local');
  await expect(page.getByText('业务', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '客户' })).toBeVisible();
  await expect(page.getByRole('link', { name: '询盘', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '供应商' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '经营报表' })).toHaveCount(0);
});

test('采购角色只看到脱敏采购入口', async ({ page }) => {
  await loginPage(page, 'e2e-procurement@test.local');
  await expect(page.getByText('采购', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '供应商' })).toBeVisible();
  await expect(page.getByRole('link', { name: '报价任务', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '客户' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '经营报表' })).toHaveCount(0);
});

test('财务角色看到经营摘要、水印和财务入口', async ({ page }) => {
  await loginPage(page, 'e2e-finance@test.local');
  await expect(page.getByRole('main').getByText('财务', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '经营报表' })).toBeVisible();
  await expect(page.getByRole('link', { name: '提成' })).toBeVisible();
  await page.getByRole('link', { name: '经营报表' }).click();
  await expect(page.getByTestId('sensitive-watermark')).toContainText('e2e-finance@test.local');
  await expect(page.getByRole('link', { name: '客户' })).toHaveCount(0);
});

test('审批人工作台展示审批待办而不扩张财务导航', async ({ page }) => {
  await loginPage(page, 'e2e-approver@test.local');
  await expect(page.getByText('审批', { exact: true })).toBeVisible();
  await expect(page.getByText('待审销售订单')).toBeVisible();
  await expect(page.getByText('待审采购订单')).toBeVisible();
  await expect(page.getByRole('link', { name: '经营报表' })).toHaveCount(0);
});

test('管理员工作台保留租户治理入口', async ({ page }) => {
  await loginPage(page, 'test-user@test.local');
  await expect(page.getByRole('main').getByText('管理', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '用户', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '角色', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '审计' })).toBeVisible();
});
