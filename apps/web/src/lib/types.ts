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
