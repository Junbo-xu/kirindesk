export interface MeResponse {
  id: string;
  email: string;
  tenantId: string;
  permissions: Record<string, 'all' | 'assigned' | 'own'>;
  workflowMode: 'active' | 'read_only' | 'hidden';
}

export interface WorkbenchTask {
  key: string;
  label: string;
  count: number;
  href: string;
  urgency: 'normal' | 'high' | 'critical';
}

export interface WorkbenchSummary {
  key: string;
  label: string;
  value: string | number;
  amount?: string;
  currency?: string;
  href: string;
}

export interface WorkbenchResponse {
  generatedAt: string;
  capabilities: Array<'business' | 'procurement' | 'finance' | 'approver' | 'admin'>;
  tasks: WorkbenchTask[];
  summaries: WorkbenchSummary[];
}

export type BusinessExceptionType =
  | 'price_variance'
  | 'quantity_variance'
  | 'quality_variance'
  | 'missing_expense'
  | 'duplicate_customer';
export type BusinessExceptionStatus = 'open' | 'assigned' | 'in_progress' | 'resolved' | 'closed';

export interface BusinessException {
  id: string;
  contextType: string;
  contextId: string;
  type: BusinessExceptionType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: BusinessExceptionStatus;
  summary: string;
  ownerUserId: string | null;
  assignedToUserId: string | null;
  assigneeName: string | null;
  resolution: string | null;
  version: number;
  detectedAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessEvent {
  id: string;
  chainType: string;
  chainId: string;
  credentialType: string;
  credentialId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  occurredAt: string;
}

export interface ExceptionAssignee {
  id: string;
  name: string;
  email: string;
}

export interface InquiryItemSummary {
  id: string;
  line_no: number;
  description: string;
  specifications: string | null;
  quantity: string;
  unit: string;
  target_price_usd: string | null;
}

export interface InquirySummary {
  id: string;
  owner_user_id: string;
  customer_id: string | null;
  customer_code: string;
  customer_country: string;
  customer_message: string;
  source_version: number;
  status: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  items: InquiryItemSummary[];
}

export interface InquiryItemInput {
  description: string;
  specifications?: string;
  quantity: string;
  unit: string;
  target_price_usd?: string;
}

export interface CreateInquiryInput {
  customer_code: string;
  customer_country: string;
  customer_message: string;
  items: InquiryItemInput[];
}

export interface UpdateInquiryInput extends CreateInquiryInput {
  expected_version: number;
}

export interface SalesQuotationLine {
  id: string;
  inquiry_item_id: string;
  variant_key: string;
  variant_value: string;
  quantity: string;
  unit_price: string;
  minimum_quantity: string | null;
  lead_time_days: number | null;
}

export interface SalesQuotation {
  id: string;
  inquiry_id: string;
  version: number;
  currency: Currency;
  valid_until: string;
  updated_at: string;
  lines: SalesQuotationLine[];
}

export interface CommercialSelection {
  id: string;
  inquiry_id: string;
  inquiry_item_id: string;
  quotation_version: number;
  commercial: {
    sales_currency: Currency;
    sales_unit_price: string;
    purchase_to_sales_fx_rate: string;
    fx_rate_source: string;
    fx_captured_at: string;
    purchase_unit_cost: string;
    gross_profit_unit: string;
    gross_margin_bps: number;
    margin_threshold_bps: number;
    margin_status: 'meets_threshold' | 'below_threshold';
    margin_formula_version: string;
    margin_approved: boolean;
    margin_approved_at: string | null;
  } | null;
  snapshot: {
    currency: Currency;
    valid_until: string;
    line: SalesQuotationLine;
    inquiry_item: InquiryItemSummary & { inquiry_id: string; specifications: string | null };
  };
  created_at: string;
}

export interface ProformaInvoiceItem {
  id: string;
  selection_id: string;
  line_no: number;
  description: string;
  specifications: string | null;
  quantity: string;
  unit: string;
  unit_price: string;
  line_total: string;
  selection_snapshot: Record<string, unknown>;
}

export interface ProformaInvoice {
  id: string;
  series_id: string;
  inquiry_id: string;
  customer_id: string;
  sales_order_id: string | null;
  pi_number: string;
  version: number;
  currency: Currency;
  payment_terms: string;
  status: 'draft' | 'issued' | 'customer_confirmed';
  total_amount: string;
  issued_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  is_current?: boolean;
  items: ProformaInvoiceItem[];
}

export interface CustomerReceipt {
  id: string;
  proforma_invoice_id: string;
  sales_order_id: string;
  amount: string;
  currency: Currency;
  received_at: string;
  method: 'bank_transfer' | 'cash' | 'card_external' | 'other_external';
  external_reference: string;
  proof_file_id: string | null;
  status: 'recorded' | 'confirmed' | 'rejected';
  decision_reason: string | null;
  payment_provider_status: 'not_verified';
  created_at: string;
}

export interface ProcurementGate {
  id: string;
  sales_order_id: string;
  proforma_invoice_id: string;
  status: 'blocked' | 'open' | 'bypassed';
  order_amount: string;
  confirmed_amount: string;
  required_amount: string;
  currency: Currency;
  required_ratio_bps: number;
  proof_required: boolean;
  config_enabled: boolean;
  bypass_reason: string | null;
  blocking_reasons: string[];
  evaluated_at: string;
}

export interface CommercialSettings {
  minimum_margin_bps: number;
  procurement_gate_enabled: boolean;
  required_receipt_ratio_bps: number;
  receipt_proof_required: boolean;
  bypass_reason: string | null;
}

export interface FulfillmentSettings {
  require_sales_receipt_confirmation: boolean;
}

export interface FulfillmentOrderItem {
  id: string;
  line_no: number;
  description: string;
  quantity: string;
  unit: string | null;
  accepted_quantity: string;
  shipped_quantity: string;
  delivered_quantity: string;
  available_quantity: string;
}

export interface FulfillmentPurchaseOrderItem {
  id: string;
  line_no: number;
  description: string;
  quantity: string;
  unit: string | null;
}

export interface FulfillmentPurchaseOrder {
  id: string;
  order_number: string;
  currency: Currency;
  status: string;
  items: FulfillmentPurchaseOrderItem[];
}

export interface GoodsReceiptItem {
  id: string;
  purchase_order_item_id: string;
  sales_order_item_id: string;
  received_quantity: string;
  accepted_quantity: string;
  rejected_quantity: string;
  quantity_variance: string;
}

export interface GoodsReceipt {
  id: string;
  sales_order_id: string;
  purchase_order_id: string;
  batch_number: string;
  status: 'pending' | 'inspected' | 'accepted' | 'rejected';
  qc_result: 'passed' | 'partial' | 'failed' | null;
  is_final_batch: boolean;
  sales_confirmation_required: boolean;
  note: string | null;
  created_at: string;
  items: GoodsReceiptItem[];
  files: Array<{ file_id: string; file_role: string }>;
  confirmations: Array<{
    id: string;
    confirmation_type: 'procurement_qc' | 'sales_acceptance';
    decision: 'accepted' | 'rejected';
    reason: string | null;
    confirmed_at: string;
  }>;
}

export interface Shipment {
  id: string;
  sales_order_id: string;
  batch_number: string;
  status: 'draft' | 'dispatched' | 'delivered';
  carrier: string;
  tracking_number: string;
  dispatched_at: string | null;
  delivered_at: string | null;
  delivery_proof_file_id: string | null;
  delivery_note: string | null;
  items: Array<{
    id: string;
    sales_order_item_id: string;
    quantity: string;
    available_quantity_snapshot: string;
  }>;
  logistics_events: Array<{
    id: string;
    event_type: string;
    location: string | null;
    description: string | null;
    occurred_at: string;
  }>;
  receipts: Array<{
    id: string;
    customer_receipt_id: string;
    amount: string;
    currency: Currency;
    received_at: string;
    status: 'recorded' | 'confirmed';
  }>;
}

export interface OrderExpense {
  id: string;
  sales_order_id: string;
  shipment_id: string | null;
  expense_type: 'freight' | 'insurance' | 'customs' | 'other';
  amount: string;
  currency: Currency;
  fx_rate_to_rmb: string | null;
  fx_source: string | null;
  fx_captured_at: string | null;
  amount_rmb: string | null;
  status: 'pending_fx' | 'complete';
  note: string | null;
  created_at: string;
}

export interface FulfillmentOrder {
  id: string;
  order_number: string;
  currency: Currency;
  aggregate_status: string;
  settings: FulfillmentSettings;
  items: FulfillmentOrderItem[];
  purchase_orders: FulfillmentPurchaseOrder[];
  goods_receipts: GoodsReceipt[];
  shipments: Shipment[];
  expenses: OrderExpense[];
}

export interface CreateGoodsReceiptInput {
  batch_number: string;
  is_final_batch: boolean;
  items: Array<{ purchase_order_item_id: string; received_quantity: string }>;
  file_ids?: string[];
  note?: string;
}

export interface CreateShipmentInput {
  batch_number: string;
  carrier: string;
  tracking_number: string;
  items: Array<{ sales_order_item_id: string; quantity: string }>;
}

export interface CompleteExpenseFxInput {
  fx_rate_to_rmb: string;
  fx_source: string;
  fx_captured_at: string;
}

export interface QuoteTaskSummary {
  id: string;
  inquiry_id: string;
  customer_country: string;
  sanitization_status: string;
  sanitized_summary: string | null;
  items: Array<{ inquiry_item_id: string; description: string; quantity: string; unit: string }>;
  last_error_code: string | null;
  attempt_count: number;
  updated_at: string;
}

export interface ProcurementQuotationLine {
  id: string;
  inquiry_item_id: string;
  variant_key: string;
  variant_value: string;
  quantity: string;
  unit_price: string;
  minimum_quantity: string | null;
  lead_time_days: number | null;
  terms: string | null;
}

export interface ProcurementQuotation {
  id: string;
  inquiry_id: string;
  supplier_id: string;
  entered_by: string;
  version: number;
  currency: Currency;
  valid_until: string;
  source_text: string | null;
  created_at: string;
  updated_at: string;
  lines: ProcurementQuotationLine[];
}

export interface QuotationOverwriteSequence {
  quotation_id: string;
  complete: true;
  current_version: number;
  sequence: Array<{
    event_id: string;
    action: 'supplier_quotation.created' | 'supplier_quotation.replaced';
    actor_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
    created_at: string;
  }>;
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
  source_quote_id: string | null;
  source_quote_version: number | null;
  source_quote_number: string | null;
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

// ---- Phase 1G AI/OCR ----
// Read endpoints return only this summary (never the raw provider_invocations
// row); the full OCR text / AI output is returned live at process time and is
// never persisted, so it is absent from the summary.
export interface InvocationSummary {
  id: string;
  providerType: string; // 'ocr' | 'ai'
  providerName: string; // mock-only: always 'mock'
  action: string; // 'ocr.extract' | 'ai.complete'
  status: string; // 'success' | 'error'
  durationMs: number | null;
  tokensUsed: number | null;
  sourceFileId: string | null;
  createdAt: string;
}

export interface OcrField {
  key: string;
  value: string;
  confidence: number;
}

// POST /api/ai/ocr — live result; text/fields are NOT persisted.
export interface OcrExtractResponse {
  invocation: InvocationSummary;
  text: string;
  fields: OcrField[];
  confidence: number;
}

// POST /api/ai/complete — live result; output is NOT persisted.
export interface AiCompleteResponse {
  invocation: InvocationSummary;
  output: string;
}

export interface InvocationListResult {
  data: InvocationSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListInvocationsQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  fileId?: string;
}

export interface OcrExtractRequestBody {
  fileId: string;
  docType?: string;
  options?: { timeoutMs?: number; languages?: string[] };
}

export interface AiCompleteRequestBody {
  task: string;
  input: string;
  options?: { timeoutMs?: number; maxOutputTokens?: number };
}

// ---- Phase 1H: tenant user & role management ----------------------------
export type UserStatus = 'active' | 'inactive';

// data_scope vocabulary shared with the backend. The web permission matrix
// offers all / own; assigned is preserved if it already exists on a grant.
export type DataScope = 'all' | 'assigned' | 'own';

export const DATA_SCOPE_LABELS: Record<DataScope, string> = {
  all: '全部',
  assigned: '指派',
  own: '本人',
};

export interface UserRoleBrief {
  id: string;
  name: string;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: UserStatus;
  isTenantOwner: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserDetail extends UserSummary {
  roles: UserRoleBrief[];
}

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  phone?: string;
  roleIds?: string[];
}

export interface UpdateUserInput {
  name?: string;
  phone?: string;
  status?: UserStatus;
}

export interface ListUsersQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: UserStatus;
}

// A role's permission grant (returned by getRole). Carries the resolved code /
// name for display plus the persisted data_scope.
export interface PermissionGrant {
  permissionId: string;
  code: string;
  name: string;
  action: string;
  dataScope: string;
}

export interface RoleSummary {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissionCount: number;
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoleDetail extends RoleSummary {
  permissions: PermissionGrant[];
}

export interface CreateRoleInput {
  name: string;
  description?: string;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
}

// A single grant sent to PUT /api/roles/:id/permissions.
export interface PermissionGrantInput {
  permissionId: string;
  dataScope: DataScope;
}

// Read-only permission catalog (GET /api/permissions), grouped by module.
export interface CatalogPermission {
  id: string;
  code: string;
  name: string;
  action: string;
}

export interface CatalogModule {
  code: string;
  name: string;
  permissions: CatalogPermission[];
}

// ---- Phase 1I: audit log viewer (read-only consumer of audit_logs) -------

export type AuditActorType = 'tenant_user' | 'platform_admin' | 'system';

// List/detail share these summary fields. `id` is a bigint surfaced as a
// string (precision-safe); hash-chain internals are never exposed by the API.
export interface AuditLogSummary {
  id: string;
  tenantId: string | null;
  actorType: string;
  actorId: string;
  actorName: string | null; // resolved for tenant_user actors, else null
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: string;
}

// GET /api/audit-logs/:id — adds the before/after snapshots + context.
export interface AuditLogDetail extends AuditLogSummary {
  before: unknown;
  after: unknown;
  metadata: unknown;
  reason: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ListAuditLogsQuery {
  page?: number;
  pageSize?: number;
  from?: string;
  to?: string;
  actorId?: string;
  actorType?: AuditActorType;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
}

// GET /api/audit-logs/chain/verify — tenant chain integrity conclusion.
export interface AuditChainVerifyResult {
  ok: boolean;
  total: number;
  failedAt?: { id: string; reason: string };
}

// ---- Phase 1K-B: platform support access (tenant grant + platform read) ----

// Scope a grant authorizes. Only read_only this phase (mirrors the backend
// CHECK + DTO); enumerated so a wider scope is an explicit, reviewed add.
export type SupportAccessScope = 'read_only';

// Stored grant lifecycle status (037 CHECK). Validity is DERIVED by the UI from
// status + expires_at (an `active` row past expires_at renders as expired).
export type GrantStatus = 'pending' | 'active' | 'revoked' | 'expired';

// A support-access grant as returned by the tenant-side endpoints. A grant is a
// governance credential (who/why/scope/when + lifecycle stamps), not business
// data; platformAdminEmail is joined so the tenant sees who they authorized.
export interface SupportGrant {
  id: string;
  tenantId: string;
  platformAdminId: string;
  platformAdminEmail: string | null;
  scope: string;
  reason: string;
  status: string;
  expiresAt: string;
  grantedByUserId: string;
  approvedAt: string | null;
  revokedByUserId: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSupportGrantInput {
  platformAdminEmail: string;
  reason: string;
  scope: SupportAccessScope;
  expiresAt: string; // ISO-8601; the server re-checks > now()
}

export interface ListSupportGrantsQuery {
  page?: number;
  pageSize?: number;
  status?: GrantStatus;
}

// Platform-side login (POST /api/platform-auth/login — no tenantSlug). The
// access token here is platform-jwt, stored under a separate key from the
// tenant token (kd_platform_token vs kd_access_token).
export interface PlatformLoginResponse {
  accessToken: string;
  admin: { id: string; email: string; name: string };
}

export interface PlatformAdmin {
  id: string;
  email: string;
}

// "Which tenants named me?" (GET /api/platform/support/grants). Minimal shape —
// the platform admin sees only the authorization terms, never tenant data here.
export interface MyGrant {
  grantId: string;
  tenantId: string;
  scope: string;
  status: string;
  expiresAt: string;
}

// Platform-side tenant lifecycle (1K-A, plan §5.3). The three persisted statuses
// (no derived state — unlike support grants). 'deactivated' is the terminal
// soft-stop ("delete" in the UI sense); there is no hard delete.
export type TenantStatus = 'active' | 'suspended' | 'deactivated';

// Tenant metadata returned by /api/platform/tenants — NEVER business data (§3.4).
// Date columns arrive as ISO strings over JSON.
export interface PlatformTenantSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  suspendedAt: string | null;
  suspendedReason: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListPlatformTenantsQuery {
  page?: number;
  pageSize?: number;
  status?: TenantStatus;
}

// Phase 1L tenant onboarding (plan §5.2).
export interface CreateTenantInput {
  name: string;
  slug: string;
  ownerEmail: string;
  ownerPassword: string; // only lives in memory; never written to storage/URL
  ownerName: string;
  contactEmail?: string;
  contactPhone?: string;
  timezone?: string;
  locale?: string;
}

// Phase 1M subscription (plan §4.1 / §5).
export interface SubscriptionDetail {
  plan: {
    id: string;
    code: string;
    name: string;
    maxUsers: number;
    maxStorageGb: number;
    aiQuotaMonthly: number;
    expiresAt: string | null;
  };
  usage: {
    userCount: number;
    storageBytes: string; // pg bigint as string
    aiCallsMonth: number;
    aiCallsResetAt: string;
  };
  modules: { code: string; name: string; enabled: boolean }[];
}

export interface PlanSummary {
  id: string;
  code: string;
  name: string;
  maxUsers: number;
  maxStorageGb: number;
  aiQuotaMonthly: number;
  status: string;
}

export interface TenantSubscription {
  tenant_id: string;
  plan_id: string | null;
  plan_assigned_at: string | null;
  plan_expires_at: string | null;
  plan_code: string | null;
  plan_name: string | null;
  max_users: number;
  max_storage_gb: number;
  ai_quota_monthly: number;
  user_count: number;
  storage_bytes: string;
  ai_calls_month: number;
}

export interface TenantOnboardingResult {
  tenant: PlatformTenantSummary;
  owner: {
    id: string;
    tenantId: string;
    email: string;
    name: string;
    status: string;
    isOwner: boolean;
    createdAt: string;
  };
}

// Phase 1N notification settings (plan §4.1).
export interface NotificationSettings {
  tenantId: string;
  orderEvents: boolean;
  userWelcome: boolean;
  supportAccess: boolean;
}

// Phase 2A billing — invoice summary mirrors the backend InvoiceSummary shape.
// amount is the numeric(…,2) decimal string derived from amountCents (integer
// cents); the frontend displays amount and never recomputes money.
export interface InvoiceSummary {
  id: string;
  planId: string;
  billingPeriod: string;
  amount: string;
  amountCents: string;
  currency: string;
  status: 'pending' | 'paid' | 'void' | string;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
  voidReason: string | null;
}

export interface ListInvoicesQuery {
  status?: 'pending' | 'paid' | 'void';
  page?: number;
  pageSize?: number;
}

// Phase 2B: tenant self-service registration (POST /api/auth/signup).
// ownerPassword only ever lives in component state — never written to
// storage, URL, or logged.
export interface SignupInput {
  tenantName: string;
  slug: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerName: string;
  contactPhone?: string;
}

// Mirrors the backend TenantOnboardingResult (tenant + owner summary). No
// password / password_hash fields are returned.
export interface SignupResult {
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
  };
  owner: {
    id: string;
    email: string;
    name: string;
    isOwner: boolean;
  };
}

export type FinanceSourceType =
  | 'customer_receipt'
  | 'purchase_cost'
  | 'order_expense'
  | 'after_sales_adjustment';
export type CommissionRoleType = 'sales' | 'procurement';
export type CommissionBasisType = 'sales_revenue' | 'gross_profit' | 'net_profit';

export interface FinanceOrderSummary {
  id: string;
  order_number: string;
  status: string;
  currency: Currency;
  total_amount: string;
  finance_decision: 'verified' | 'returned' | null;
  profit_status: 'provisional' | 'final' | null;
  commission_status: 'calculated' | 'locked' | null;
}

export interface FinanceOrderDetailOrder {
  id: string;
  owner_user_id: string;
  order_number: string;
  status: string;
  currency: Currency;
  total_amount: string;
}

export interface FinanceSource {
  subject_type: FinanceSourceType;
  id: string;
  amount: string;
  currency: Currency;
  expense_type: 'freight' | 'insurance' | 'customs' | 'other' | null;
  status: string;
  fx_rate_to_rmb: string | null;
  fx_source: string | null;
  fx_captured_at: string | null;
  amount_rmb: string | null;
  needs_fx: boolean;
}

export interface FinanceReviewItem {
  id: string;
  subject_type:
    | FinanceSourceType
    | 'missing_receipt'
    | 'missing_cost'
    | 'missing_freight'
    | 'missing_fx';
  subject_id: string | null;
  decision: 'verified' | 'returned';
  source_amount: string | null;
  source_currency: Currency | null;
  fx_rate_to_rmb: string | null;
  fx_source: string | null;
  fx_captured_at: string | null;
  amount_rmb: string | null;
}

export interface FinanceReview {
  id: string;
  version: number;
  decision: 'verified' | 'returned';
  reason: string | null;
  input_fingerprint: string;
  missing_items: string[];
  reviewed_by: string;
  reviewed_at: string;
  items: FinanceReviewItem[];
}

export interface ProfitSnapshot {
  id: string;
  version: number;
  status: 'provisional' | 'final';
  supersedes_id: string | null;
  finance_review_id: string | null;
  formula_version: string;
  input_fingerprint: string;
  input_snapshot: Record<string, unknown>;
  missing_items: string[];
  revenue_rmb: string;
  purchase_cost_rmb: string;
  freight_rmb: string;
  other_expense_rmb: string;
  refund_rmb: string;
  gross_profit_rmb: string;
  net_profit_rmb: string;
  created_by: string;
  created_at: string;
}

export interface CommissionRuleV2 {
  id: string;
  role_type: CommissionRoleType;
  version: number;
  supersedes_id: string | null;
  basis_type: CommissionBasisType;
  rate_bps: number;
  created_by: string;
  created_at: string;
}

export interface CommissionCandidateLineV2 {
  id: string;
  role_type: CommissionRoleType;
  user_id: string;
  user_name: string;
  rule_version_id: string;
  basis_type: CommissionBasisType;
  raw_basis_rmb: string;
  eligible_basis_rmb: string;
  share_bps: number;
  allocated_basis_rmb: string;
  rate_bps: number;
  commission_amount_rmb: string;
}

export interface CommissionCandidateV2 {
  id: string;
  sales_order_id: string;
  profit_snapshot_id: string;
  version: number;
  supersedes_id: string | null;
  formula_version: string;
  calculation_snapshot: Record<string, unknown>;
  total_commission_rmb: string;
  revision_reason: string | null;
  created_by: string;
  created_at: string;
  status: 'calculated' | 'locked';
  is_current: boolean;
  lock: {
    id: string;
    locked_by: string;
    locked_at: string;
    comment: string | null;
  } | null;
  lines: CommissionCandidateLineV2[];
}

export interface FinanceOrderDetail {
  order: FinanceOrderDetailOrder;
  source_state: {
    fingerprint: string;
    missing_items: string[];
    receipts: FinanceSource[];
    purchase_costs: FinanceSource[];
    expenses: FinanceSource[];
    after_sales_adjustments: FinanceSource[];
  };
  finance_reviews: FinanceReview[];
  profit_snapshots: ProfitSnapshot[];
  commission_rules: CommissionRuleV2[];
  commission_candidates: CommissionCandidateV2[];
  participants: Array<{ id: string; name: string; email: string }>;
}

export interface FinanceConversionInput {
  subject_type: 'customer_receipt' | 'purchase_cost';
  subject_id: string;
  fx_rate_to_rmb: string;
  fx_source: string;
  fx_captured_at: string;
}

export interface CommissionAllocationInput {
  role_type: CommissionRoleType;
  participants: Array<{ user_id: string; share_bps: number }>;
}

export interface CalculateCommissionCandidateInput {
  allocations: CommissionAllocationInput[];
  revision_reason?: string;
}

export type SampleOrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'dispatched'
  | 'delivered'
  | 'confirmed'
  | 'converted'
  | 'closed';

export interface SampleOrderItem {
  id: string;
  line_no: number;
  description: string;
  specifications: string | null;
  sample_quantity: string;
  maximum_conversion_quantity: string;
  unit: string;
  sales_currency: Currency;
  sales_unit_price: string;
  margin_status: string;
  supplier_id?: string;
  purchase_unit_cost?: string;
  purchase_to_sales_fx_rate?: string;
  fx_rate_source?: string;
  fx_captured_at?: string;
  source_selection_id?: string;
  source_snapshot?: Record<string, unknown>;
}

export interface SampleOrder {
  id: string;
  inquiry_id: string;
  customer_id: string;
  owner_user_id: string;
  sample_number: string;
  status: SampleOrderStatus;
  recipient: { name: string; phone: string; address: string; country: string };
  shipping_fee: string;
  shipping_currency: Currency;
  note: string | null;
  items: SampleOrderItem[];
  approval: {
    id: string;
    decision: 'approved' | 'rejected';
    reason: string | null;
    decided_by: string;
    created_at: string;
  } | null;
  shipment: {
    id: string;
    carrier: string;
    tracking_number: string;
    dispatched_by: string;
    dispatched_at: string;
    created_at: string;
  } | null;
  delivery: {
    id: string;
    shipment_id: string;
    received_by: string;
    delivered_at: string;
    confirmed_by: string;
    created_at: string;
  } | null;
  feedback: {
    id: string;
    feedback: string;
    confirmed_by: string;
    confirmed_at: string;
    created_at: string;
  } | null;
  conversion: {
    id: string;
    inquiry_id: string;
    proforma_invoice_id: string;
    sales_order_id: string;
    snapshot: Record<string, unknown>;
    converted_by: string;
    created_at: string;
  } | null;
  closure: {
    id: string;
    reason: string;
    closed_by: string;
    created_at: string;
  } | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSampleOrderInput {
  inquiry_id: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  recipient_country: string;
  shipping_fee: string;
  shipping_currency: Currency;
  note?: string;
  items: Array<{ selection_id: string; quantity: string }>;
}

export type AfterSalesCaseStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'completed'
  | 'closed'
  | 'unknown';

export interface AfterSalesApprovalStep {
  id: string;
  step_no: number;
  approver_user_id: string;
  decision: 'approved' | 'rejected' | null;
  decided_by: string | null;
  reason: string | null;
  decided_at: string | null;
  status: 'current' | 'waiting' | 'approved' | 'rejected';
}

export interface AfterSalesAdjustment {
  id: string;
  adjustment_type: 'refund' | 'compensation';
  amount: string;
  currency: Currency;
  fx_rate_to_rmb: string;
  fx_source: string;
  fx_captured_at: string;
  amount_rmb: string;
  external_reference: string;
  proof_file_id: string | null;
  executed_by: string;
  created_at: string;
}

export interface AfterSalesCase {
  id: string;
  sales_order_id: string;
  order_number: string;
  shipment_id: string | null;
  case_number: string;
  case_type: 'refund' | 'compensation';
  responsibility: 'supplier' | 'logistics' | 'company' | 'customer' | 'undetermined';
  reason: string;
  requested_amount: string;
  currency: Currency;
  proof_file_id: string | null;
  status: AfterSalesCaseStatus;
  status_diagnostic: {
    code: 'UNKNOWN_AFTER_SALES_STATUS';
    received_status: string;
    message: string;
  } | null;
  requested_by: string;
  approval_config: { id: string; version: number };
  current_approval_step: number | null;
  approval_steps: AfterSalesApprovalStep[];
  adjustment: AfterSalesAdjustment | null;
  completed_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AfterSalesApprovalConfig {
  id: string;
  version: number;
  created_at?: string;
  steps: Array<{
    id: string;
    step_no: number;
    approver_user_id: string;
    approver_name: string;
  }>;
}

export interface CreateAfterSalesCaseInput {
  shipment_id?: string;
  case_type: 'refund' | 'compensation';
  responsibility: 'supplier' | 'logistics' | 'company' | 'customer' | 'undetermined';
  reason: string;
  requested_amount: string;
  currency: Currency;
  proof_file_id?: string;
}

export interface ExecuteAfterSalesInput {
  amount: string;
  fx_rate_to_rmb: string;
  fx_source: string;
  fx_captured_at: string;
  external_reference: string;
  proof_file_id?: string;
}

export type TradeDocumentType = 'quote' | 'pi' | 'sc' | 'ci' | 'pl';
export type TradeDocumentLanguage = 'zh' | 'en' | 'ru' | 'es' | 'de' | 'ar';

export interface ProductRecord {
  id: string;
  owner_user_id: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  hs_code: string | null;
  default_currency: string;
  default_unit_price: string;
  cost_unit_price?: string | null;
  weight_kg: string | null;
  volume_cbm: string | null;
  thumbnail_file_id: string | null;
  custom_values: Record<string, unknown>;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  description?: string;
  unit: string;
  hs_code?: string;
  default_currency: string;
  default_unit_price: string;
  cost_unit_price?: string;
  weight_kg?: string;
  volume_cbm?: string;
  thumbnail_file_id?: string;
  custom_values?: Record<string, unknown>;
}

export interface ProductFieldRecord {
  id?: string;
  field_key: string;
  label: string;
  data_type: 'text' | 'number' | 'boolean' | 'date';
  active: boolean;
  sort_order: number;
  document_types: TradeDocumentType[];
  system: boolean;
  deletable: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ProductFieldsResponse {
  system: ProductFieldRecord[];
  custom: ProductFieldRecord[];
}

export interface TradeDocumentLineInput {
  id?: string;
  product_id?: string;
  sku: string;
  name: string;
  description?: string;
  quantity: string;
  unit: string;
  unit_price: string;
  cost_unit_price?: string;
  weight_kg?: string;
  volume_cbm?: string;
  package_no?: string;
  thumbnail_file_id?: string;
  custom_values?: Record<string, unknown>;
}

export interface TradeDocumentInput {
  customer_id?: string;
  sales_order_id?: string;
  quote_number: string;
  pricing_mode?: 'final_price' | 'cost_profit';
  language?: TradeDocumentLanguage;
  incoterm?: 'FOB' | 'CIF' | 'EXW';
  pricing_currency: string;
  settlement_currency: string;
  exchange_rate: string;
  discount_type?: 'none' | 'percent' | 'amount';
  discount_value?: string;
  freight_amount?: string;
  insurance_amount?: string;
  tax_amount?: string;
  internal_expenses?: string;
  allocation_method?: 'equal' | 'value' | 'weight' | 'volume';
  packing_mode?: 'normal' | 'combined';
  theme_color?: string;
  visible_fields?: Record<string, boolean>;
  terms?: string;
  bank_info?: string;
  logo_file_id?: string;
  signature_file_id?: string;
  lines: TradeDocumentLineInput[];
}

export type TradeDocumentLine = Omit<
  TradeDocumentLineInput,
  | 'description'
  | 'cost_unit_price'
  | 'weight_kg'
  | 'volume_cbm'
  | 'package_no'
  | 'thumbnail_file_id'
> & {
  id: string;
  line_no: number;
  description: string | null;
  line_total: string;
  allocated_charges: string;
  cost_unit_price?: string | null;
  cost_total?: string | null;
  weight_kg: string | null;
  volume_cbm: string | null;
  total_weight_kg: string | null;
  total_volume_cbm: string | null;
  package_no: string | null;
  thumbnail_file_id: string | null;
  custom_fields: Array<{
    field_key: string;
    label: string;
    value: unknown;
    document_types: TradeDocumentType[];
  }>;
};

export interface TradeDocumentSet {
  document_set_id: string;
  sales_order_id?: string | null;
  source_version: number;
  quote_number: string;
  pricing_mode?: 'final_price' | 'cost_profit';
  status: 'draft' | 'locked';
  language: TradeDocumentLanguage;
  incoterm: 'FOB' | 'CIF' | 'EXW';
  pricing_currency: string;
  settlement_currency: string;
  exchange_rate: string;
  discount_type: 'none' | 'percent' | 'amount';
  discount_value: string;
  allocation_method: 'equal' | 'value' | 'weight' | 'volume';
  packing_mode: 'normal' | 'combined';
  template_key: 'fixed_default';
  theme_color: string;
  visible_fields: Record<string, boolean>;
  terms: string | null;
  bank_info: string | null;
  logo_file_id: string | null;
  signature_file_id: string | null;
  customer: CustomerResponse | null;
  lines: TradeDocumentLine[];
  packages: Array<{
    package_no: string;
    line_nos: number[];
    total_weight_kg: string;
    total_volume_cbm: string;
  }>;
  totals: {
    subtotal: string;
    discount_amount: string;
    freight_amount: string;
    insurance_amount: string;
    tax_amount: string;
    grand_total: string;
    settlement_total: string;
    total_weight_kg: string;
    total_volume_cbm: string;
  };
  internal_expenses?: string;
  internal_totals?: {
    cost_total: string;
    internal_expenses: string;
    gross_profit: string;
    gross_margin_bps: number | null;
  };
  generated_at: string;
}

export interface TradeDocumentExport {
  id: string;
  document_set_id: string;
  source_version: number;
  export_version: number;
  document_type: TradeDocumentType;
  file_id: string;
  is_draft: boolean;
  created_by: string;
  created_at: string;
}

export interface TradeDocumentLink {
  id: string;
  export_id: string;
  document_type: TradeDocumentType;
  source_version: number;
  export_version: number;
  revoked_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  events: { opened: number; downloaded: number; confirmed: number };
}

export interface PublicTradeDocument {
  document_type: TradeDocumentType;
  document: TradeDocumentSet;
  confirmed_at: string | null;
  download_path: string;
}

// Normalized API error thrown by the client for non-2xx responses.
export class ApiError extends Error {
  status: number;
  // Field-level validation messages from the global ValidationPipe, when present.
  fields?: string[];
  code?: string;
  details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    fields?: string[],
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
    this.code = code;
    this.details = details;
  }
}
