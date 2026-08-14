import { APIRequestContext, APIResponse, expect, Page, test } from '@playwright/test';

const TENANT_SLUG = 'test-tenant';
const PASSWORD = 'test-password-123';
const SALES_EMAIL = 'test-sales@test.local';
const ADMIN_EMAIL = 'test-user@test.local';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PROFESSIONAL_PLAN_ID = 'b0000000-0000-0000-0000-000000000003';

let salesOrderId: string;
let orderNumber: string;
let salesParticipantId: string;
let procurementParticipantId: string;

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
      data: { require_sales_receipt_confirmation: false },
    }),
  );

  const fixtureKey = Date.now().toString(36).toUpperCase();
  const inquiry = await json<{ id: string; items: Array<{ id: string }> }>(
    await request.post('/api/inquiries', {
      headers: salesHeaders,
      data: {
        customer_code: `E2E-FIN-${fixtureKey}`,
        customer_country: 'US',
        customer_message: 'Synthetic browser finance fixture',
        items: [
          {
            description: 'E2E finance product',
            quantity: '2.000',
            unit: 'pcs',
            target_price_usd: '100.0000',
          },
        ],
      },
    }),
  );
  await json(
    await request.post(`/api/inquiries/${inquiry.id}/customer-upgrade`, {
      headers: salesHeaders,
      data: {
        company_name: `E2E Finance Customer ${fixtureKey}`,
        email: `e2e-finance-${fixtureKey.toLowerCase()}@example.test`,
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
        summary: 'Synthetic finance product requirement',
        items: [
          {
            inquiry_item_id: inquiry.items[0].id,
            description: 'E2E finance product',
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
      data: { company_name: `E2E Finance Supplier ${fixtureKey}` },
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
            unit_price: '50.0000',
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
        sales_unit_price: '100.0000',
      },
    }),
  );
  const pi = await json<{ id: string }>(
    await request.post(`/api/inquiries/${inquiry.id}/proforma-invoices`, {
      headers: salesHeaders,
      data: {
        selection_ids: [selection.id],
        payment_terms: 'Full payment before procurement',
      },
    }),
  );
  await json(
    await request.post(`/api/proforma-invoices/${pi.id}/issue`, { headers: salesHeaders }),
  );
  const confirmed = await json<{
    sales_order: { id: string };
  }>(
    await request.post(`/api/proforma-invoices/${pi.id}/customer-confirm`, {
      headers: salesHeaders,
    }),
  );
  salesOrderId = confirmed.sales_order.id;

  const receipt = await json<{ receipt: { id: string } }>(
    await request.post(`/api/sales-orders/${salesOrderId}/customer-receipts`, {
      headers: salesHeaders,
      data: {
        amount: '200.00',
        currency: 'USD',
        received_at: '2026-07-31',
        method: 'bank_transfer',
        external_reference: `E2E-FIN-PAY-${fixtureKey}`,
      },
    }),
  );
  await json(
    await request.post(`/api/customer-receipts/${receipt.receipt.id}/review`, {
      headers: adminHeaders,
      data: { decision: 'confirmed' },
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
  const approverRole = await json<{ id: string }>(
    await request.post('/api/roles', {
      headers: adminHeaders,
      data: {
        name: `E2E Finance Approver ${fixtureKey}`,
        description: 'Procurement approval for the finance browser fixture',
      },
    }),
  );
  await json(
    await request.put(`/api/roles/${approverRole.id}/permissions`, {
      headers: adminHeaders,
      data: {
        permissions: ['procurement:view', 'procurement:update', 'procurement:approve'].map(
          (code) => {
            const permissionId = permissionIds.get(code);
            if (!permissionId) throw new Error(`Permission missing from catalog: ${code}`);
            return { permissionId, dataScope: 'all' };
          },
        ),
      },
    }),
  );
  const approverEmail = `e2e-fin-approver-${fixtureKey.toLowerCase()}@test.local`;
  const approver = await json<{ id: string }>(
    await request.post('/api/users', {
      headers: adminHeaders,
      data: {
        email: approverEmail,
        name: `E2E Finance Approver ${fixtureKey}`,
        password: PASSWORD,
        roleIds: [approverRole.id],
      },
    }),
  );
  procurementParticipantId = approver.id;
  const commissionSales = await json<{ id: string }>(
    await request.post('/api/users', {
      headers: adminHeaders,
      data: {
        email: `e2e-fin-sales-${fixtureKey.toLowerCase()}@test.local`,
        name: `E2E Finance Sales ${fixtureKey}`,
        password: PASSWORD,
      },
    }),
  );
  salesParticipantId = commissionSales.id;
  const approverLogin = await loginApi(request, approverEmail);
  const approverHeaders = { Authorization: `Bearer ${approverLogin.accessToken}` };
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
  const approved = await json<{ purchase_orders: Array<{ id: string }> }>(
    await request.post(`/api/procurement-requests/${procurementRequest.id}/decisions`, {
      headers: approverHeaders,
      data: { decision: 'approved', reason: 'E2E finance approval' },
    }),
  );
  const purchaseOrder = await json<{ items: Array<{ id: string }> }>(
    await request.get(`/api/purchase-orders/${approved.purchase_orders[0].id}`, {
      headers: approverHeaders,
    }),
  );
  await json(
    await request.post(`/api/purchase-orders/${approved.purchase_orders[0].id}/place`, {
      headers: approverHeaders,
      data: { items: [{ item_id: purchaseOrder.items[0].id, final_unit_price: '50.0000' }] },
    }),
  );

  const goodsReceipt = await json<{ id: string; items: Array<{ id: string }> }>(
    await request.post(`/api/purchase-orders/${approved.purchase_orders[0].id}/goods-receipts`, {
      headers: adminHeaders,
      data: {
        batch_number: `E2E-FIN-GR-${fixtureKey}`,
        is_final_batch: true,
        items: [{ purchase_order_item_id: purchaseOrder.items[0].id, received_quantity: '2' }],
      },
    }),
  );
  await json(
    await request.post(`/api/goods-receipts/${goodsReceipt.id}/inspect`, {
      headers: adminHeaders,
      data: {
        items: [
          {
            item_id: goodsReceipt.items[0].id,
            accepted_quantity: '2',
            rejected_quantity: '0',
          },
        ],
      },
    }),
  );
  const fulfillment = await json<{ items: Array<{ id: string }> }>(
    await request.get(`/api/sales-orders/${salesOrderId}/fulfillment`, {
      headers: adminHeaders,
    }),
  );
  const shipment = await json<{ id: string }>(
    await request.post(`/api/sales-orders/${salesOrderId}/shipments`, {
      headers: adminHeaders,
      data: {
        idempotency_key: `shipment:finance:${fixtureKey}`,
        batch_number: `E2E-FIN-SHIP-${fixtureKey}`,
        carrier: 'DHL',
        tracking_number: `E2E-FIN-${fixtureKey}`,
        items: [{ sales_order_item_id: fulfillment.items[0].id, quantity: '2' }],
      },
    }),
  );
  await json(
    await request.post(`/api/sales-orders/${salesOrderId}/expenses`, {
      headers: adminHeaders,
      data: {
        shipment_id: shipment.id,
        expense_type: 'freight',
        amount: '10.00',
        currency: 'RMB',
      },
    }),
  );
  await json(
    await request.post(`/api/sales-orders/${salesOrderId}/expenses`, {
      headers: adminHeaders,
      data: { expense_type: 'insurance', amount: '2.01', currency: 'RMB' },
    }),
  );
  const proof = await json<{ id: string }>(
    await request.post('/api/files', {
      headers: adminHeaders,
      multipart: {
        purpose: 'delivery_evidence',
        file: {
          name: `e2e-finance-delivery-${fixtureKey}.pdf`,
          mimeType: 'application/pdf',
          buffer: Buffer.from('signed-delivery-evidence'),
        },
      },
    }),
  );
  await json(
    await request.post(`/api/shipments/${shipment.id}/dispatch`, { headers: adminHeaders }),
  );
  await json(
    await request.post(`/api/shipments/${shipment.id}/logistics-events`, {
      headers: adminHeaders,
      data: {
        idempotency_key: `shipment:finance:transit:${fixtureKey}`,
        event_type: 'in_transit',
        occurred_at: new Date(Date.now() + 500).toISOString(),
      },
    }),
  );
  await json(
    await request.post(`/api/shipments/${shipment.id}/deliver`, {
      headers: adminHeaders,
      data: {
        delivered_at: new Date(Date.now() + 1000).toISOString(),
        received_by: 'Finance E2E buyer',
        attachment_file_ids: [proof.id],
        note: 'E2E finance delivery completed',
      },
    }),
  );
  const financeOrders = await json<Array<{ id: string; order_number: string }>>(
    await request.get('/api/finance/orders', { headers: adminHeaders }),
  );
  const financeOrder = financeOrders.find((order) => order.id === salesOrderId);
  if (!financeOrder) throw new Error(`Delivered finance order not listed: ${salesOrderId}`);
  orderNumber = financeOrder.order_number;
});

test('finance completes lock, revision, and obsolete unlocked candidate replacement', async ({
  page,
}) => {
  await loginPage(page, ADMIN_EMAIL);
  await page.getByRole('link', { name: '财务核对' }).click();
  await expect(page).toHaveURL(/\/finance$/);
  await expect(page.getByTestId('sensitive-watermark')).toContainText(ADMIN_EMAIL);
  const orderButton = page.locator('.finance-order-button').filter({ hasText: orderNumber });
  await expect(orderButton).toHaveCount(1);
  await expect(orderButton).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('资料完整')).toBeVisible();

  const returnReason = page.getByLabel('打回原因');
  await returnReason.fill('先记录复核退回证据');
  await expect(returnReason).toHaveValue('先记录复核退回证据');
  await page.getByRole('button', { name: '打回', exact: true }).click();
  await expect(page.getByTestId('finance-review-history')).toContainText('v1');
  await expect(page.getByTestId('finance-review-history')).toContainText('returned');

  await page.getByLabel('客户收款汇率', { exact: true }).fill('7.12345678');
  await page.getByLabel('客户收款汇率来源', { exact: true }).fill('E2E bank advice');
  await page.getByLabel('客户收款汇率时间', { exact: true }).fill('2026-07-31T08:00');
  await page.getByLabel('采购成本汇率', { exact: true }).fill('7');
  await page.getByLabel('采购成本汇率来源', { exact: true }).fill('E2E bank advice');
  await page.getByLabel('采购成本汇率时间', { exact: true }).fill('2026-07-31T08:00');
  await page.getByRole('button', { name: '核对通过' }).click();
  await expect(page.getByTestId('finance-review-history')).toContainText('v2');
  await expect(page.getByTestId('finance-review-history')).toContainText('verified');

  await page.getByRole('button', { name: '生成最终利润' }).click();
  await expect(page.getByTestId('profit-metrics')).toContainText('¥1,424.69');
  await expect(page.getByTestId('profit-metrics')).toContainText('¥700.00');
  await expect(page.getByTestId('profit-metrics')).toContainText('¥712.68');

  const ruleSection = page
    .locator('.finance-section')
    .filter({ has: page.getByRole('heading', { name: '提成规则' }) });
  const salesRule = ruleSection.locator('.finance-allocation').filter({ hasText: '销售提成' });
  const procurementRule = ruleSection
    .locator('.finance-allocation')
    .filter({ hasText: '采购提成' });
  await salesRule.getByLabel('计算基数').selectOption('gross_profit');
  await salesRule.getByLabel('比例（基点）').fill('1000');
  await procurementRule.getByLabel('计算基数').selectOption('net_profit');
  await procurementRule.getByLabel('比例（基点）').fill('500');
  const saveRules = page.getByRole('button', { name: '追加规则版本' });
  await saveRules.click();
  await expect(saveRules).toBeDisabled();
  await expect(saveRules).toBeEnabled();

  await page.getByLabel('销售提成人员').selectOption(salesParticipantId);
  await page.getByLabel('采购提成人员').selectOption(procurementParticipantId);
  await page.getByRole('button', { name: '计算提成候选' }).click();
  await expect(page.getByTestId('commission-history')).toContainText('v1');
  await expect(page.getByTestId('commission-history')).toContainText('calculated');
  await page.getByLabel('锁定备注').fill('E2E 财务锁定');
  await page.getByRole('button', { name: '锁定候选' }).click();
  await expect(page.getByTestId('commission-history')).toContainText('locked');

  const reviseCandidate = page.getByRole('button', { name: '追加修订版本' });
  await expect(reviseCandidate).toBeEnabled();
  await page.getByLabel('销售提成人员').selectOption(salesParticipantId);
  await page.getByLabel('采购提成人员').selectOption(procurementParticipantId);
  await page.getByLabel('修订原因').fill('客户售后调整，追加重算');
  await reviseCandidate.click();
  await expect(page.getByTestId('commission-history')).toContainText('v2');
  await expect(page.getByTestId('commission-history')).toContainText('客户售后调整，追加重算');

  await page.getByLabel('打回原因').fill('追加财务复核，令未锁定候选过期');
  await page.getByRole('button', { name: '打回', exact: true }).click();
  await expect(page.getByTestId('finance-review-history')).toContainText('v3');
  await expect(page.getByTestId('finance-review-history')).toContainText(
    '追加财务复核，令未锁定候选过期',
  );

  await page.getByLabel('客户收款汇率', { exact: true }).fill('7.12345678');
  await page.getByLabel('客户收款汇率来源', { exact: true }).fill('E2E bank advice');
  await page.getByLabel('客户收款汇率时间', { exact: true }).fill('2026-07-31T08:00');
  await page.getByLabel('采购成本汇率', { exact: true }).fill('7');
  await page.getByLabel('采购成本汇率来源', { exact: true }).fill('E2E bank advice');
  await page.getByLabel('采购成本汇率时间', { exact: true }).fill('2026-07-31T08:00');
  await page.getByRole('button', { name: '核对通过' }).click();
  await expect(page.getByTestId('finance-review-history')).toContainText('v4');

  await page.getByRole('button', { name: '生成最终利润' }).click();
  await expect(page.getByTestId('stale-commission-candidate')).toContainText(
    '当前候选基于旧利润快照',
  );
  await expect(page.getByRole('button', { name: '锁定候选' })).toHaveCount(0);

  await page.getByLabel('销售提成人员').selectOption(salesParticipantId);
  await page.getByLabel('采购提成人员').selectOption(procurementParticipantId);
  await page.getByLabel('修订原因').fill('新利润已生成，恢复未锁定候选');
  await page.getByRole('button', { name: '恢复并追加版本' }).click();
  await expect(page.getByTestId('commission-history')).toContainText('v3');
  await expect(page.getByTestId('commission-history')).toContainText(
    '新利润已生成，恢复未锁定候选',
  );

  await page.getByLabel('锁定备注').fill('E2E 恢复链锁定');
  await page.getByRole('button', { name: '锁定候选' }).click();
  await expect(page.getByTestId('commission-history')).toContainText('locked');
});

test('sales role cannot navigate to or directly open finance', async ({ page }) => {
  await loginPage(page, SALES_EMAIL);
  await expect(page.getByRole('link', { name: '财务核对' })).toHaveCount(0);
  await page.goto('/finance');
  await expect(page).toHaveURL(/\/forbidden$/);
  await expect(page.getByRole('heading', { name: '没有访问权限' })).toBeVisible();
});
