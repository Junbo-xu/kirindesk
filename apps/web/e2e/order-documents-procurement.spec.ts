import { APIRequestContext, expect, Page, test } from '@playwright/test';

const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const ADMIN_EMAIL = 'test-user@test.local';

let salesOrderId: string;
let salesOrderNumber: string;

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
  const customer = await json<{ id: string }>(
    await request.post('/api/customers', {
      headers,
      data: { company_name: `E2E Stage B Customer ${fixtureKey}`, country: 'GB' },
    }),
  );
  const supplierOne = await json<{ id: string }>(
    await request.post('/api/suppliers', {
      headers,
      data: { company_name: `E2E Stage B Supplier One ${fixtureKey}` },
    }),
  );
  const supplierTwo = await json<{ id: string }>(
    await request.post('/api/suppliers', {
      headers,
      data: { company_name: `E2E Stage B Supplier Two ${fixtureKey}` },
    }),
  );
  const productOne = await json<{ id: string }>(
    await request.post('/api/products', {
      headers,
      data: {
        sku: `E2E-B1-${fixtureKey}`,
        name: 'E2E Stage B product one',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '10.0000',
        cost_unit_price: '4.0000',
        supplier_id: supplierOne.id,
        purchase_currency: 'RMB',
        purchase_unit_price: '3.0000',
      },
    }),
  );
  const productTwo = await json<{ id: string }>(
    await request.post('/api/products', {
      headers,
      data: {
        sku: `E2E-B2-${fixtureKey}`,
        name: 'E2E Stage B product two',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '12.0000',
        cost_unit_price: '5.0000',
        supplier_id: supplierTwo.id,
        purchase_currency: 'USD',
        purchase_unit_price: '4.5000',
      },
    }),
  );
  salesOrderNumber = `SO-E2E-B-${fixtureKey}`;
  const order = await json<{ id: string }>(
    await request.post('/api/sales-orders', {
      headers,
      data: {
        customer_id: customer.id,
        order_number: salesOrderNumber,
        currency: 'USD',
        items: [
          {
            product_id: productOne.id,
            description: 'E2E Stage B product one',
            product_code: `E2E-B1-${fixtureKey}`,
            unit: 'pcs',
            quantity: '2.000',
            unit_price: '10.0000',
          },
          {
            product_id: productTwo.id,
            description: 'E2E Stage B product two',
            product_code: `E2E-B2-${fixtureKey}`,
            unit: 'pcs',
            quantity: '3.000',
            unit_price: '12.0000',
          },
        ],
      },
    }),
  );
  salesOrderId = order.id;
});

test('browser drives order documents, lock, and supplier-split purchase orders', async ({
  page,
}) => {
  await loginPage(page);
  await page.goto(`/orders/${salesOrderId}/edit`);
  await expect(page.getByRole('heading', { name: '编辑订单' })).toBeVisible();
  await expect(page.getByText('履约生成')).toBeVisible();

  await page.getByRole('button', { name: '生成 / 刷新 PI、SC、CI、PL' }).click();
  await expect(page.getByText(/PI \/ SC \/ CI \/ PL 已/)).toBeVisible();

  const lockButton = page.getByRole('button', { name: '锁定履约快照' });
  if (await lockButton.isEnabled()) {
    await lockButton.click();
  }
  await expect(page.getByText(/^履约快照已锁定：/)).toBeVisible();
  await expect(page.getByRole('button', { name: '保存' })).toBeDisabled();

  await page.getByRole('button', { name: '按供应商生成采购单' }).click();
  await expect(page.getByText('已按供应商拆分生成 2 张采购单。')).toBeVisible();

  await page.getByRole('link', { name: '打开单证工作台' }).click();
  await expect(page).toHaveURL(new RegExp('/documents\\?document=[0-9a-f-]+$'));
  await expect(
    page.getByRole('heading', {
      name: `DOC-${salesOrderNumber.slice(0, 45)}-${salesOrderId.slice(0, 8)}`,
    }),
  ).toBeVisible();
});
