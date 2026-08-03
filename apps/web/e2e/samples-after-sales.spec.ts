import { APIRequestContext, APIResponse, expect, Page, test } from '@playwright/test';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const SALES_EMAIL = 'test-sales@test.local';
const ADMIN_EMAIL = 'test-user@test.local';
const PROFESSIONAL_PLAN_ID = 'b0000000-0000-0000-0000-000000000003';

let inquiryCode: string;
let productName: string;
let firstApproverName: string;
let secondApproverName: string;

async function json<T>(response: APIResponse): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${response.url()} failed: ${response.status()} ${await response.text()}`);
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function loginApi(request: APIRequestContext, email: string) {
  return json<{ accessToken: string }>(
    await request.post('/api/auth/login', {
      data: { email, password: PASSWORD, tenantSlug: TENANT_SLUG },
    }),
  );
}

async function loginPage(page: Page, email: string) {
  const logout = page.getByRole('button', { name: '登出' });
  if (await logout.isVisible()) {
    await logout.click();
  } else {
    await page.goto('/login');
  }
  const tenantSlug = page.getByLabel('租户标识 (tenant slug)');
  await expect(tenantSlug).toBeVisible();
  await tenantSlug.fill(TENANT_SLUG);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test.beforeAll(async ({ request }) => {
  const [sales, admin] = await Promise.all([
    loginApi(request, SALES_EMAIL),
    loginApi(request, ADMIN_EMAIL),
  ]);
  const salesHeaders = { Authorization: `Bearer ${sales.accessToken}` };
  const adminHeaders = { Authorization: `Bearer ${admin.accessToken}` };
  const platform = await json<{ accessToken: string }>(
    await request.post('/api/platform-auth/login', {
      data: { email: 'test-admin@test.local', password: PASSWORD },
    }),
  );
  await json(
    await request.put(`/api/platform/tenants/${TENANT_ID}/subscription`, {
      headers: { Authorization: `Bearer ${platform.accessToken}` },
      data: { planId: PROFESSIONAL_PLAN_ID },
    }),
  );
  await json(
    await request.put('/api/commercial-settings', {
      headers: adminHeaders,
      data: {
        minimum_margin_bps: 1000,
        procurement_gate_enabled: true,
        required_receipt_ratio_bps: 0,
        receipt_proof_required: false,
      },
    }),
  );

  const fixtureKey = Date.now().toString(36).toUpperCase();
  inquiryCode = `E2E-SAMPLE-${fixtureKey}`;
  productName = `E2E 样品 ${fixtureKey}`;
  const inquiry = await json<{ id: string; items: Array<{ id: string }> }>(
    await request.post('/api/inquiries', {
      headers: salesHeaders,
      data: {
        customer_code: inquiryCode,
        customer_country: 'DE',
        customer_message: 'Browser sample-order fixture',
        items: [{ description: productName, quantity: '12.000', unit: 'pcs' }],
      },
    }),
  );
  await json(
    await request.post(`/api/inquiries/${inquiry.id}/customer-upgrade`, {
      headers: salesHeaders,
      data: {
        company_name: `E2E Sample Customer ${fixtureKey}`,
        contact_name: 'Sample Buyer',
        email: `e2e-sample-${fixtureKey.toLowerCase()}@example.test`,
        country: 'DE',
      },
    }),
  );
  const submitted = await json<{ quote_task: { id: string } }>(
    await request.post(`/api/inquiries/${inquiry.id}/submit`, { headers: salesHeaders }),
  );
  await json(
    await request.put(`/api/quote-tasks/${submitted.quote_task.id}/manual`, {
      headers: adminHeaders,
      data: {
        summary: 'Browser sample requirement',
        items: [
          {
            inquiry_item_id: inquiry.items[0].id,
            description: productName,
            specifications: 'black finish',
            quantity: '12.000',
            unit: 'pcs',
          },
        ],
      },
    }),
  );
  const supplier = await json<{ id: string }>(
    await request.post('/api/suppliers', {
      headers: adminHeaders,
      data: { company_name: `E2E Sample Supplier ${fixtureKey}`, country: 'CN' },
    }),
  );
  const quotation = await json<{ lines: Array<{ id: string }> }>(
    await request.put(`/api/quote-tasks/${submitted.quote_task.id}/quotations`, {
      headers: adminHeaders,
      data: {
        supplier_id: supplier.id,
        expected_version: 0,
        currency: 'RMB',
        valid_until: '2099-12-31',
        lines: [
          {
            inquiry_item_id: inquiry.items[0].id,
            quantity: '12.000',
            unit_price: '40.0000',
          },
        ],
      },
    }),
  );
  await json(
    await request.post(`/api/inquiries/${inquiry.id}/selections`, {
      headers: salesHeaders,
      data: {
        quotation_line_id: quotation.lines[0].id,
        expected_quotation_version: 1,
        sales_currency: 'RMB',
        sales_unit_price: '80.0000',
      },
    }),
  );

  const catalog = await json<Array<{ permissions: Array<{ id: string; code: string }> }>>(
    await request.get('/api/permissions', { headers: adminHeaders }),
  );
  const permissionIds = new Map(
    catalog
      .flatMap((module) => module.permissions)
      .map((permission) => [permission.code, permission.id]),
  );
  const role = await json<{ id: string }>(
    await request.post('/api/roles', {
      headers: adminHeaders,
      data: {
        name: `E2E After-sales Approver ${fixtureKey}`,
        description: 'Two-level after-sales browser fixture',
      },
    }),
  );
  await json(
    await request.put(`/api/roles/${role.id}/permissions`, {
      headers: adminHeaders,
      data: {
        permissions: ['after_sales:view', 'after_sales:approve'].map((code) => {
          const permissionId = permissionIds.get(code);
          if (!permissionId) throw new Error(`Permission missing: ${code}`);
          return { permissionId, dataScope: 'all' };
        }),
      },
    }),
  );
  firstApproverName = `E2E 售后审批甲 ${fixtureKey}`;
  secondApproverName = `E2E 售后审批乙 ${fixtureKey}`;
  const firstApprover = await json<{ id: string }>(
    await request.post('/api/users', {
      headers: adminHeaders,
      data: {
        email: `e2e-after-sales-a-${fixtureKey.toLowerCase()}@test.local`,
        name: firstApproverName,
        password: PASSWORD,
        roleIds: [role.id],
      },
    }),
  );
  const secondApprover = await json<{ id: string }>(
    await request.post('/api/users', {
      headers: adminHeaders,
      data: {
        email: `e2e-after-sales-b-${fixtureKey.toLowerCase()}@test.local`,
        name: secondApproverName,
        password: PASSWORD,
        roleIds: [role.id],
      },
    }),
  );
  await json(
    await request.put('/api/after-sales/approval-config', {
      headers: adminHeaders,
      data: {
        steps: [{ approver_user_id: firstApprover.id }, { approver_user_id: secondApprover.id }],
      },
    }),
  );
});

test('真实样品状态机可在销售与管理员工作台完成并转为正式订单', async ({ page }) => {
  await loginPage(page, SALES_EMAIL);
  await page.getByRole('link', { name: '样品单' }).click();
  await expect(page.getByRole('heading', { name: '样品单' })).toBeVisible();
  await page.getByRole('button', { name: '新建样品单' }).click();
  const inquiryOption = page.getByLabel('询盘').locator('option').filter({ hasText: inquiryCode });
  const inquiryId = await inquiryOption.getAttribute('value');
  expect(inquiryId).toBeTruthy();
  await page.getByLabel('询盘').selectOption(inquiryId!);
  await page.getByLabel('收件人').fill('E2E Buyer');
  await page.getByLabel('联系电话').fill('+49 30 123456');
  await page.getByLabel('收件地址').fill('E2E Warehouse, Berlin');
  await page.getByLabel('国家或地区').fill('DE');
  await page.getByLabel(`${productName}样品数量`).fill('2.000');
  await page.getByRole('button', { name: '创建草稿' }).click();
  await expect(page.getByText('草稿', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '提交审批' }).click();
  await expect(page.getByText('待审批', { exact: true })).toBeVisible();

  await loginPage(page, ADMIN_EMAIL);
  await page.getByRole('link', { name: '样品单' }).click();
  await expect(page.getByText('待审批', { exact: true })).toBeVisible();
  await page.getByLabel('审批原因').fill('Browser approval');
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await page.getByLabel('承运商').fill('DHL');
  await page.getByLabel('运单号').fill(`E2E-${Date.now()}`);
  await page.getByRole('button', { name: '确认寄出' }).click();
  await page.getByLabel('签收人').fill('E2E Buyer');
  await page.getByRole('button', { name: '确认送达' }).click();
  await expect(page.getByText('已送达', { exact: true })).toBeVisible();

  await loginPage(page, SALES_EMAIL);
  await page.getByRole('link', { name: '样品单' }).click();
  await page.getByLabel('客户反馈').fill('Approved for production');
  await page.getByRole('button', { name: '确认客户反馈' }).click();
  await page.getByLabel('付款条款').fill('Full payment before production');
  await page.getByLabel(`${productName}转正式订单数量`).fill('5.000');
  await page.getByRole('button', { name: '生成正式订单' }).click();
  await expect(page.getByText('已转正式订单', { exact: true })).toBeVisible();
  await expect(page.getByText('正式订单', { exact: true })).toBeVisible();
});

test('管理员通过售后工作台发布冻结的两级审批流', async ({ page }) => {
  await loginPage(page, ADMIN_EMAIL);
  await page.getByRole('link', { name: '售后', exact: true }).click();
  await expect(page.getByRole('heading', { name: '售后', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '审批流' }).click();
  const currentVersionText = await page.getByText(/当前版本 \d+/).textContent();
  const currentVersion = Number(currentVersionText?.match(/\d+/)?.[0]);
  expect(currentVersion).toBeGreaterThan(0);
  await expect(page.getByLabel('第 1 级审批人')).toHaveValue(/.+/);
  await expect(page.getByLabel('第 2 级审批人')).toHaveValue(/.+/);
  await expect(page.getByLabel('第 1 级审批人').locator('option:checked')).toContainText(
    firstApproverName,
  );
  await expect(page.getByLabel('第 2 级审批人').locator('option:checked')).toContainText(
    secondApproverName,
  );
  await page.getByRole('button', { name: '发布新版本' }).click();
  await expect(page.getByText(`当前版本 ${currentVersion}`)).toHaveCount(0);
  await page.getByRole('button', { name: '审批流' }).click();
  await expect(page.getByText(`当前版本 ${currentVersion + 1}`)).toBeVisible();
});
