import { APIRequestContext, expect, Page, test } from '@playwright/test';

const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const ADMIN_EMAIL = 'test-user@test.local';

let salesOrderId: string;
let approverEmail: string;
let viewerEmail: string;

async function json<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
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

async function loginPage(page: Page, email = ADMIN_EMAIL) {
  await page.goto('/login');
  await page.getByLabel('租户标识 (tenant slug)').fill(TENANT_SLUG);
  await page.getByLabel('邮箱').fill(email);
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
        name: `E2E Customs Approver ${fixtureKey}`,
        description: 'Independent order approver without customs access',
      },
    }),
  );
  const approvalPermissionId = permissionIds.get('orders:approve');
  if (!approvalPermissionId) throw new Error('orders:approve is missing from permission catalog');
  await json(
    await request.put(`/api/roles/${approverRole.id}/permissions`, {
      headers: adminHeaders,
      data: { permissions: [{ permissionId: approvalPermissionId, dataScope: 'all' }] },
    }),
  );
  approverEmail = `e2e-customs-approver-${fixtureKey.toLowerCase()}@test.local`;
  await json(
    await request.post('/api/users', {
      headers: adminHeaders,
      data: {
        email: approverEmail,
        name: `E2E Customs Approver ${fixtureKey}`,
        password: PASSWORD,
        roleIds: [approverRole.id],
      },
    }),
  );
  const approver = await loginApi(request, approverEmail);
  const approverHeaders = { Authorization: `Bearer ${approver.accessToken}` };

  const viewerRole = await json<{ id: string }>(
    await request.post('/api/roles', {
      headers: adminHeaders,
      data: {
        name: `E2E Customs Viewer ${fixtureKey}`,
        description: 'Customs view-only role without order or file permissions',
      },
    }),
  );
  const customsViewPermissionId = permissionIds.get('customs_declarations:view');
  if (!customsViewPermissionId) {
    throw new Error('customs_declarations:view is missing from permission catalog');
  }
  await json(
    await request.put(`/api/roles/${viewerRole.id}/permissions`, {
      headers: adminHeaders,
      data: {
        permissions: [{ permissionId: customsViewPermissionId, dataScope: 'all' }],
      },
    }),
  );
  viewerEmail = `e2e-customs-viewer-${fixtureKey.toLowerCase()}@test.local`;
  await json(
    await request.post('/api/users', {
      headers: adminHeaders,
      data: {
        email: viewerEmail,
        name: `E2E Customs Viewer ${fixtureKey}`,
        password: PASSWORD,
        roleIds: [viewerRole.id],
      },
    }),
  );

  const fields = await json<{ custom: Array<{ field_key: string }> }>(
    await request.get('/api/product-fields', { headers: adminHeaders }),
  );
  if (!fields.custom.some((field) => field.field_key === 'declaration_elements')) {
    await json(
      await request.post('/api/product-fields', {
        headers: adminHeaders,
        data: {
          field_key: 'declaration_elements',
          label: '申报要素',
          data_type: 'text',
          document_types: ['ci'],
        },
      }),
    );
  }

  const customer = await json<{ id: string }>(
    await request.post('/api/customers', {
      headers: adminHeaders,
      data: { company_name: `E2E Customs Customer ${fixtureKey}`, country: 'US' },
    }),
  );
  const product = await json<{ id: string }>(
    await request.post('/api/products', {
      headers: adminHeaders,
      data: {
        sku: `E2E-CUS-${fixtureKey}`,
        name: 'E2E customs product',
        unit: 'pcs',
        hs_code: '8504409999',
        default_currency: 'USD',
        default_unit_price: '40.0000',
        cost_unit_price: '15.0000',
        weight_kg: '1.5000',
        volume_cbm: '0.010000',
        custom_values: { declaration_elements: '品牌类型;型号;用途;额定功率' },
      },
    }),
  );
  const order = await json<{ id: string; updated_at: string }>(
    await request.post('/api/sales-orders', {
      headers: adminHeaders,
      data: {
        customer_id: customer.id,
        order_number: `SO-E2E-CUS-${fixtureKey}`,
        currency: 'USD',
        items: [
          {
            product_id: product.id,
            description: 'E2E customs product',
            product_code: `E2E-CUS-${fixtureKey}`,
            unit: 'pcs',
            quantity: '2.000',
            unit_price: '40.0000',
          },
        ],
      },
    }),
  );
  salesOrderId = order.id;
  await json(await request.post(`/api/sales-orders/${order.id}/submit`, { headers: adminHeaders }));
  const approved = await json<{ updated_at: string }>(
    await request.post(`/api/sales-orders/${order.id}/approve`, {
      headers: approverHeaders,
      data: { reason: 'Independent customs E2E approval' },
    }),
  );
  const locked = await json<{ sales_order: { updated_at: string } }>(
    await request.post(`/api/sales-orders/${order.id}/fulfillment-lock`, {
      headers: adminHeaders,
      data: { expected_updated_at: approved.updated_at },
    }),
  );
  const synced = await json<{ document: Record<string, unknown> }>(
    await request.post(`/api/sales-orders/${order.id}/document-set`, {
      headers: adminHeaders,
      data: {
        idempotency_key: `e2e-customs-documents:${order.id}`,
        expected_updated_at: locked.sales_order.updated_at,
      },
    }),
  );
  const document = synced.document as {
    document_set_id: string;
    sales_order_id: string;
    source_version: number;
    quote_number: string;
    pricing_mode: string;
    language: string;
    incoterm: string;
    pricing_currency: string;
    settlement_currency: string;
    exchange_rate: string;
    discount_type: string;
    discount_value: string;
    allocation_method: string;
    packing_mode: string;
    theme_color: string;
    visible_fields: Record<string, boolean>;
    terms: string | null;
    bank_info: string | null;
    logo_file_id: string | null;
    signature_file_id: string | null;
    lines: Array<{
      id: string;
      product_id?: string | null;
      sku: string;
      name: string;
      description: string | null;
      quantity: string;
      unit: string;
      unit_price: string;
      cost_unit_price?: string | null;
      weight_kg: string | null;
      volume_cbm: string | null;
      thumbnail_file_id: string | null;
      custom_fields: Array<{ field_key: string; value: unknown }>;
    }>;
  };
  await json(
    await request.patch(`/api/document-sets/${document.document_set_id}`, {
      headers: adminHeaders,
      data: {
        quote_number: document.quote_number,
        sales_order_id: document.sales_order_id,
        pricing_mode: document.pricing_mode,
        language: document.language,
        incoterm: document.incoterm,
        pricing_currency: document.pricing_currency,
        settlement_currency: document.settlement_currency,
        exchange_rate: document.exchange_rate,
        discount_type: document.discount_type,
        discount_value: document.discount_value,
        allocation_method: document.allocation_method,
        packing_mode: document.packing_mode,
        theme_color: document.theme_color,
        visible_fields: document.visible_fields,
        terms: document.terms ?? undefined,
        bank_info: document.bank_info ?? undefined,
        logo_file_id: document.logo_file_id ?? undefined,
        signature_file_id: document.signature_file_id ?? undefined,
        expected_version: document.source_version,
        lines: document.lines.map((line) => ({
          id: line.id,
          product_id: line.product_id ?? undefined,
          sku: line.sku,
          name: line.name,
          description: line.description ?? undefined,
          quantity: line.quantity,
          unit: line.unit,
          unit_price: line.unit_price,
          cost_unit_price: line.cost_unit_price ?? undefined,
          weight_kg: line.weight_kg ?? undefined,
          volume_cbm: line.volume_cbm ?? undefined,
          package_no: 'PKG-1',
          thumbnail_file_id: line.thumbnail_file_id ?? undefined,
          custom_values: Object.fromEntries(
            line.custom_fields.map((field) => [field.field_key, field.value]),
          ),
        })),
      },
    }),
  );
  await json(
    await request.post(`/api/document-sets/${document.document_set_id}/lock`, {
      headers: adminHeaders,
    }),
  );
  for (const type of ['ci', 'pl']) {
    await json(
      await request.post(`/api/document-sets/${document.document_set_id}/exports/${type}`, {
        headers: adminHeaders,
      }),
    );
  }
});

test('creates, archives, refreshes, and exports customs documents in the real UI', async ({
  page,
}) => {
  await loginPage(page);
  await page.goto('/customs');
  await page.getByLabel('锁定销售订单').selectOption(salesOrderId);
  await page.getByLabel('申报口岸').fill('上海海关');
  await page.getByLabel('贸易方式').fill('一般贸易');
  await page.getByLabel('包装种类').fill('纸箱');
  await page.getByLabel('毛重（kg）').fill('3.5000');
  await page.getByLabel('委托方名称').fill('麒麟桌国际贸易有限公司');
  await page.getByLabel('委托方统一社会信用代码').fill('91310000MA1K123456');
  await page.getByLabel('委托方联系人').fill('林经理');
  await page.getByLabel('委托方联系电话').fill('13800000000');
  await page.getByLabel('报关行名称').fill('上海示范报关有限公司');
  await page.getByLabel('报关行统一社会信用代码').fill('91310115MA1K654321');
  await page.getByLabel('报关行联系人').fill('陈报关员');
  await page.getByLabel('报关行联系电话').fill('13900000000');
  await page.getByLabel('授权事项').fill('代理申报\n配合海关查验\n办理放行手续');
  await page.getByRole('button', { name: '创建报关资料' }).click();
  await expect(page.getByRole('status')).toContainText('报关资料草稿已创建');
  await expect(page.getByText(/CI v\d+\/e\d+/)).toBeVisible();

  await page.getByRole('button', { name: '生成并归档两份 PDF' }).click();
  await expect(page.getByRole('status')).toContainText('归档版本 v1 已生成', {
    timeout: 15_000,
  });
  await expect(page.getByText('v1', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载预录单' })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载委托书' })).toBeVisible();

  await page.getByRole('button', { name: '记录导出' }).click();
  await expect(page.getByRole('status')).toContainText('版本 v1 导出已记录');
  await page.getByLabel('申报口岸').fill('宁波海关');
  await page.getByRole('button', { name: '刷新报关资料' }).click();
  await expect(page.getByRole('status')).toContainText('保留 1 个历史版本');
  await expect(page.getByText('v1', { exact: true })).toBeVisible();
});

test('hides customs navigation and route from an approver without customs permission', async ({
  page,
}) => {
  await loginPage(page, approverEmail);
  await expect(page.getByRole('link', { name: '报关资料' })).toHaveCount(0);
  await page.goto('/customs');
  await expect(page).toHaveURL(/\/forbidden$/);
});

test('loads a view-only customs workspace without order or file permissions', async ({ page }) => {
  const orderRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/sales-orders?')) orderRequests.push(request.url());
  });
  await loginPage(page, viewerEmail);
  await page.goto('/customs');
  await expect(page.getByRole('link', { name: '报关资料' })).toBeVisible();
  await page.getByLabel('锁定销售订单').selectOption(salesOrderId);
  await expect(page.getByLabel('锁定销售订单')).toHaveValue(salesOrderId);
  await expect(page.getByLabel('申报口岸')).toBeDisabled();
  await expect(page.getByRole('button', { name: '刷新报关资料' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '生成并归档两份 PDF' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '记录导出' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下载预录单' })).toHaveCount(0);
  await expect(page.getByText('无导出权限')).toBeVisible();
  expect(orderRequests).toEqual([]);
});
