export interface MeResponse {
  id: string;
  email: string;
  tenantId: string;
}

export interface LoginResponse {
  accessToken: string;
}

export type Currency = 'RMB' | 'USD' | 'HKD' | 'EUR';
// Phase 1F-C adds the approval-workflow states (pending_approval/approved/
// rejected) to the original lifecycle states. The new states are reachable only
// via the approval transition endpoints, not the create/update status field.
export type OrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'confirmed'
  | 'completed'
  | 'cancelled';

// Chinese display labels for every order status. Single source of truth for
// list rows, detail badges, and status filters across both order modules.
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: '草稿',
  pending_approval: '待审批',
  approved: '已批准',
  rejected: '已驳回',
  confirmed: '已确认',
  completed: '已完成',
  cancelled: '已取消',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status as OrderStatus] ?? status;
}

// Supported tenant base (reporting) currencies. Mirrors the backend
// SUPPORTED_BASE_CURRENCIES whitelist on the tenant-settings API.
export const SUPPORTED_BASE_CURRENCIES: Currency[] = ['RMB', 'USD', 'HKD', 'EUR'];

export interface BaseCurrencyResponse {
  base_currency: Currency;
}

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

// ---- Phase 1F-D: reports ------------------------------------------------
// Status caliber: which order states feed the summed amount (§2.3 of the plan).
export type ReportCaliber = 'realized' | 'approved_up' | 'pipeline' | 'all';
export type ReportGroupBy = 'status' | 'customer' | 'supplier' | 'period';
export type ReportGranularity = 'month' | 'day';

export const REPORT_CALIBER_LABELS: Record<ReportCaliber, string> = {
  realized: '已实现（已确认+已完成）',
  approved_up: '已批准及以上',
  pipeline: '在途（草稿/待审批/已驳回）',
  all: '全部（不含已取消）',
};

export interface ReportSummaryQuery {
  from: string;
  to: string;
  groupBy?: ReportGroupBy;
  granularity?: ReportGranularity;
  caliber?: ReportCaliber;
}

// One grouped row: amounts are decimal strings in the tenant base currency.
export interface ReportRow {
  key: string;
  label: string;
  orderCount: number;
  amountBase: string;
  unCostedCount: number;
}

export interface ReportSummaryResponse {
  caliber: ReportCaliber;
  currency: Currency;
  range: { from: string; to: string; granularity: ReportGranularity };
  groupBy: ReportGroupBy;
  rows: ReportRow[];
  totals: { orderCount: number; amountBase: string; unCostedCount: number };
}

// ---- Phase 1F-E commission -------------------------------------------------
// Commission reuses the 1F-D status caliber verbatim. Amounts are decimal
// strings in the tenant base currency; the frontend never recomputes them.
export type CommissionCaliber = ReportCaliber;
export type CommissionRateSource = 'rule' | 'default' | 'none';

export const COMMISSION_CALIBER_LABELS: Record<CommissionCaliber, string> = REPORT_CALIBER_LABELS;

export interface CommissionQuery {
  from: string;
  to: string;
  caliber?: CommissionCaliber;
  tableId?: string;
  salespersonId?: string;
}

interface CommissionEnvelope {
  caliber: CommissionCaliber;
  currency: Currency;
  range: { from: string; to: string };
  tableId: string | null;
  locked: boolean;
}

export interface CommissionSummaryRow {
  salespersonId: string;
  salespersonName: string;
  basisBase: string;
  rateApplied: string;
  rateSource: CommissionRateSource;
  commissionBase: string;
  orderCount: number;
  unCostedCount: number;
}

export interface CommissionSummaryResponse extends CommissionEnvelope {
  rows: CommissionSummaryRow[];
  totals: { basisBase: string; commissionBase: string; orderCount: number; unCostedCount: number };
}

export interface CommissionOrderRow {
  orderId: string;
  orderNumber: string;
  orderType: 'sales' | 'purchase';
  salespersonId: string;
  salespersonName: string;
  amountBase: string | null;
  rateApplied: string;
  rateSource: CommissionRateSource;
  commissionBase: string;
  status: string;
}

export interface CommissionOrdersResponse extends CommissionEnvelope {
  rows: CommissionOrderRow[];
  totals: { basisBase: string; commissionBase: string; orderCount: number; unCostedCount: number };
}

export interface CommissionRule {
  salespersonId: string;
  rate: string;
}

export interface CommissionTable {
  id: string;
  name: string;
  default_rate: string;
  status: 'active' | 'archived';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CommissionTableDetail extends CommissionTable {
  rules: CommissionRule[];
}

export interface CreateCommissionTableInput {
  name: string;
  defaultRate?: string;
  rules?: CommissionRule[];
}

export interface UpdateCommissionTableInput {
  name?: string;
  defaultRate?: string;
  status?: 'active' | 'archived';
}

export interface ReplaceCommissionRulesInput {
  rules: CommissionRule[];
}

export interface CommissionSettlement {
  id: string;
  commission_table_id: string;
  period_start: string;
  period_end: string;
  caliber: CommissionCaliber;
  status: 'locked' | 'unlocked';
  total_commission_base: string;
  total_basis_base: string;
  uncosted_count: number;
}

export interface CommissionSettlementLine {
  salesperson_user_id: string;
  salesperson_name: string | null;
  basis_base: string;
  rate_applied: string;
  commission_base: string;
  order_count: number;
  uncosted_count: number;
}

export interface CommissionSettlementDetail extends CommissionSettlement {
  snapshot?: unknown;
  lines: CommissionSettlementLine[];
}

export interface CreateSettlementInput {
  tableId: string;
  from: string;
  to: string;
  caliber?: CommissionCaliber;
}

// Phase 1F-F commission payout / disbursement. Amounts are base-currency
// decimal strings copied server-side from a locked settlement; the frontend
// never computes them. Unlike settlements, payout responses are camelCase and
// carry an envelope `currency` code (plan §6).
export type CommissionPayoutStatus = 'open' | 'paid' | 'void';
export type CommissionPayoutLineStatus = 'pending' | 'paid' | 'void';

export interface CommissionPayout {
  id: string;
  settlementId: string;
  status: CommissionPayoutStatus;
  totalPayoutBase: string;
  currency: Currency;
  payoutDate: string | null;
  externalRef: string | null;
  createdAt: string;
}

export interface CommissionPayoutLine {
  id: string;
  salespersonUserId: string;
  salespersonName: string | null;
  settlementLineId: string;
  amountBase: string;
  status: CommissionPayoutLineStatus;
  paidAt: string | null;
}

export interface CommissionPayoutDetail extends CommissionPayout {
  note: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  lines: CommissionPayoutLine[];
}

export interface CreatePayoutInput {
  settlementId: string;
  note?: string;
}

export interface PayPayoutInput {
  payoutDate: string;
  externalRef?: string;
  note?: string;
}

export interface ListPayoutsQuery {
  settlementId?: string;
  status?: CommissionPayoutStatus;
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
