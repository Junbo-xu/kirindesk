import {
  ApiError,
  BaseCurrencyResponse,
  CreateCustomerInput,
  CreateSalesOrderInput,
  CreateSupplierInput,
  CreatePurchaseOrderInput,
  Currency,
  CustomerResponse,
  FileResponse,
  FileDownloadToken,
  LoginResponse,
  MeResponse,
  Paginated,
  SalesOrderResponse,
  SupplierResponse,
  PurchaseOrderResponse,
  UpdateCustomerInput,
  UpdateSalesOrderInput,
  UpdateSupplierInput,
  UpdatePurchaseOrderInput,
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
};
