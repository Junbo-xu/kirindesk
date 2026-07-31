export interface InquiryItemRow {
  id: string;
  inquiry_id: string;
  line_no: number;
  description: string;
  specifications: string | null;
  quantity: string;
  unit: string;
  target_price_usd: string | null;
  created_at: Date;
}

export interface InquiryRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  customer_code: string;
  customer_country: string;
  customer_message: string;
  source_version: number;
  status: string;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface InquiryResponse {
  id: string;
  owner_user_id: string;
  customer_code: string;
  customer_country: string;
  customer_message: string;
  source_version: number;
  status: string;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  items: InquiryItemRow[];
}

export function toInquiryResponse(row: InquiryRow, items: InquiryItemRow[]): InquiryResponse {
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    customer_code: row.customer_code,
    customer_country: row.customer_country,
    customer_message: row.customer_message,
    source_version: row.source_version,
    status: row.status,
    submitted_at: row.submitted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: items.map((item) => ({
      id: item.id,
      inquiry_id: item.inquiry_id,
      line_no: item.line_no,
      description: item.description,
      specifications: item.specifications,
      quantity: item.quantity,
      unit: item.unit,
      target_price_usd: item.target_price_usd,
      created_at: item.created_at,
    })),
  };
}

export interface SanitizedItem {
  inquiry_item_id: string;
  description: string;
  specifications: string | null;
  quantity: string;
  unit: string;
}

export interface SanitizedPayload {
  items: SanitizedItem[];
}

export interface QuoteTaskRow {
  id: string;
  inquiry_id: string;
  customer_country: string;
  sanitization_status: string;
  sanitized_summary: string | null;
  sanitized_payload: SanitizedPayload | null;
  provider_name: string | null;
  provider_invocation_id: string | null;
  last_error_code: string | null;
  attempt_count: number;
  corrected_at: Date | null;
  last_attempted_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface QuoteTaskResponse {
  id: string;
  inquiry_id: string;
  customer_country: string;
  sanitization_status: string;
  sanitized_summary: string | null;
  items: SanitizedItem[];
  provider_name: string | null;
  provider_invocation_id: string | null;
  last_error_code: string | null;
  attempt_count: number;
  corrected_at: Date | null;
  last_attempted_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toQuoteTaskResponse(row: QuoteTaskRow): QuoteTaskResponse {
  return {
    id: row.id,
    inquiry_id: row.inquiry_id,
    customer_country: row.customer_country,
    sanitization_status: row.sanitization_status,
    sanitized_summary: row.sanitized_summary,
    items: row.sanitized_payload?.items ?? [],
    provider_name: row.provider_name,
    provider_invocation_id: row.provider_invocation_id,
    last_error_code: row.last_error_code,
    attempt_count: row.attempt_count,
    corrected_at: row.corrected_at,
    last_attempted_at: row.last_attempted_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface QuotationLineRow {
  id: string;
  inquiry_id: string;
  quotation_id: string;
  inquiry_item_id: string;
  variant_key: string;
  variant_value: string;
  quantity: string;
  unit_price: string;
  minimum_quantity: string | null;
  lead_time_days: number | null;
  terms: string | null;
  created_at: Date;
}

export interface QuotationRow {
  id: string;
  inquiry_id: string;
  supplier_id: string;
  entered_by: string;
  version: number;
  currency: string;
  valid_until: string;
  source_text: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProcurementQuotationResponse extends QuotationRow {
  lines: QuotationLineRow[];
}

export interface SalesQuotationResponse {
  id: string;
  inquiry_id: string;
  version: number;
  currency: string;
  valid_until: string;
  updated_at: Date;
  lines: Array<{
    id: string;
    inquiry_item_id: string;
    variant_key: string;
    variant_value: string;
    quantity: string;
    unit_price: string;
    minimum_quantity: string | null;
    lead_time_days: number | null;
  }>;
}

export function toProcurementQuotationResponse(
  row: QuotationRow,
  lines: QuotationLineRow[],
): ProcurementQuotationResponse {
  return { ...row, lines };
}

export function toSalesQuotationResponse(
  row: QuotationRow,
  lines: QuotationLineRow[],
): SalesQuotationResponse {
  return {
    id: row.id,
    inquiry_id: row.inquiry_id,
    version: row.version,
    currency: row.currency,
    valid_until: row.valid_until,
    updated_at: row.updated_at,
    lines: lines.map((line) => ({
      id: line.id,
      inquiry_item_id: line.inquiry_item_id,
      variant_key: line.variant_key,
      variant_value: line.variant_value,
      quantity: line.quantity,
      unit_price: line.unit_price,
      minimum_quantity: line.minimum_quantity,
      lead_time_days: line.lead_time_days,
    })),
  };
}
