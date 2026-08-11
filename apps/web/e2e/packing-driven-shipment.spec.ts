import { APIRequestContext, expect, Page, test } from '@playwright/test';

const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const ADMIN_EMAIL = 'test-user@test.local';

let salesOrderId: string;

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

async function loginPage(page: Page) {
  await page.goto('/login');
  await page.getByLabel('租户标识 (tenant slug)').fill(TENANT_SLUG);
  await page.getByLabel('邮箱').fill(ADMIN_EMAIL);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}

test.beforeAll(async ({ request }) => {
  const admin = await loginApi(request, ADMIN_EMAIL);
  const adminHeaders = { Authorization: `Bearer ${admin.accessToken}` };
  const fixtureKey = Date.now().toString(36).toUpperCase();

  const catalog = await json<Array<{ permissions: Array<{ id: string; code: string }> }>>(
    await request.get('/api/permissions', { headers: adminHeaders }),
  );
  const permissionIds = new Map(
    catalog
      .flatMap((module) => module.permissions)
      .map((permission) => [permission.code, permission.id]),
  );
  const approverRole = await json<{ id: string }>(
    await request.post('/api/roles', {
      headers: adminHeaders,
      data: {
        name: `E2E Packing Approver ${fixtureKey}`,
        description: 'Independent sales and procurement approval for packing-driven shipment E2E',
      },
    }),
  );
  const approverCodes = [
    'orders:view',
    'orders:approve',
    'procurement:view',
    'procurement:update',
    'procurement:approve',
  ];
  await json(
    await request.put(`/api/roles/${approverRole.id}/permissions`, {
      headers: adminHeaders,
      data: {
        permissions: approverCodes.map((code) => {
          const permissionId = permissionIds.get(code);
          if (!permissionId) throw new Error(`Permission missing from catalog: ${code}`);
          return { permissionId, dataScope: 'all' };
        }),
      },
    }),
  );
  const approverEmail = `e2e-packing-approver-${fixtureKey.toLowerCase()}@test.local`;
  await json(
    await request.post('/api/users', {
      headers: adminHeaders,
      data: {
        email: approverEmail,
        name: `E2E Packing Approver ${fixtureKey}`,
        password: PASSWORD,
        roleIds: [approverRole.id],
      },
    }),
  );
  const approver = await loginApi(request, approverEmail);
  const approverHeaders = { Authorization: `Bearer ${approver.accessToken}` };

  const customer = await json<{ id: string }>(
    await request.post('/api/customers', {
      headers: adminHeaders,
      data: { company_name: `E2E Packing Customer ${fixtureKey}`, country: 'DE' },
    }),
  );
  const supplier = await json<{ id: string }>(
    await request.post('/api/suppliers', {
      headers: adminHeaders,
      data: { company_name: `E2E Packing Supplier ${fixtureKey}` },
    }),
  );
  const product = await json<{ id: string }>(
    await request.post('/api/products', {
      headers: adminHeaders,
      data: {
        sku: `E2E-PACK-${fixtureKey}`,
        name: 'E2E packing-driven product',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '25.0000',
        cost_unit_price: '11.0000',
        supplier_id: supplier.id,
        purchase_currency: 'USD',
        purchase_unit_price: '10.0000',
        weight_kg: '2.5000',
        volume_cbm: '0.020000',
      },
    }),
  );
  const order = await json<{ id: string; updated_at: string }>(
    await request.post('/api/sales-orders', {
      headers: adminHeaders,
      data: {
        customer_id: customer.id,
        order_number: `SO-E2E-PACK-${fixtureKey}`,
        currency: 'USD',
        items: [
          {
            product_id: product.id,
            description: 'E2E packing-driven product',
            product_code: `E2E-PACK-${fixtureKey}`,
            unit: 'pcs',
            quantity: '2.000',
            unit_price: '25.0000',
          },
        ],
      },
    }),
  );
  salesOrderId = order.id;
  const locked = await json<{ sales_order: { updated_at: string } }>(
    await request.post(`/api/sales-orders/${order.id}/fulfillment-lock`, {
      headers: adminHeaders,
      data: { expected_updated_at: order.updated_at },
    }),
  );
  await json(
    await request.post(`/api/sales-orders/${order.id}/document-set`, {
      headers: adminHeaders,
      data: {
        idempotency_key: `e2e-packing-documents:${order.id}`,
        expected_updated_at: locked.sales_order.updated_at,
      },
    }),
  );
  await json(await request.post(`/api/sales-orders/${order.id}/submit`, { headers: adminHeaders }));
  await json(
    await request.post(`/api/sales-orders/${order.id}/approve`, {
      headers: approverHeaders,
      data: { reason: 'Independent E2E packing approval' },
    }),
  );
  const generated = await json<{ purchase_orders: Array<{ id: string }> }>(
    await request.post(`/api/sales-orders/${order.id}/purchase-orders/generate`, {
      headers: adminHeaders,
      data: { idempotency_key: `e2e-packing-purchase:${order.id}` },
    }),
  );
  await json(
    await request.post(`/api/purchase-orders/${generated.purchase_orders[0].id}/submit`, {
      headers: adminHeaders,
    }),
  );
  await json(
    await request.post(`/api/purchase-orders/${generated.purchase_orders[0].id}/approve`, {
      headers: approverHeaders,
      data: { reason: 'Independent E2E procurement approval' },
    }),
  );
});

test('packing-list package drives a partial shipment through delivery', async ({ page }) => {
  await loginPage(page);
  await page.goto('/fulfillment');
  await page.getByLabel('履约订单').selectOption(salesOrderId);

  await expect(page.getByLabel('装箱单箱号')).toHaveValue('PKG-1');
  await expect(page.getByLabel('净重 kg')).toHaveValue('5.0000');
  await expect(page.getByLabel('体积 CBM')).toHaveValue('0.040000');
  await page.getByLabel('发货数量').fill('1.000');
  await page.getByLabel('净重 kg').fill('2.5000');
  await page.getByLabel('体积 CBM').fill('0.020000');
  await page.getByLabel('毛重 kg').fill('3.0000');
  await page.getByLabel('发货批次').fill('E2E-PACK-SHIP-1');
  await page.getByLabel('承运方').fill('DHL');
  await page.getByLabel('物流单号').fill(`DHL-PACK-${Date.now()}`);
  await page.getByRole('button', { name: '创建发货' }).click();

  await expect(page.locator('strong', { hasText: 'E2E-PACK-SHIP-1' })).toBeVisible();
  await expect(page.getByText('箱号 PKG-1', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '确认发货' }).click();
  await expect(page.getByText('dispatched', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '记录运输中' }).click();
  await expect(page.getByText('in_transit', { exact: false })).toBeVisible();

  await page.getByLabel('签收凭证 E2E-PACK-SHIP-1').setInputFiles({
    name: 'packing-delivery.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('packing-driven-signed-delivery'),
  });
  await page.getByLabel('签收人 E2E-PACK-SHIP-1').fill('E2E Warehouse Contact');
  await page.getByLabel('签收异常 E2E-PACK-SHIP-1').fill('Outer carton checked and accepted');
  await page.getByRole('button', { name: '确认签收' }).click();

  await expect(page.getByText('聚合状态：fulfillment')).toBeVisible();
  await expect(page.getByText('签收人：E2E Warehouse Contact', { exact: false })).toBeVisible();
  await expect(page.getByText('Outer carton checked and accepted', { exact: false })).toBeVisible();
});
