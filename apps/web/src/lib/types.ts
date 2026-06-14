export interface MeResponse {
  id: string;
  email: string;
  tenantId: string;
}

export interface LoginResponse {
  accessToken: string;
}

export type Currency = 'RMB' | 'USD' | 'HKD' | 'EUR';
export type OrderStatus = 'draft' | 'confirmed' | 'completed' | 'cancelled';

// A line item as sent to the API. line_no and line_total are derived
// server-side, so they are not part of the input.
export interface OrderItemInput {
  description: string;
  product_code?: string;
  unit?: string;
  quantity: string;
  unit_price: string;
  notes?: string;
}

// A persisted line item returned by the API (single-order responses).
export interface OrderItemResponse {
  id: string;
  line_no: number;
  description: string;
  product_code: string | null;
  unit: string | null;
  quantity: string;
  unit_price: string;
  line_total: string;
  notes: string | null;
}

export interface SalesOrderResponse {
  id: string;
  customer_id: string;
  owner_user_id: string;
  order_number: string;
  pi_number: string | null;
  currency: Currency;
  total_amount: string;
  status: OrderStatus;
  // Phase 1F-B FX snapshot (original currency -> tenant base currency). NULL
  // until a rate is frozen (draft/cross-currency with no resolvable rate).
  fx_rate: string | null;
  fx_rate_source: string | null;
  fx_captured_at: string | null;
  total_amount_base: string | null;
  created_at: string;
  updated_at: string;
  // Present on single-order responses (getOne/create/update), not in list rows.
  items?: OrderItemResponse[];
}

export interface Paginated<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface CreateSalesOrderInput {
  customer_id: string;
  order_number: string;
  currency: Currency;
  pi_number?: string;
  status?: OrderStatus;
  notes?: string;
  // Optional manual exchange rate (original -> base). Omit to let the server
  // resolve it (same-currency=1, else exchange_rates lookup).
  fx_rate?: string;
  // total_amount is derived server-side from items; never sent by the client.
  items?: OrderItemInput[];
}

export interface UpdateSalesOrderInput {
  pi_number?: string;
  currency?: Currency;
  status?: OrderStatus;
  notes?: string;
  // Optional manual exchange rate; omit to let the server re-resolve it.
  fx_rate?: string;
  // When present, replaces the order's full line set (server re-derives total).
  items?: OrderItemInput[];
}

export interface CustomerOption {
  id: string;
  company_name: string;
}

export interface SupplierOption {
  id: string;
  company_name: string;
}

export interface PurchaseOrderResponse {
  id: string;
  supplier_id: string;
  owner_user_id: string;
  order_number: string;
  pi_number: string | null;
  currency: Currency;
  total_amount: string;
  status: OrderStatus;
  // Phase 1F-B FX snapshot (original currency -> tenant base currency). NULL
  // until a rate is frozen (draft/cross-currency with no resolvable rate).
  fx_rate: string | null;
  fx_rate_source: string | null;
  fx_captured_at: string | null;
  total_amount_base: string | null;
  created_at: string;
  updated_at: string;
  // Present on single-order responses (getOne/create/update), not in list rows.
  items?: OrderItemResponse[];
}

export interface CreatePurchaseOrderInput {
  supplier_id: string;
  order_number: string;
  currency: Currency;
  pi_number?: string;
  status?: OrderStatus;
  notes?: string;
  // Optional manual exchange rate (original -> base). Omit to let the server
  // resolve it (same-currency=1, else exchange_rates lookup).
  fx_rate?: string;
  // total_amount is derived server-side from items; never sent by the client.
  items?: OrderItemInput[];
}

export interface UpdatePurchaseOrderInput {
  pi_number?: string;
  currency?: Currency;
  status?: OrderStatus;
  notes?: string;
  // Optional manual exchange rate; omit to let the server re-resolve it.
  fx_rate?: string;
  // When present, replaces the order's full line set (server re-derives total).
  items?: OrderItemInput[];
}

export type CustomerStatus = 'active' | 'inactive';

export interface CustomerResponse {
  id: string;
  company_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  source: string | null;
  status: CustomerStatus;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CreateCustomerInput {
  company_name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  country?: string;
  source?: string;
  status?: CustomerStatus;
  notes?: string;
}

export interface UpdateCustomerInput {
  company_name?: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  country?: string;
  source?: string;
  status?: CustomerStatus;
  notes?: string;
}

export type SupplierStatus = 'active' | 'inactive';

export interface SupplierResponse {
  id: string;
  company_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  category: string | null;
  status: SupplierStatus;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSupplierInput {
  company_name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  country?: string;
  category?: string;
  status?: SupplierStatus;
  notes?: string;
}

export interface UpdateSupplierInput {
  company_name?: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  country?: string;
  category?: string;
  status?: SupplierStatus;
  notes?: string;
}

export interface FileResponse {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  purpose: string | null;
  uploaded_by: string;
  created_at: string;
}

export interface FileDownloadToken {
  token: string;
  expiresAt: string;
}

// Normalized API error thrown by the client for non-2xx responses.
export class ApiError extends Error {
  status: number;
  // Field-level validation messages from the global ValidationPipe, when present.
  fields?: string[];

  constructor(status: number, message: string, fields?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
  }
}
