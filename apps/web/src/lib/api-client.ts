import {
  ApiError,
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
  ListPayoutsQuery,
  ListInvocationsQuery,
  LoginResponse,
  MeResponse,
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
  RoleSummary,
  RoleDetail,
  CreateRoleInput,
  UpdateRoleInput,
  PermissionGrantInput,
  CatalogModule,
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
  try {
    const data = await res.json();
    if (Array.isArray(data?.message)) {
      fields = data.message as string[];
      message = fields.join('；');
    } else if (typeof data?.message === 'string') {
      message = data.message;
    }
  } catch {
    // non-JSON body; keep the default message
  }
  return new ApiError(res.status, message, fields);
}

export const apiClient = {
  login(email: string, password: string, tenantSlug: string): Promise<LoginResponse> {
    return request<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: { email, password, tenantSlug },
      auth: false,
    });
  },
  getMe(): Promise<MeResponse> {
    return request<MeResponse>('/api/auth/me');
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
