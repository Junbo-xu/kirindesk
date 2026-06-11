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

export interface SalesOrderResponse {
  id: string;
  customer_id: string;
  owner_user_id: string;
  order_number: string;
  pi_number: string | null;
  currency: Currency;
  total_amount: string;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
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
  total_amount: string;
  pi_number?: string;
  status?: OrderStatus;
  notes?: string;
}

export interface UpdateSalesOrderInput {
  pi_number?: string;
  currency?: Currency;
  total_amount?: string;
  status?: OrderStatus;
  notes?: string;
}

export interface CustomerOption {
  id: string;
  company_name: string;
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
