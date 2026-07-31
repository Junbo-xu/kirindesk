import {
  ApiError,
  AuditChainVerifyResult,
  AuditLogDetail,
  AuditLogSummary,
  BaseCurrencyResponse,
  CommissionOrdersResponse,
  CommissionPayout,
  CommissionPayoutDetail,
  CommissionQuery,
  CommissionSettlement,
  CommissionSettlementDetail,
  CommissionSummaryResponse,
  CommissionTable,
  CommissionTableDetail,
  CreateCommissionTableInput,
  CreateCustomerInput,
  CreatePayoutInput,
  CreateSalesOrderInput,
  CreateSettlementInput,
  CreateSupplierInput,
  CreatePurchaseOrderInput,
  Currency,
  CustomerResponse,
  FileResponse,
  FileDownloadToken,
  ListAuditLogsQuery,
  ListPayoutsQuery,
  ListInvocationsQuery,
  ListInvoicesQuery,
  InvoiceSummary,
  LoginResponse,
  MeResponse,
  NotificationSettings,
  OcrExtractRequestBody,
  OcrExtractResponse,
  AiCompleteRequestBody,
  AiCompleteResponse,
  InvocationSummary,
  InvocationListResult,
  Paginated,
  PayPayoutInput,
  ReplaceCommissionRulesInput,
  ReportSummaryQuery,
  ReportSummaryResponse,
  SalesOrderResponse,
  SupplierResponse,
  PurchaseOrderResponse,
  UpdateCommissionTableInput,
  UpdateCustomerInput,
  UpdateSalesOrderInput,
  UpdateSupplierInput,
  UpdatePurchaseOrderInput,
  UserSummary,
  UserDetail,
  CreateUserInput,
  UpdateUserInput,
  ListUsersQuery,
  SubscriptionDetail,
  RoleSummary,
  RoleDetail,
  CreateRoleInput,
  UpdateRoleInput,
  PermissionGrantInput,
  CatalogModule,
  SupportGrant,
  CreateSupportGrantInput,
  ListSupportGrantsQuery,
  SignupInput,
  SignupResult,
  BusinessEvent,
  BusinessException,
  BusinessExceptionStatus,
  BusinessExceptionType,
  CommercialSelection,
  CommercialSettings,
  CompleteExpenseFxInput,
  CreateGoodsReceiptInput,
  CreateShipmentInput,
  CustomerReceipt,
  ExceptionAssignee,
  FulfillmentOrder,
  FulfillmentSettings,
  GoodsReceipt,
  InquirySummary,
  OrderExpense,
  ProcurementGate,
  ProformaInvoice,
  QuoteTaskSummary,
  SalesQuotation,
  Shipment,
  WorkbenchResponse,
} from './types';

const TOKEN_KEY = 'kd_access_token';

// 401 handler registered by AuthProvider; lets the client trigger logout +
// redirect without importing React context (avoids a circular dependency).
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  // Login must not send a stale Authorization header or trigger the 401 hook.
  auth?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  const headers: Record<string, string> = {};
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  // For FormData, let the browser set Content-Type (with the multipart
  // boundary). Only set application/json for plain object bodies.
  if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
  });

  if (res.status === 401 && auth) {
    clearToken();
    if (onUnauthorized) onUnauthorized();
    throw new ApiError(401, '登录已过期，请重新登录');
  }

  if (!res.ok) {
    throw await toApiError(res);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// NestJS error bodies look like { statusCode, message, error }, where message
// is a string or a string[] (field validation). Normalize both shapes.
async function toApiError(res: Response): Promise<ApiError> {
  let message = `请求失败 (${res.status})`;
  let fields: string[] | undefined;
  let code: string | undefined;
  let details: Record<string, unknown> | undefined;
  try {
    const data = await res.json();
    if (data && typeof data === 'object') {
      details = data as Record<string, unknown>;
      if (typeof data.code === 'string') code = data.code;
    }
    if (Array.isArray(data?.message)) {
      fields = data.message as string[];
      message = fields.join('；');
    } else if (typeof data?.message === 'string') {
      message = data.message;
    }
  } catch {
    // non-JSON body; keep the default message
  }
  return new ApiError(res.status, message, fields, code, details);
}

// Pulls the filename from a Content-Disposition header: prefer the RFC 5987
// filename* (UTF-8, percent-decoded), fall back to a plain filename=.
function parseContentDispositionFilename(cd: string | null): string | null {
  if (!cd) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // malformed encoding; fall through to the plain filename
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : null;
}

// Low-level binary download (plan §6.2/§6.3): same base URL + Authorization
// header + ApiError mapping as request<T>(), but returns the raw blob plus the
// server-provided filename instead of parsing JSON. Used for CSV exports.
async function downloadBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, { method: 'GET', headers });

  if (res.status === 401) {
    clearToken();
    if (onUnauthorized) onUnauthorized();
    throw new ApiError(401, '登录已过期，请重新登录');
  }
  if (!res.ok) {
    throw await toApiError(res);
  }

  const blob = await res.blob();
  const filename =
    parseContentDispositionFilename(res.headers.get('content-disposition')) ?? 'export.csv';
  return { blob, filename };
}

export const apiClient = {
  login(email: string, password: string, tenantSlug: string): Promise<LoginResponse> {
    return request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password, tenantSlug },
      auth: false,
    });
  },
  // Phase 2B: anonymous self-service registration. Public endpoint — no token.
  signup(input: SignupInput): Promise<SignupResult> {
    return request<SignupResult>('/api/auth/signup', {
      method: 'POST',
      body: input,
      auth: false,
    });
  },
  getMe(): Promise<MeResponse> {
    return request<MeResponse>('/api/auth/me');
  },
  getWorkbench(): Promise<WorkbenchResponse> {
    return request<WorkbenchResponse>('/api/workbench');
  },
  listBusinessEvents(
    query: {
      chainType?: string;
      chainId?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<Paginated<BusinessEvent>> {
    const params = new URLSearchParams();
    if (query.chainType) params.set('chainType', query.chainType);
    if (query.chainId) params.set('chainId', query.chainId);
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    const qs = params.toString();
    return request<Paginated<BusinessEvent>>(`/api/business-events${qs ? `?${qs}` : ''}`);
  },
  listBusinessExceptions(
    query: {
      type?: BusinessExceptionType;
      status?: BusinessExceptionStatus;
      assigneeUserId?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<Paginated<BusinessException>> {
    const params = new URLSearchParams();
    if (query.type) params.set('type', query.type);
    if (query.status) params.set('status', query.status);
    if (query.assigneeUserId) params.set('assigneeUserId', query.assigneeUserId);
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    const qs = params.toString();
    return request<Paginated<BusinessException>>(`/api/business-exceptions${qs ? `?${qs}` : ''}`);
  },
  listExceptionAssignees(): Promise<ExceptionAssignee[]> {
    return request<ExceptionAssignee[]>('/api/business-exceptions/assignees');
  },
  assignBusinessException(
    id: string,
    assigneeUserId: string,
    expectedVersion: number,
  ): Promise<BusinessException> {
    return request<BusinessException>(`/api/business-exceptions/${id}/assign`, {
      method: 'POST',
      body: { assigneeUserId, expectedVersion },
    });
  },
  startBusinessException(id: string, expectedVersion: number): Promise<BusinessException> {
    return request<BusinessException>(`/api/business-exceptions/${id}/start`, {
      method: 'POST',
      body: { expectedVersion },
    });
  },
  resolveBusinessException(
    id: string,
    resolution: string,
    expectedVersion: number,
  ): Promise<BusinessException> {
    return request<BusinessException>(`/api/business-exceptions/${id}/resolve`, {
      method: 'POST',
      body: { resolution, expectedVersion },
    });
  },
  closeBusinessException(id: string, expectedVersion: number): Promise<BusinessException> {
    return request<BusinessException>(`/api/business-exceptions/${id}/close`, {
      method: 'POST',
      body: { expectedVersion },
    });
  },
  listInquiries(): Promise<InquirySummary[]> {
    return request<InquirySummary[]>('/api/inquiries');
  },
  getInquiry(id: string): Promise<InquirySummary> {
    return request<InquirySummary>(`/api/inquiries/${id}`);
  },
  listSalesQuotations(id: string): Promise<SalesQuotation[]> {
    return request<SalesQuotation[]>(`/api/inquiries/${id}/quotations`);
  },
  listSelections(id: string): Promise<CommercialSelection[]> {
    return request<CommercialSelection[]>(`/api/inquiries/${id}/selections`);
  },
  selectQuotation(
    inquiryId: string,
    input: {
      quotation_line_id: string;
      expected_quotation_version: number;
      sales_currency: Currency;
      sales_unit_price: string;
      purchase_to_sales_fx_rate?: string;
    },
  ): Promise<CommercialSelection> {
    return request<CommercialSelection>(`/api/inquiries/${inquiryId}/selections`, {
      method: 'POST',
      body: input,
    });
  },
  upgradeInquiryCustomer(
    inquiryId: string,
    input: {
      company_name: string;
      contact_name?: string;
      email?: string;
      phone?: string;
      country?: string;
    },
  ): Promise<CustomerResponse> {
    return request<CustomerResponse>(`/api/inquiries/${inquiryId}/customer-upgrade`, {
      method: 'POST',
      body: input,
    });
  },
  linkInquiryCustomer(inquiryId: string, customerId: string): Promise<CustomerResponse> {
    return request<CustomerResponse>(`/api/inquiries/${inquiryId}/customer-link`, {
      method: 'PUT',
      body: { customer_id: customerId },
    });
  },
  approveSelectionMargin(selectionId: string, reason: string): Promise<unknown> {
    return request(`/api/quote-selections/${selectionId}/margin-approval`, {
      method: 'POST',
      body: { reason },
    });
  },
  listProformaInvoices(inquiryId: string): Promise<ProformaInvoice[]> {
    return request<ProformaInvoice[]>(`/api/inquiries/${inquiryId}/proforma-invoices`);
  },
  createProformaInvoice(
    inquiryId: string,
    selectionIds: string[],
    paymentTerms: string,
  ): Promise<ProformaInvoice> {
    return request<ProformaInvoice>(`/api/inquiries/${inquiryId}/proforma-invoices`, {
      method: 'POST',
      body: { selection_ids: selectionIds, payment_terms: paymentTerms },
    });
  },
  reviseProformaInvoice(id: string, paymentTerms: string): Promise<ProformaInvoice> {
    return request<ProformaInvoice>(`/api/proforma-invoices/${id}/revisions`, {
      method: 'POST',
      body: { payment_terms: paymentTerms },
    });
  },
  issueProformaInvoice(id: string): Promise<ProformaInvoice> {
    return request<ProformaInvoice>(`/api/proforma-invoices/${id}/issue`, { method: 'POST' });
  },
  confirmProformaInvoice(id: string): Promise<{
    proforma_invoice: ProformaInvoice;
    sales_order: SalesOrderResponse;
    procurement_gate: ProcurementGate;
  }> {
    return request(`/api/proforma-invoices/${id}/customer-confirm`, { method: 'POST' });
  },
  exportProformaInvoice(id: string): Promise<{ blob: Blob; filename: string }> {
    return downloadBlob(`/api/proforma-invoices/${id}/export`);
  },
  listCustomerReceipts(orderId: string): Promise<CustomerReceipt[]> {
    return request<CustomerReceipt[]>(`/api/sales-orders/${orderId}/customer-receipts`);
  },
  recordCustomerReceipt(
    orderId: string,
    input: {
      amount: string;
      currency: Currency;
      received_at: string;
      method: CustomerReceipt['method'];
      external_reference: string;
      proof_file_id?: string;
      note?: string;
    },
  ): Promise<{ receipt: CustomerReceipt; procurement_gate: ProcurementGate }> {
    return request(`/api/sales-orders/${orderId}/customer-receipts`, {
      method: 'POST',
      body: input,
    });
  },
  reviewCustomerReceipt(
    id: string,
    decision: 'confirmed' | 'rejected',
    reason?: string,
  ): Promise<{ receipt: CustomerReceipt; procurement_gate: ProcurementGate }> {
    return request(`/api/customer-receipts/${id}/review`, {
      method: 'POST',
      body: { decision, reason },
    });
  },
  getProcurementGate(orderId: string): Promise<ProcurementGate> {
    return request<ProcurementGate>(`/api/sales-orders/${orderId}/procurement-gate`);
  },
  getCommercialSettings(): Promise<CommercialSettings> {
    return request<CommercialSettings>('/api/commercial-settings');
  },
  updateCommercialSettings(input: CommercialSettings): Promise<CommercialSettings> {
    return request<CommercialSettings>('/api/commercial-settings', {
      method: 'PUT',
      body: input,
    });
  },
  getFulfillmentSettings(): Promise<FulfillmentSettings> {
    return request<FulfillmentSettings>('/api/fulfillment/settings');
  },
  updateFulfillmentSettings(input: FulfillmentSettings): Promise<FulfillmentSettings> {
    return request<FulfillmentSettings>('/api/fulfillment/settings', {
      method: 'PUT',
      body: input,
    });
  },
  getFulfillmentOrder(orderId: string): Promise<FulfillmentOrder> {
    return request<FulfillmentOrder>(`/api/sales-orders/${orderId}/fulfillment`);
  },
  createGoodsReceipt(
    purchaseOrderId: string,
    input: CreateGoodsReceiptInput,
  ): Promise<GoodsReceipt> {
    return request<GoodsReceipt>(`/api/purchase-orders/${purchaseOrderId}/goods-receipts`, {
      method: 'POST',
      body: input,
    });
  },
  inspectGoodsReceipt(
    receiptId: string,
    items: Array<{ item_id: string; accepted_quantity: string; rejected_quantity: string }>,
  ): Promise<GoodsReceipt> {
    return request<GoodsReceipt>(`/api/goods-receipts/${receiptId}/inspect`, {
      method: 'POST',
      body: { items },
    });
  },
  confirmGoodsReceipt(
    receiptId: string,
    decision: 'accepted' | 'rejected',
    reason?: string,
  ): Promise<GoodsReceipt> {
    return request<GoodsReceipt>(`/api/goods-receipts/${receiptId}/confirm`, {
      method: 'POST',
      body: { decision, reason },
    });
  },
  createShipment(orderId: string, input: CreateShipmentInput): Promise<Shipment> {
    return request<Shipment>(`/api/sales-orders/${orderId}/shipments`, {
      method: 'POST',
      body: input,
    });
  },
  dispatchShipment(shipmentId: string): Promise<Shipment> {
    return request<Shipment>(`/api/shipments/${shipmentId}/dispatch`, { method: 'POST' });
  },
  addLogisticsEvent(
    shipmentId: string,
    input: {
      event_type: 'in_transit' | 'customs' | 'exception';
      location?: string;
      description?: string;
      occurred_at: string;
    },
  ): Promise<Shipment['logistics_events'][number]> {
    return request(`/api/shipments/${shipmentId}/logistics-events`, {
      method: 'POST',
      body: input,
    });
  },
  deliverShipment(
    shipmentId: string,
    input: { delivered_at: string; proof_file_id: string; note?: string },
  ): Promise<Shipment> {
    return request<Shipment>(`/api/shipments/${shipmentId}/deliver`, {
      method: 'POST',
      body: input,
    });
  },
  recordOrderExpense(
    orderId: string,
    input: {
      shipment_id?: string;
      expense_type: OrderExpense['expense_type'];
      amount: string;
      currency: Currency;
      fx_rate_to_rmb?: string;
      fx_source?: string;
      fx_captured_at?: string;
      note?: string;
    },
  ): Promise<OrderExpense> {
    return request<OrderExpense>(`/api/sales-orders/${orderId}/expenses`, {
      method: 'POST',
      body: input,
    });
  },
  completeExpenseFx(expenseId: string, input: CompleteExpenseFxInput): Promise<OrderExpense> {
    return request<OrderExpense>(`/api/order-expenses/${expenseId}/complete-fx`, {
      method: 'POST',
      body: input,
    });
  },
  linkShipmentReceipt(shipmentId: string, customerReceiptId: string): Promise<unknown> {
    return request(`/api/shipments/${shipmentId}/customer-receipts`, {
      method: 'POST',
      body: { customer_receipt_id: customerReceiptId },
    });
  },
  submitInquiry(id: string): Promise<{ inquiry: InquirySummary }> {
    return request<{ inquiry: InquirySummary }>(`/api/inquiries/${id}/submit`, { method: 'POST' });
  },
  listQuoteTasks(): Promise<QuoteTaskSummary[]> {
    return request<QuoteTaskSummary[]>('/api/quote-tasks');
  },
  logout(): Promise<{ message: string }> {
    return request<{ message: string }>('/api/auth/logout', { method: 'POST' });
  },
  listSalesOrders(query: {
    page?: number;
    pageSize?: number;
    q?: string;
    status?: string;
    customer_id?: string;
  }): Promise<Paginated<SalesOrderResponse>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    if (query.customer_id) params.set('customer_id', query.customer_id);
    const qs = params.toString();
    return request<Paginated<SalesOrderResponse>>(`/api/sales-orders${qs ? `?${qs}` : ''}`);
  },
  getSalesOrder(id: string): Promise<SalesOrderResponse> {
    return request<SalesOrderResponse>(`/api/sales-orders/${id}`);
  },
  createSalesOrder(input: CreateSalesOrderInput): Promise<SalesOrderResponse> {
    return request<SalesOrderResponse>('/api/sales-orders', {
      method: 'POST',
      body: input,
    });
  },
  updateSalesOrder(id: string, input: UpdateSalesOrderInput): Promise<SalesOrderResponse> {
    return request<SalesOrderResponse>(`/api/sales-orders/${id}`, {
      method: 'PATCH',
      body: input,
    });
  },
  deleteSalesOrder(id: string): Promise<{ id: string; deleted: true }> {
    return request<{ id: string; deleted: true }>(`/api/sales-orders/${id}`, {
      method: 'DELETE',
    });
  },
  // Phase 1F-C approval transitions. Each POSTs to /:id/{action} and returns the
  // updated order; reject requires a reason, submit/approve/withdraw take none
  // (approve/withdraw accept an optional reason for the audit trail).
  submitSalesOrder(id: string): Promise<SalesOrderResponse> {
    return request<SalesOrderResponse>(`/api/sales-orders/${id}/submit`, { method: 'POST' });
  },
  approveSalesOrder(id: string, reason?: string): Promise<SalesOrderResponse> {
    return request<SalesOrderResponse>(`/api/sales-orders/${id}/approve`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
  },
  rejectSalesOrder(id: string, reason: string): Promise<SalesOrderResponse> {
    return request<SalesOrderResponse>(`/api/sales-orders/${id}/reject`, {
      method: 'POST',
      body: { reason },
    });
  },
  withdrawSalesOrder(id: string, reason?: string): Promise<SalesOrderResponse> {
    return request<SalesOrderResponse>(`/api/sales-orders/${id}/withdraw`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
  },
  listCustomers(query: {
    page?: number;
    pageSize?: number;
    q?: string;
    status?: string;
  }): Promise<Paginated<CustomerResponse>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    return request<Paginated<CustomerResponse>>(`/api/customers${qs ? `?${qs}` : ''}`);
  },
  getCustomer(id: string): Promise<CustomerResponse> {
    return request<CustomerResponse>(`/api/customers/${id}`);
  },
  createCustomer(input: CreateCustomerInput): Promise<CustomerResponse> {
    return request<CustomerResponse>('/api/customers', {
      method: 'POST',
      body: input,
    });
  },
  updateCustomer(id: string, input: UpdateCustomerInput): Promise<CustomerResponse> {
    return request<CustomerResponse>(`/api/customers/${id}`, {
      method: 'PATCH',
      body: input,
    });
  },
  deleteCustomer(id: string): Promise<{ id: string; deleted: true }> {
    return request<{ id: string; deleted: true }>(`/api/customers/${id}`, {
      method: 'DELETE',
    });
  },
  listSuppliers(query: {
    page?: number;
    pageSize?: number;
    q?: string;
    status?: string;
  }): Promise<Paginated<SupplierResponse>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    return request<Paginated<SupplierResponse>>(`/api/suppliers${qs ? `?${qs}` : ''}`);
  },
  getSupplier(id: string): Promise<SupplierResponse> {
    return request<SupplierResponse>(`/api/suppliers/${id}`);
  },
  createSupplier(input: CreateSupplierInput): Promise<SupplierResponse> {
    return request<SupplierResponse>('/api/suppliers', {
      method: 'POST',
      body: input,
    });
  },
  updateSupplier(id: string, input: UpdateSupplierInput): Promise<SupplierResponse> {
    return request<SupplierResponse>(`/api/suppliers/${id}`, {
      method: 'PATCH',
      body: input,
    });
  },
  deleteSupplier(id: string): Promise<{ id: string; deleted: true }> {
    return request<{ id: string; deleted: true }>(`/api/suppliers/${id}`, {
      method: 'DELETE',
    });
  },
  listPurchaseOrders(query: {
    page?: number;
    pageSize?: number;
    q?: string;
    status?: string;
    supplier_id?: string;
  }): Promise<Paginated<PurchaseOrderResponse>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    if (query.supplier_id) params.set('supplier_id', query.supplier_id);
    const qs = params.toString();
    return request<Paginated<PurchaseOrderResponse>>(`/api/purchase-orders${qs ? `?${qs}` : ''}`);
  },
  getPurchaseOrder(id: string): Promise<PurchaseOrderResponse> {
    return request<PurchaseOrderResponse>(`/api/purchase-orders/${id}`);
  },
  createPurchaseOrder(input: CreatePurchaseOrderInput): Promise<PurchaseOrderResponse> {
    return request<PurchaseOrderResponse>('/api/purchase-orders', {
      method: 'POST',
      body: input,
    });
  },
  updatePurchaseOrder(id: string, input: UpdatePurchaseOrderInput): Promise<PurchaseOrderResponse> {
    return request<PurchaseOrderResponse>(`/api/purchase-orders/${id}`, {
      method: 'PATCH',
      body: input,
    });
  },
  deletePurchaseOrder(id: string): Promise<{ id: string; deleted: true }> {
    return request<{ id: string; deleted: true }>(`/api/purchase-orders/${id}`, {
      method: 'DELETE',
    });
  },
  // Phase 1F-C approval transitions (symmetric with sales orders).
  submitPurchaseOrder(id: string): Promise<PurchaseOrderResponse> {
    return request<PurchaseOrderResponse>(`/api/purchase-orders/${id}/submit`, { method: 'POST' });
  },
  approvePurchaseOrder(id: string, reason?: string): Promise<PurchaseOrderResponse> {
    return request<PurchaseOrderResponse>(`/api/purchase-orders/${id}/approve`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
  },
  rejectPurchaseOrder(id: string, reason: string): Promise<PurchaseOrderResponse> {
    return request<PurchaseOrderResponse>(`/api/purchase-orders/${id}/reject`, {
      method: 'POST',
      body: { reason },
    });
  },
  withdrawPurchaseOrder(id: string, reason?: string): Promise<PurchaseOrderResponse> {
    return request<PurchaseOrderResponse>(`/api/purchase-orders/${id}/withdraw`, {
      method: 'POST',
      body: reason ? { reason } : {},
    });
  },
  listFiles(query: {
    page?: number;
    pageSize?: number;
    q?: string;
    purpose?: string;
  }): Promise<Paginated<FileResponse>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.q) params.set('q', query.q);
    if (query.purpose) params.set('purpose', query.purpose);
    const qs = params.toString();
    return request<Paginated<FileResponse>>(`/api/files${qs ? `?${qs}` : ''}`);
  },
  uploadFile(file: File, purpose?: string): Promise<FileResponse> {
    const form = new FormData();
    form.append('file', file);
    if (purpose) form.append('purpose', purpose);
    return request<FileResponse>('/api/files', { method: 'POST', body: form });
  },
  createFileToken(id: string): Promise<FileDownloadToken> {
    return request<FileDownloadToken>(`/api/files/${id}/token`, { method: 'POST' });
  },
  deleteFile(id: string): Promise<{ id: string; deleted: true }> {
    return request<{ id: string; deleted: true }>(`/api/files/${id}`, {
      method: 'DELETE',
    });
  },
  // Mints a one-time token then returns the public download URL to navigate to.
  async getFileDownloadUrl(id: string): Promise<string> {
    const { token } = await apiClient.createFileToken(id);
    return `/api/files/download?token=${encodeURIComponent(token)}`;
  },
  getBaseCurrency(): Promise<BaseCurrencyResponse> {
    return request<BaseCurrencyResponse>('/api/tenant-settings/base-currency');
  },
  setBaseCurrency(base_currency: Currency): Promise<BaseCurrencyResponse> {
    return request<BaseCurrencyResponse>('/api/tenant-settings/base-currency', {
      method: 'PUT',
      body: { base_currency },
    });
  },
  // Phase 1F-D reports: read-only aggregates. Amounts come back as decimal
  // strings in the tenant base currency.
  salesSummary(query: ReportSummaryQuery): Promise<ReportSummaryResponse> {
    return request<ReportSummaryResponse>(`/api/reports/sales-summary${reportQs(query)}`);
  },
  purchaseSummary(query: ReportSummaryQuery): Promise<ReportSummaryResponse> {
    return request<ReportSummaryResponse>(`/api/reports/purchase-summary${reportQs(query)}`);
  },

  // Phase 1F-E commission. Reads are derived in the tenant base currency; rate
  // tables + settlements are managed/locked server-side.
  commissionSummary(query: CommissionQuery): Promise<CommissionSummaryResponse> {
    return request<CommissionSummaryResponse>(`/api/commission/summary${commissionQs(query)}`);
  },
  commissionOrders(query: CommissionQuery): Promise<CommissionOrdersResponse> {
    return request<CommissionOrdersResponse>(`/api/commission/orders${commissionQs(query)}`);
  },
  commissionTables(): Promise<CommissionTable[]> {
    return request<CommissionTable[]>('/api/commission/tables');
  },
  commissionTable(id: string): Promise<CommissionTableDetail> {
    return request<CommissionTableDetail>(`/api/commission/tables/${id}`);
  },
  createCommissionTable(input: CreateCommissionTableInput): Promise<CommissionTableDetail> {
    return request<CommissionTableDetail>('/api/commission/tables', {
      method: 'POST',
      body: input,
    });
  },
  updateCommissionTable(
    id: string,
    input: UpdateCommissionTableInput,
  ): Promise<CommissionTableDetail> {
    return request<CommissionTableDetail>(`/api/commission/tables/${id}`, {
      method: 'PATCH',
      body: input,
    });
  },
  replaceCommissionRules(
    id: string,
    input: ReplaceCommissionRulesInput,
  ): Promise<CommissionTableDetail> {
    return request<CommissionTableDetail>(`/api/commission/tables/${id}/rules`, {
      method: 'PUT',
      body: input,
    });
  },
  commissionSettlements(): Promise<CommissionSettlement[]> {
    return request<CommissionSettlement[]>('/api/commission/settlements');
  },
  commissionSettlement(id: string): Promise<CommissionSettlementDetail> {
    return request<CommissionSettlementDetail>(`/api/commission/settlements/${id}`);
  },
  createCommissionSettlement(input: CreateSettlementInput): Promise<CommissionSettlementDetail> {
    return request<CommissionSettlementDetail>('/api/commission/settlements', {
      method: 'POST',
      body: input,
    });
  },
  unlockCommissionSettlement(id: string, reason: string): Promise<CommissionSettlementDetail> {
    return request<CommissionSettlementDetail>(`/api/commission/settlements/${id}/unlock`, {
      method: 'POST',
      body: { reason },
    });
  },
  // Phase 1F-F payouts. Amounts are server-copied from a locked settlement and
  // returned as base-currency decimal strings (plan §6.7).
  commissionPayouts(query: ListPayoutsQuery = {}): Promise<CommissionPayout[]> {
    return request<CommissionPayout[]>(`/api/commission/payouts${payoutQs(query)}`);
  },
  commissionPayout(id: string): Promise<CommissionPayoutDetail> {
    return request<CommissionPayoutDetail>(`/api/commission/payouts/${id}`);
  },
  createCommissionPayout(input: CreatePayoutInput): Promise<CommissionPayoutDetail> {
    return request<CommissionPayoutDetail>('/api/commission/payouts', {
      method: 'POST',
      body: input,
    });
  },
  payCommissionPayoutLine(id: string, lineId: string): Promise<CommissionPayoutDetail> {
    return request<CommissionPayoutDetail>(`/api/commission/payouts/${id}/lines/${lineId}/pay`, {
      method: 'POST',
    });
  },
  payCommissionPayout(id: string, input: PayPayoutInput): Promise<CommissionPayoutDetail> {
    return request<CommissionPayoutDetail>(`/api/commission/payouts/${id}/pay`, {
      method: 'POST',
      body: input,
    });
  },
  voidCommissionPayout(id: string, reason: string): Promise<CommissionPayoutDetail> {
    return request<CommissionPayoutDetail>(`/api/commission/payouts/${id}/void`, {
      method: 'POST',
      body: { reason },
    });
  },

  // Phase 1G AI/OCR. Mock-only providers (no real vendor). ocrExtract/aiComplete
  // return the live result; list/get return summaries only (full text/output is
  // never persisted). No update/delete — invocation records are append-only.
  ocrExtract(body: OcrExtractRequestBody): Promise<OcrExtractResponse> {
    return request<OcrExtractResponse>('/api/ai/ocr', { method: 'POST', body });
  },
  listOcr(query: ListInvocationsQuery = {}): Promise<InvocationListResult> {
    return request<InvocationListResult>(`/api/ai/ocr${invocationQs(query)}`);
  },
  getOcr(id: string): Promise<InvocationSummary> {
    return request<InvocationSummary>(`/api/ai/ocr/${id}`);
  },
  aiComplete(body: AiCompleteRequestBody): Promise<AiCompleteResponse> {
    return request<AiCompleteResponse>('/api/ai/complete', { method: 'POST', body });
  },
  listAiCompletions(query: ListInvocationsQuery = {}): Promise<InvocationListResult> {
    return request<InvocationListResult>(`/api/ai/complete${invocationQs(query)}`);
  },
  getAiCompletion(id: string): Promise<InvocationSummary> {
    return request<InvocationSummary>(`/api/ai/complete/${id}`);
  },

  // Phase 1H tenant user management. Reads are tenant-isolated + dataScope
  // narrowed; the server enforces last-owner / self-lock / no-escalation guards.
  listUsers(query: ListUsersQuery = {}): Promise<Paginated<UserSummary>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.q) params.set('q', query.q);
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    return request<Paginated<UserSummary>>(`/api/users${qs ? `?${qs}` : ''}`);
  },
  getUser(id: string): Promise<UserDetail> {
    return request<UserDetail>(`/api/users/${id}`);
  },
  createUser(input: CreateUserInput): Promise<UserDetail> {
    return request<UserDetail>('/api/users', { method: 'POST', body: input });
  },
  updateUser(id: string, input: UpdateUserInput): Promise<UserDetail> {
    return request<UserDetail>(`/api/users/${id}`, { method: 'PATCH', body: input });
  },
  setUserRoles(id: string, roleIds: string[]): Promise<UserDetail> {
    return request<UserDetail>(`/api/users/${id}/roles`, { method: 'PUT', body: { roleIds } });
  },
  deactivateUser(id: string): Promise<{ id: string; deleted: true }> {
    return request<{ id: string; deleted: true }>(`/api/users/${id}`, { method: 'DELETE' });
  },

  // Phase 1H tenant role management + permission catalog. System roles are
  // read-only server-side; grants are subset-checked against the caller's own.
  listRoles(): Promise<RoleSummary[]> {
    return request<RoleSummary[]>('/api/roles');
  },
  getRole(id: string): Promise<RoleDetail> {
    return request<RoleDetail>(`/api/roles/${id}`);
  },
  createRole(input: CreateRoleInput): Promise<RoleDetail> {
    return request<RoleDetail>('/api/roles', { method: 'POST', body: input });
  },
  updateRole(id: string, input: UpdateRoleInput): Promise<RoleDetail> {
    return request<RoleDetail>(`/api/roles/${id}`, { method: 'PATCH', body: input });
  },
  deleteRole(id: string): Promise<{ id: string; deleted: true }> {
    return request<{ id: string; deleted: true }>(`/api/roles/${id}`, { method: 'DELETE' });
  },
  setRolePermissions(id: string, permissions: PermissionGrantInput[]): Promise<RoleDetail> {
    return request<RoleDetail>(`/api/roles/${id}/permissions`, {
      method: 'PUT',
      body: { permissions },
    });
  },
  listPermissionCatalog(): Promise<CatalogModule[]> {
    return request<CatalogModule[]>('/api/permissions');
  },

  // Phase 1I audit log viewer. Read-only; tenant-isolated by RLS + dataScope.
  // verifyAuditChain takes no chain_key — the server derives it from the
  // authenticated tenant (never client-supplied).
  listAuditLogs(query: ListAuditLogsQuery = {}): Promise<Paginated<AuditLogSummary>> {
    return request<Paginated<AuditLogSummary>>(`/api/audit-logs${auditQs(query)}`);
  },
  getAuditLog(id: string): Promise<AuditLogDetail> {
    return request<AuditLogDetail>(`/api/audit-logs/${id}`);
  },
  verifyAuditChain(): Promise<AuditChainVerifyResult> {
    return request<AuditChainVerifyResult>('/api/audit-logs/chain/verify');
  },

  // Phase 1J CSV exports. Same query + permission as the JSON endpoints; return
  // a blob + filename for the caller to save. The audit export drops page/
  // pageSize (the server rejects them — export is the full filtered set).
  exportSalesSummary(query: ReportSummaryQuery): Promise<{ blob: Blob; filename: string }> {
    return downloadBlob(`/api/reports/sales-summary/export${reportQs(query)}`);
  },
  exportPurchaseSummary(query: ReportSummaryQuery): Promise<{ blob: Blob; filename: string }> {
    return downloadBlob(`/api/reports/purchase-summary/export${reportQs(query)}`);
  },
  exportAuditLogs(query: ListAuditLogsQuery): Promise<{ blob: Blob; filename: string }> {
    const { page: _page, pageSize: _pageSize, ...filters } = query;
    return downloadBlob(`/api/audit-logs/export${auditQs(filters)}`);
  },

  // Phase 1K-B tenant-side support access. The tenant authorizes a named
  // platform admin (read_only, time-limited, with a reason); reads/writes are
  // tenant-isolated by RLS and gated by support_access:grant/view/revoke. Every
  // write is audited into the tenant chain (visible in the 1I audit viewer).
  createSupportGrant(input: CreateSupportGrantInput): Promise<SupportGrant> {
    return request<SupportGrant>('/api/support-access', { method: 'POST', body: input });
  },
  listSupportGrants(query: ListSupportGrantsQuery = {}): Promise<Paginated<SupportGrant>> {
    const params = new URLSearchParams();
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    if (query.status) params.set('status', query.status);
    const qs = params.toString();
    return request<Paginated<SupportGrant>>(`/api/support-access${qs ? `?${qs}` : ''}`);
  },
  getSupportGrant(id: string): Promise<SupportGrant> {
    return request<SupportGrant>(`/api/support-access/${id}`);
  },
  revokeSupportGrant(id: string, reason: string): Promise<SupportGrant> {
    return request<SupportGrant>(`/api/support-access/${id}/revoke`, {
      method: 'POST',
      body: { reason },
    });
  },

  // Phase 1M subscription
  getSubscription(): Promise<SubscriptionDetail> {
    return request<SubscriptionDetail>('/api/subscription');
  },

  // Phase 1N notification settings
  getNotificationSettings(): Promise<NotificationSettings> {
    return request<NotificationSettings>('/api/notifications/settings');
  },
  updateNotificationSettings(
    body: Partial<{ orderEvents: boolean; userWelcome: boolean; supportAccess: boolean }>,
  ): Promise<NotificationSettings> {
    return request<NotificationSettings>('/api/notifications/settings', {
      method: 'PUT',
      body,
    });
  },

  // Phase 2A billing — tenant-side invoice list + detail + pay. Amount/currency
  // are server-derived; the client only lists, reads, and triggers payment.
  listInvoices(query: ListInvoicesQuery = {}): Promise<Paginated<InvoiceSummary>> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.page !== undefined) params.set('page', String(query.page));
    if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
    const qs = params.toString();
    return request<Paginated<InvoiceSummary>>(`/api/billing/invoices${qs ? `?${qs}` : ''}`);
  },
  getInvoice(id: string): Promise<InvoiceSummary> {
    return request<InvoiceSummary>(`/api/billing/invoices/${id}`);
  },
  payInvoice(id: string): Promise<InvoiceSummary> {
    return request<InvoiceSummary>(`/api/billing/invoices/${id}/pay`, { method: 'POST' });
  },
};

function payoutQs(query: ListPayoutsQuery): string {
  const params = new URLSearchParams();
  if (query.settlementId) params.set('settlementId', query.settlementId);
  if (query.status) params.set('status', query.status);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function commissionQs(query: CommissionQuery): string {
  const params = new URLSearchParams();
  params.set('from', query.from);
  params.set('to', query.to);
  if (query.caliber) params.set('caliber', query.caliber);
  if (query.tableId) params.set('tableId', query.tableId);
  if (query.salespersonId) params.set('salespersonId', query.salespersonId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function reportQs(query: ReportSummaryQuery): string {
  const params = new URLSearchParams();
  params.set('from', query.from);
  params.set('to', query.to);
  if (query.groupBy) params.set('groupBy', query.groupBy);
  if (query.granularity) params.set('granularity', query.granularity);
  if (query.caliber) params.set('caliber', query.caliber);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function invocationQs(query: ListInvocationsQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  if (query.status) params.set('status', query.status);
  if (query.fileId) params.set('fileId', query.fileId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function auditQs(query: ListAuditLogsQuery): string {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.actorId) params.set('actorId', query.actorId);
  if (query.actorType) params.set('actorType', query.actorType);
  if (query.action) params.set('action', query.action);
  if (query.resourceType) params.set('resourceType', query.resourceType);
  if (query.resourceId) params.set('resourceId', query.resourceId);
  if (query.requestId) params.set('requestId', query.requestId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
