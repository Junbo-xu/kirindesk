import { APIRequestContext, expect, Page, test } from '@playwright/test';

const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const SALES_EMAIL = 'test-sales@test.local';
const ADMIN_EMAIL = 'test-user@test.local';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PROFESSIONAL_PLAN_ID = 'b0000000-0000-0000-0000-000000000003';

let salesOrderId: string;
let purchaseOrderId: string;
let customerReceiptId: string;
let supplierName: string;

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
  await json(
    await request.put('/api/fulfillment/settings', {
      headers: adminHeaders,
      data: { require_sales_receipt_confirmation: true },
    }),
  );

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
        name: `E2E Fulfillment Approver Role ${fixtureKey}`,
        description: 'Procurement approval and placement for the real browser fulfillment flow',
      },
    }),
  );
  const approverCodes = ['procurement:view', 'procurement:update', 'procurement:approve'];
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
  const approverEmail = `e2e-ful-approver-${fixtureKey.toLowerCase()}@test.local`;
  const approver = await json<{ id: string }>(
    await request.post('/api/users', {
      headers: adminHeaders,
      data: {
        email: approverEmail,
        name: `E2E Fulfillment Approver ${fixtureKey}`,
        password: PASSWORD,
        roleIds: [approverRole.id],
      },
    }),
  );
  const approverLogin = await loginApi(request, approverEmail);
  const approverHeaders = { Authorization: `Bearer ${approverLogin.accessToken}` };
  const inquiry = await json<{ id: string; items: Array<{ id: string }> }>(
    await request.post('/api/inquiries', {
      headers: salesHeaders,
      data: {
        customer_code: `E2E-FUL-${fixtureKey}`,
        customer_country: 'US',
        customer_message: 'Synthetic browser fulfillment fixture',
        items: [
          {
            description: 'E2E fulfillment product',
            quantity: '2.000',
            unit: 'pcs',
            target_price_usd: '2.0000',
          },
        ],
      },
    }),
  );
  await json(
    await request.post(`/api/inquiries/${inquiry.id}/customer-upgrade`, {
      headers: salesHeaders,
      data: {
        company_name: `E2E Fulfillment Customer ${fixtureKey}`,
        email: `e2e-fulfillment-${fixtureKey.toLowerCase()}@example.test`,
        country: 'US',
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
        summary: 'Synthetic fulfillment requirement',
        items: [
          {
            inquiry_item_id: inquiry.items[0].id,
            description: 'E2E fulfillment product',
            specifications: null,
            quantity: '2.000',
            unit: 'pcs',
          },
        ],
      },
    }),
  );
  supplierName = `E2E Fulfillment Supplier ${fixtureKey}`;
  const supplier = await json<{ id: string }>(
    await request.post('/api/suppliers', {
      headers: adminHeaders,
      data: { company_name: supplierName },
    }),
  );
  const quotation = await json<{ lines: Array<{ id: string }> }>(
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
    await request.post(`/api/inquiries/${inquiry.id}/selections`, {
      headers: salesHeaders,
      data: {
        quotation_line_id: quotation.lines[0].id,
        expected_quotation_version: 1,
        sales_currency: 'USD',
        sales_unit_price: '2.0000',
      },
    }),
  );
  const pi = await json<{ id: string }>(
    await request.post(`/api/inquiries/${inquiry.id}/proforma-invoices`, {
      headers: salesHeaders,
      data: {
        selection_ids: [selection.id],
        payment_terms: 'Payment and delivery milestones remain independent',
      },
    }),
  );
  await json(
    await request.post(`/api/proforma-invoices/${pi.id}/issue`, { headers: salesHeaders }),
  );
  const confirmed = await json<{
    sales_order: { id: string };
    procurement_gate: { status: string };
  }>(
    await request.post(`/api/proforma-invoices/${pi.id}/customer-confirm`, {
      headers: salesHeaders,
    }),
  );
  salesOrderId = confirmed.sales_order.id;
  expect(confirmed.procurement_gate.status).toBe('open');

  const recorded = await json<{ receipt: { id: string; status: string } }>(
    await request.post(`/api/sales-orders/${salesOrderId}/customer-receipts`, {
      headers: salesHeaders,
      data: {
        amount: '1.00',
        currency: 'USD',
        received_at: '2026-07-31',
        method: 'bank_transfer',
        external_reference: `E2E-FUL-PAY-${fixtureKey}`,
      },
    }),
  );
  customerReceiptId = recorded.receipt.id;
  expect(recorded.receipt.status).toBe('recorded');

  await json(
    await request.put('/api/procurement/approval-config', {
      headers: adminHeaders,
      data: {
        price_variance_threshold_bps: 500,
        steps: [{ approver_user_id: approver.id }],
      },
    }),
  );
  const procurementRequest = await json<{ id: string }>(
    await request.post(`/api/sales-orders/${salesOrderId}/procurement-requests`, {
      headers: salesHeaders,
      data: { items: [{ selection_id: selection.id, quantity: '2' }] },
    }),
  );
  const approved = await json<{
    purchase_orders: Array<{ id: string; items: Array<{ id: string }> }>;
  }>(
    await request.post(`/api/procurement-requests/${procurementRequest.id}/decisions`, {
      headers: approverHeaders,
      data: { decision: 'approved', reason: 'E2E fulfillment approval' },
    }),
  );
  purchaseOrderId = approved.purchase_orders[0].id;
  const purchaseOrder = await json<{ items: Array<{ id: string }> }>(
    await request.get(`/api/purchase-orders/${purchaseOrderId}`, { headers: approverHeaders }),
  );
  await json(
    await request.post(`/api/purchase-orders/${purchaseOrderId}/place`, {
      headers: approverHeaders,
      data: { items: [{ item_id: purchaseOrder.items[0].id, final_unit_price: '1.0000' }] },
    }),
  );
});

test('browser completes real split fulfillment with independent payment milestone', async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPage(adminPage, ADMIN_EMAIL);
  await adminPage.getByRole('link', { name: '履约与物流' }).click();
  await expect(adminPage).toHaveURL(/\/fulfillment$/);
  await adminPage.getByLabel('履约订单').selectOption(salesOrderId);
  await expect(adminPage.getByTestId('sensitive-watermark')).toContainText(ADMIN_EMAIL);
  await adminPage.getByLabel('到货批次').fill('E2E-GR-1');
  await adminPage.getByLabel('到货数量').fill('2');
  await adminPage.getByLabel('QC 照片').setInputFiles({
    name: 'qc.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('qc-evidence'),
  });
  await adminPage.getByRole('button', { name: '记录到货' }).click();
  await expect(adminPage.getByText('E2E-GR-1', { exact: false })).toBeVisible();
  await adminPage.getByLabel('QC 接受数量 E2E-GR-1').fill('2');
  await adminPage.getByLabel('QC 拒收数量 E2E-GR-1').fill('0');
  await adminPage.getByRole('button', { name: '提交 QC' }).click();
  await expect(adminPage.getByText('inspected', { exact: false })).toBeVisible();

  const salesContext = await browser.newContext();
  const salesPage = await salesContext.newPage();
  await loginPage(salesPage, SALES_EMAIL);
  await salesPage.getByRole('link', { name: '履约与物流' }).click();
  await salesPage.getByLabel('履约订单').selectOption(salesOrderId);
  await expect(salesPage.getByTestId('sensitive-watermark')).toContainText(SALES_EMAIL);
  await salesPage.getByRole('button', { name: '业务确认' }).click();
  await expect(salesPage.getByText('accepted', { exact: false })).toBeVisible();
  await expect(salesPage.getByText('2.000', { exact: true }).first()).toBeVisible();

  const createRequests: Array<Record<string, unknown>> = [];
  const createResponses: Array<{ id: string; idempotent: boolean }> = [];
  const createShipmentPath = `**/api/sales-orders/${salesOrderId}/shipments`;
  await salesPage.route(createShipmentPath, async (route) => {
    createRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    const response = await route.fetch();
    createResponses.push((await response.json()) as { id: string; idempotent: boolean });
    if (createRequests.length === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({ response });
  });
  await salesPage.getByLabel('发货批次').fill('E2E-SHIP-1');
  await salesPage.getByLabel('发货数量').fill('2');
  await salesPage.getByLabel('箱号').fill('E2E-BOX-1');
  await salesPage.getByLabel('毛重 kg').fill('2.5000');
  await salesPage.getByLabel('净重 kg').fill('2.0000');
  await salesPage.getByLabel('体积 CBM').fill('0.020000');
  await salesPage.getByLabel('承运方').fill('DHL');
  await salesPage.getByLabel('物流单号').fill(`DHL-${Date.now()}`);
  await salesPage.getByRole('button', { name: '创建发货' }).click();
  await expect(salesPage.getByRole('alert')).toBeVisible();
  await salesPage.getByRole('button', { name: '创建发货' }).click();
  await expect(salesPage.locator('strong', { hasText: 'E2E-SHIP-1' })).toBeVisible();
  expect(createRequests).toHaveLength(2);
  expect(createRequests[1]).toEqual(createRequests[0]);
  expect(createResponses).toEqual([
    expect.objectContaining({ idempotent: false }),
    expect.objectContaining({ id: createResponses[0].id, idempotent: true }),
  ]);
  await salesPage.unroute(createShipmentPath);

  await salesPage.getByLabel('费用关联发货').selectOption({ label: 'E2E-SHIP-1' });
  await salesPage.getByLabel('费用金额').fill('12.3456');
  await salesPage.getByLabel('费用币种').selectOption('RMB');
  await salesPage.getByRole('button', { name: '冻结费用' }).click();
  await expect(salesPage.getByText('RMB 12.35', { exact: false })).toBeVisible();
  await salesPage.getByRole('button', { name: '确认发货' }).click();
  await expect(salesPage.getByText('dispatched', { exact: false })).toBeVisible();

  const transitRequests: Array<Record<string, unknown>> = [];
  const transitResponses: Array<{ id: string; idempotent: boolean }> = [];
  const transitPath = `**/api/shipments/${createResponses[0].id}/logistics-events`;
  await salesPage.route(transitPath, async (route) => {
    transitRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    const response = await route.fetch();
    transitResponses.push((await response.json()) as { id: string; idempotent: boolean });
    if (transitRequests.length === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({ response });
  });
  await salesPage.getByRole('button', { name: '记录运输中' }).click();
  await expect(salesPage.getByRole('alert')).toBeVisible();
  await salesPage.getByRole('button', { name: '记录运输中' }).click();
  await expect(salesPage.getByText('in_transit', { exact: false })).toBeVisible();
  expect(transitRequests).toHaveLength(2);
  expect(transitRequests[1]).toEqual(transitRequests[0]);
  expect(transitResponses).toEqual([
    expect.objectContaining({ idempotent: false }),
    expect.objectContaining({ id: transitResponses[0].id, idempotent: true }),
  ]);
  await salesPage.unroute(transitPath);

  await salesPage.getByLabel('关联收款流水 E2E-SHIP-1').fill(customerReceiptId);
  await salesPage.getByRole('button', { name: '关联独立收款里程碑' }).click();
  await expect(salesPage.getByText('收款里程碑：USD 1.00 · recorded')).toBeVisible();
  await salesPage.getByLabel('签收凭证 E2E-SHIP-1').setInputFiles({
    name: 'delivery.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('signed-delivery-evidence'),
  });
  await salesPage.getByLabel('签收人 E2E-SHIP-1').fill('E2E Buyer Contact');
  await salesPage.getByRole('button', { name: '确认签收' }).click();
  await expect(salesPage.getByText('聚合状态：delivered')).toBeVisible();
  await expect(salesPage.getByText(supplierName)).toHaveCount(0);

  await adminContext.close();
  await salesContext.close();
});

test('permission guard blocks direct fulfillment access', async ({ page }) => {
  await loginPage(page, 'test-noperm@test.local');
  await page.goto('/fulfillment');
  await expect(page).toHaveURL(/\/forbidden$/);
  await expect(page.getByRole('heading', { name: '没有访问权限' })).toBeVisible();
});
