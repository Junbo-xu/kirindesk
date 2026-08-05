import { APIRequestContext, APIResponse, expect, Page, test } from '@playwright/test';

const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const OWNER_EMAIL = 'test-user@test.local';
const SALES_EMAIL = 'test-sales@test.local';

let procurementQuoteTaskId: string;
let procurementSupplierId: string;
let procurementSupplierName: string;
let sensitiveCustomerCode: string;
let sensitiveCustomerMessage: string;

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
  await page.goto('/login');
  await page.getByLabel('租户标识 (tenant slug)').fill(TENANT_SLUG);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test.beforeAll(async ({ request }) => {
  const owner = await loginApi(request, OWNER_EMAIL);
  const headers = { Authorization: `Bearer ${owner.accessToken}` };
  const fixtureKey = Date.now().toString(36).toUpperCase();
  sensitiveCustomerCode = `P0-SENSITIVE-${fixtureKey}`;
  sensitiveCustomerMessage = `P0 confidential buyer request ${fixtureKey}`;
  const inquiry = await json<{
    id: string;
    source_version: number;
    items: Array<{ id: string }>;
  }>(
    await request.post('/api/inquiries', {
      headers,
      data: {
        customer_code: sensitiveCustomerCode,
        customer_country: 'NL',
        customer_message: sensitiveCustomerMessage,
        items: [
          {
            description: `P0 sanitized pump ${fixtureKey}`,
            specifications: '220V',
            quantity: '12.000',
            unit: 'pcs',
          },
          {
            description: `P0 sanitized valve ${fixtureKey}`,
            specifications: 'DN20',
            quantity: '24.000',
            unit: 'pcs',
          },
        ],
      },
    }),
  );
  const submitted = await json<{ quote_task: { id: string } }>(
    await request.post(`/api/inquiries/${inquiry.id}/submit`, {
      headers,
      data: { expected_version: inquiry.source_version },
    }),
  );
  procurementQuoteTaskId = submitted.quote_task.id;
  await json(
    await request.put(`/api/quote-tasks/${procurementQuoteTaskId}/manual`, {
      headers,
      data: {
        summary: `P0 sanitized requirement ${fixtureKey}`,
        items: [
          {
            inquiry_item_id: inquiry.items[0].id,
            description: `P0 sanitized pump ${fixtureKey}`,
            specifications: '220V',
            quantity: '12.000',
            unit: 'pcs',
          },
          {
            inquiry_item_id: inquiry.items[1].id,
            description: `P0 sanitized valve ${fixtureKey}`,
            specifications: 'DN20',
            quantity: '24.000',
            unit: 'pcs',
          },
        ],
      },
    }),
  );
  procurementSupplierName = `P0 Supplier ${fixtureKey}`;
  const supplier = await json<{ id: string }>(
    await request.post('/api/suppliers', {
      headers,
      data: { company_name: procurementSupplierName, country: 'CN' },
    }),
  );
  procurementSupplierId = supplier.id;
});

const loadStatePages = [
  {
    name: '询盘',
    path: '/inquiries',
    apiPath: '**/api/inquiries',
    loadingText: '正在加载询盘…',
    emptyText: '暂无询盘。',
  },
  {
    name: '商务',
    path: '/commercial',
    apiPath: '**/api/inquiries',
    loadingText: '正在加载商务数据…',
    emptyText: '暂无可处理询盘。',
  },
  {
    name: '财务',
    path: '/finance',
    apiPath: '**/api/finance/orders',
    loadingText: '正在加载财务数据…',
    emptyText: '暂无待核对订单',
  },
] as const;

for (const scenario of loadStatePages) {
  test(`${scenario.name}页区分 loading 与空数据`, async ({ page }) => {
    await loginPage(page, OWNER_EMAIL);
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route(scenario.apiPath, async (route) => {
      await responseGate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto(scenario.path);
    await expect(page.getByText(scenario.loadingText, { exact: true })).toBeVisible();
    releaseResponse();
    await expect(page.getByText(scenario.emptyText, { exact: true })).toBeVisible();
    await expect(page.getByText(scenario.loadingText, { exact: true })).toHaveCount(0);
  });

  for (const status of [403, 500] as const) {
    test(`${scenario.name}页呈现 ${status} 并可重试`, async ({ page }) => {
      await loginPage(page, OWNER_EMAIL);
      let attempts = 0;
      await page.route(scenario.apiPath, async (route) => {
        attempts += 1;
        if (attempts === 1) {
          await route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({ message: `P0 simulated ${status}` }),
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      });

      await page.goto(scenario.path);
      await expect(
        page.getByText(status === 403 ? '无权访问（403）' : '服务暂时不可用（500）', {
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole('button', { name: '重试' }).click();
      await expect(page.getByText(scenario.emptyText, { exact: true })).toBeVisible();
      expect(attempts).toBe(2);
    });
  }
}

test('未知售后状态显式展示 unknown 与原值诊断', async ({ page }) => {
  await loginPage(page, OWNER_EMAIL);
  const now = new Date().toISOString();
  await page.route('**/api/after-sales-cases', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'c1000000-0000-4000-8000-000000000001',
          sales_order_id: 'c1000000-0000-4000-8000-000000000002',
          order_number: 'SO-P0-UNKNOWN',
          shipment_id: null,
          case_number: 'AS-P0-UNKNOWN',
          case_type: 'refund',
          responsibility: 'supplier',
          reason: '验证未知状态不被静默丢弃',
          requested_amount: '10.00',
          currency: 'USD',
          proof_file_id: null,
          status: 'unknown',
          status_diagnostic: {
            code: 'UNKNOWN_AFTER_SALES_STATUS',
            received_status: 'vendor_pending_review',
            message: 'Unsupported after-sales status received: vendor_pending_review',
          },
          requested_by: 'a1000000-0000-4000-8000-000000000001',
          approval_config: { id: 'c1000000-0000-4000-8000-000000000003', version: 1 },
          current_approval_step: null,
          approval_steps: [],
          adjustment: null,
          completed_at: null,
          closed_at: null,
          created_at: now,
          updated_at: now,
        },
      ]),
    });
  });

  await page.goto('/after-sales');
  await expect(page.getByText('未知状态', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/UNKNOWN_AFTER_SALES_STATUS（原值 vendor_pending_review）/),
  ).toBeVisible();
  await expect(
    page.getByText('UNKNOWN_AFTER_SALES_STATUS：原始状态“vendor_pending_review”不受支持', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(1);
});

test('询盘草稿支持多产品行、并发恢复与提交', async ({ page, request }) => {
  await loginPage(page, SALES_EMAIL);
  await page.getByRole('link', { name: '询盘', exact: true }).click();
  const fixtureKey = Date.now().toString(36).toUpperCase();
  const customerCode = `P0-DRAFT-${fixtureKey}`;
  await page.getByRole('button', { name: '新建询盘' }).click();
  await page.getByLabel('客户代号').fill(customerCode);
  await page.getByLabel('国家/地区').fill('DE');
  await page.getByLabel('客户原始需求').fill(`P0 initial request ${fixtureKey}`);
  await page.getByLabel('第 1 行产品').fill('P0 pump');
  await page.getByLabel('第 1 行数量').fill('0');
  await page.getByLabel('第 1 行单位').fill('pcs');
  await page.getByRole('button', { name: '添加产品行' }).click();
  await page.getByLabel('第 2 行产品').fill('P0 valve');
  await page.getByLabel('第 2 行数量').fill('2.500');
  await page.getByLabel('第 2 行单位').fill('pcs');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByRole('alert')).toContainText('第 1 行数量必须为大于 0');
  await page.getByLabel('第 1 行数量').fill('1.250');
  await page.getByRole('button', { name: '保存草稿' }).click();

  let inquiryCard = page.locator('article').filter({ hasText: customerCode });
  await expect(inquiryCard).toContainText('2 个产品行');
  await expect(inquiryCard).toContainText('草稿 · v1');
  await inquiryCard.getByRole('button', { name: '编辑草稿' }).click();
  await expect(page.getByRole('heading', { name: '编辑草稿 v1' })).toBeVisible();

  const sales = await loginApi(request, SALES_EMAIL);
  const headers = { Authorization: `Bearer ${sales.accessToken}` };
  const inquiries = await json<Array<{ id: string; customer_code: string }>>(
    await request.get('/api/inquiries', { headers }),
  );
  const inquiryId = inquiries.find((row) => row.customer_code === customerCode)?.id;
  expect(inquiryId).toBeTruthy();
  await json(
    await request.patch(`/api/inquiries/${inquiryId}`, {
      headers,
      data: {
        expected_version: 1,
        customer_code: customerCode,
        customer_country: 'DE',
        customer_message: `P0 parallel update ${fixtureKey}`,
        items: [
          { description: 'P0 pump', quantity: '1.250', unit: 'pcs' },
          { description: 'P0 valve', quantity: '2.500', unit: 'pcs' },
        ],
      },
    }),
  );

  await page.getByLabel('客户原始需求').fill(`P0 stale browser update ${fixtureKey}`);
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByRole('alert')).toContainText('询盘版本已变化');
  inquiryCard = page.locator('article').filter({ hasText: customerCode });
  await expect(inquiryCard).toContainText('草稿 · v2');

  await page.getByRole('button', { name: '关闭表单' }).click();
  await inquiryCard.getByRole('button', { name: '编辑草稿' }).click();
  await expect(page.getByRole('heading', { name: '编辑草稿 v2' })).toBeVisible();
  await page.getByLabel('客户原始需求').fill(`P0 resolved update ${fixtureKey}`);
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(inquiryCard).toContainText('草稿 · v3');
  await inquiryCard.getByRole('button', { name: '提交询盘' }).click();
  await expect(inquiryCard).toContainText('已提交 · v3');
  await expect(inquiryCard.getByRole('button', { name: '编辑草稿' })).toHaveCount(0);
});

test('报价任务网页覆盖幂等重试、录入、校正、历史与脱敏', async ({ page }) => {
  await loginPage(page, OWNER_EMAIL);
  let firstList = true;
  await page.route('**/api/quote-tasks', async (route) => {
    const response = await route.fetch();
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    if (firstList) {
      firstList = false;
      for (const row of rows) {
        if (row.id === procurementQuoteTaskId) {
          row.sanitization_status = 'timeout';
          row.last_error_code = 'P0_SIMULATED_TIMEOUT';
        }
      }
    }
    await route.fulfill({ response, json: rows });
  });

  await page.goto('/quote-tasks');
  await page.getByLabel('当前报价任务').selectOption(procurementQuoteTaskId);
  await expect(page.getByText('超时', { exact: true })).toBeVisible();
  await expect(page.getByText('失败代码：P0_SIMULATED_TIMEOUT', { exact: true })).toBeVisible();
  await expect(page.getByText(sensitiveCustomerCode, { exact: true })).toHaveCount(0);
  await expect(page.getByText(sensitiveCustomerMessage, { exact: true })).toHaveCount(0);

  const retryResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/quote-tasks/${procurementQuoteTaskId}/retry`) &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '幂等重试脱敏任务' }).click();
  expect((await retryResponse).ok()).toBe(true);
  await expect(page.getByRole('button', { name: '幂等重试脱敏任务' })).toHaveCount(0);

  await page.getByRole('button', { name: '录入供应商报价' }).click();
  await page.getByLabel('报价供应商').selectOption(procurementSupplierId);
  await page.getByLabel('报价来源原文').fill('P0 supplier quote source');
  await page.getByLabel('第 1 行采购单价').fill('10.0000');
  await page.getByLabel('第 2 行采购单价').fill('20.0000');
  await page.getByRole('button', { name: '保存报价版本' }).click();

  let quotationCard = page.locator('article').filter({ hasText: procurementSupplierName });
  await expect(quotationCard).toContainText('· v1');
  await quotationCard.getByRole('button', { name: '校正报价' }).click();
  await expect(page.getByRole('heading', { name: '校正报价 v1' })).toBeVisible();
  await page.getByLabel('第 1 行采购单价').fill('11.0000');
  await page.getByRole('button', { name: '保存报价版本' }).click();
  quotationCard = page.locator('article').filter({ hasText: procurementSupplierName });
  await expect(quotationCard).toContainText('· v2');
  await quotationCard.getByRole('button', { name: '版本历史' }).click();
  const history = page.getByRole('region', { name: '报价版本历史' });
  await expect(history.getByRole('heading')).toContainText('当前 v2');
  await expect(history).toContainText('v1 · 首次录入');
  await expect(history).toContainText('v2 · 校正');
});
