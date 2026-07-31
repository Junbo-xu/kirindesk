import { APIRequestContext, expect, Page, test } from '@playwright/test';

const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const SALES_EMAIL = 'test-sales@test.local';
const ADMIN_EMAIL = 'test-user@test.local';

let inquiryId: string;
let piNumber: string;

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  if (!response.ok()) {
    throw new Error(
      `${response.request().method()} ${response.url()} failed: ${response.status()} ${await response.text()}`,
    );
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
  const [sales, admin] = await Promise.all([
    loginApi(request, SALES_EMAIL),
    loginApi(request, ADMIN_EMAIL),
  ]);
  const salesHeaders = { Authorization: `Bearer ${sales.accessToken}` };
  const adminHeaders = { Authorization: `Bearer ${admin.accessToken}` };

  await json(
    await request.put('/api/commercial-settings', {
      headers: adminHeaders,
      data: {
        minimum_margin_bps: 1000,
        procurement_gate_enabled: true,
        required_receipt_ratio_bps: 10000,
        receipt_proof_required: false,
      },
    }),
  );

  const fixtureKey = Date.now().toString(36).toUpperCase();
  const inquiry = await json<{
    id: string;
    items: Array<{ id: string }>;
  }>(
    await request.post('/api/inquiries', {
      headers: salesHeaders,
      data: {
        customer_code: `E2E-PI-${fixtureKey}`,
        customer_country: 'US',
        customer_message: 'Synthetic browser workflow fixture',
        items: [
          {
            description: 'E2E commercial sample',
            quantity: '2.000',
            unit: 'pcs',
            target_price_usd: '2.0000',
          },
        ],
      },
    }),
  );
  inquiryId = inquiry.id;
  await json(
    await request.post(`/api/inquiries/${inquiryId}/customer-upgrade`, {
      headers: salesHeaders,
      data: {
        company_name: `E2E Commercial Customer ${fixtureKey}`,
        email: `e2e-commercial-${fixtureKey.toLowerCase()}@example.test`,
        country: 'US',
      },
    }),
  );
  const submitted = await json<{ quote_task: { id: string } }>(
    await request.post(`/api/inquiries/${inquiryId}/submit`, { headers: salesHeaders }),
  );
  await json(
    await request.put(`/api/quote-tasks/${submitted.quote_task.id}/manual`, {
      headers: adminHeaders,
      data: {
        summary: 'Synthetic browser product requirement',
        items: [
          {
            inquiry_item_id: inquiry.items[0].id,
            description: 'E2E commercial sample',
            specifications: null,
            quantity: '2.000',
            unit: 'pcs',
          },
        ],
      },
    }),
  );
  const supplier = await json<{ id: string }>(
    await request.post('/api/suppliers', {
      headers: adminHeaders,
      data: { company_name: `E2E Supplier ${fixtureKey}` },
    }),
  );
  const quotation = await json<{
    lines: Array<{ id: string }>;
  }>(
    await request.put(`/api/quote-tasks/${submitted.quote_task.id}/quotations`, {
      headers: adminHeaders,
      data: {
        supplier_id: supplier.id,
        expected_version: 0,
        currency: 'USD',
        valid_until: '2099-12-31',
        lines: [
          {
            inquiry_item_id: inquiry.items[0].id,
            quantity: '2.000',
            unit_price: '1.0000',
          },
        ],
      },
    }),
  );
  const selection = await json<{ id: string }>(
    await request.post(`/api/inquiries/${inquiryId}/selections`, {
      headers: salesHeaders,
      data: {
        quotation_line_id: quotation.lines[0].id,
        expected_quotation_version: 1,
        sales_currency: 'USD',
        sales_unit_price: '2.0000',
      },
    }),
  );
  const pi = await json<{ id: string; pi_number: string }>(
    await request.post(`/api/inquiries/${inquiryId}/proforma-invoices`, {
      headers: salesHeaders,
      data: {
        selection_ids: [selection.id],
        payment_terms: 'Full payment before procurement',
      },
    }),
  );
  piNumber = pi.pi_number;
  await json(
    await request.post(`/api/proforma-invoices/${pi.id}/issue`, { headers: salesHeaders }),
  );
});

test('browser completes PI confirmation, receipt review, gate opening, and watermarked export', async ({
  browser,
}) => {
  const salesContext = await browser.newContext({ acceptDownloads: true });
  const salesPage = await salesContext.newPage();
  await loginPage(salesPage, SALES_EMAIL);
  await salesPage.getByRole('link', { name: 'PI 与收款' }).click();
  await expect(salesPage).toHaveURL(/\/commercial$/);
  await salesPage.getByLabel('当前询盘').selectOption(inquiryId);
  await expect(salesPage.getByTestId('sensitive-watermark')).toContainText(SALES_EMAIL);
  await expect(salesPage.getByTestId('commercial-selection')).toContainText('毛利 50.00%');
  await expect(salesPage.getByText(piNumber, { exact: false })).toBeVisible();

  const downloadPromise = salesPage.waitForEvent('download');
  await salesPage.getByRole('button', { name: '导出水印 PI' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('.html');

  await salesPage.getByRole('button', { name: '记录客户确认' }).click();
  await expect(salesPage.getByText('闸门：已阻断')).toBeVisible();
  await salesPage.getByLabel('收款金额').fill('4.00');
  await salesPage.getByLabel('外部流水号').fill(`E2E-RECEIPT-${Date.now()}`);
  await salesPage.getByRole('button', { name: '记录外部到款事实' }).click();
  await expect(salesPage.getByText('待内部核对')).toBeVisible();
  await expect(salesPage.getByText('已确认 USD 0.00 / 要求 4.00')).toBeVisible();

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPage(adminPage, ADMIN_EMAIL);
  await adminPage.getByRole('link', { name: 'PI 与收款' }).click();
  await adminPage.getByLabel('当前询盘').selectOption(inquiryId);
  await expect(adminPage.getByTestId('sensitive-watermark')).toContainText(ADMIN_EMAIL);
  await adminPage.getByRole('button', { name: '确认', exact: true }).click();
  await expect(adminPage.getByText('闸门：已开启')).toBeVisible();
  await expect(adminPage.getByText('已确认 USD 4.00 / 要求 4.00')).toBeVisible();

  await adminContext.close();
  await salesContext.close();
});

test('permission guard blocks direct access to the sensitive commercial page', async ({ page }) => {
  await loginPage(page, 'test-noperm@test.local');
  await page.goto('/commercial');
  await expect(page).toHaveURL(/\/forbidden$/);
  await expect(page.getByRole('heading', { name: '没有访问权限' })).toBeVisible();
});
