import { APIRequestContext, expect, Page, test } from '@playwright/test';

const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const ADMIN_EMAIL = 'test-user@test.local';

let documentId: string;
let quoteNumber: string;

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  if (!response.ok()) {
    throw new Error(
      `${response.request().method()} ${response.url()} failed: ${response.status()} ${await response.text()}`,
    );
  }
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

async function loginApi(request: APIRequestContext) {
  return json<{ accessToken: string }>(
    await request.post('/api/auth/login', {
      data: { email: ADMIN_EMAIL, password: PASSWORD, tenantSlug: TENANT_SLUG },
    }),
  );
}

async function loginPage(page: Page) {
  await page.goto('/login');
  await page.getByLabel('租户标识 (tenant slug)').fill(TENANT_SLUG);
  await page.getByLabel('邮箱').fill(ADMIN_EMAIL);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test.beforeAll(async ({ request }) => {
  const admin = await loginApi(request);
  const headers = { Authorization: `Bearer ${admin.accessToken}` };
  const fixtureKey = Date.now().toString(36).toUpperCase();
  quoteNumber = `QT-E2E-${fixtureKey}`;
  const customer = await json<{ id: string }>(
    await request.post('/api/customers', {
      headers,
      data: { company_name: `E2E Quote Customer ${fixtureKey}`, country: 'GB' },
    }),
  );
  const document = await json<{ document_set_id: string }>(
    await request.post('/api/document-sets', {
      headers,
      data: {
        customer_id: customer.id,
        quote_number: quoteNumber,
        pricing_mode: 'final_price',
        language: 'en',
        incoterm: 'FOB',
        pricing_currency: 'USD',
        settlement_currency: 'USD',
        exchange_rate: '1',
        lines: [
          {
            sku: `E2E-${fixtureKey}`,
            name: 'Browser quote conversion product',
            quantity: '3.000',
            unit: 'pcs',
            unit_price: '12.3456',
          },
        ],
      },
    }),
  );
  documentId = document.document_set_id;
});

test('browser converts a quote and follows both sides of the relationship', async ({ page }) => {
  await loginPage(page);
  await page.goto(`/documents?document=${documentId}`);
  await expect(page.getByRole('heading', { name: quoteNumber })).toBeVisible();
  await expect(page.getByText('转单不依赖客户确认')).toBeVisible();
  await page.getByLabel('订单号', { exact: true }).fill(`SO-E2E-${Date.now().toString(36)}`);
  await page.getByRole('button', { name: '从当前报价版本创建销售订单' }).click();
  await expect(page.getByRole('status')).toContainText('已创建销售订单');
  await page.getByRole('link', { name: '查看订单' }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+\/edit$/);
  await expect(page.getByRole('heading', { name: '编辑订单' })).toBeVisible();
  const sourceLink = page.getByRole('link', { name: new RegExp(`${quoteNumber} v1`) });
  await expect(sourceLink).toBeVisible();
  await sourceLink.click();
  await expect(page).toHaveURL(new RegExp(`/documents\\?document=${documentId}$`));
  await expect(page.getByRole('heading', { name: quoteNumber })).toBeVisible();
  await expect(page.getByRole('link', { name: '查看订单' })).toBeVisible();
});
