import type { OrderItemResponse } from './dto/order-item.dto';

export interface SalesOrderRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  owner_user_id: string;
  order_number: string;
  pi_number: string | null;
  pi_file_id: string | null;
  inquiry_id: string | null;
  source_pi_id: string | null;
  source_document_set_id: string | null;
  source_quote_number: string | null;
  source_quote_version: number | null;
  source_quote_snapshot: Record<string, unknown> | null;
  source_quote_idempotency_key: string | null;
  source_quote_converted_by: string | null;
  source_quote_converted_at: Date | null;
  fulfillment_locked_snapshot: Record<string, unknown> | null;
  fulfillment_locked_by: string | null;
  fulfillment_locked_at: Date | null;
  currency: string;
  // pg returns numeric as a string; kept as string end-to-end to avoid
  // floating-point precision loss on money values.
  total_amount: string;
  status: string;
  notes: string | null;
  // Phase 1F-B FX snapshot. NULL until a rate is frozen (drafts, header-only
  // historical orders, or cross-currency orders never re-saved). numeric columns
  // come back as strings.
  fx_rate: string | null;
  fx_rate_source: string | null;
  fx_captured_at: Date | null;
  total_amount_base: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface SalesOrderResponse {
  id: string;
  customer_id: string;
  owner_user_id: string;
  order_number: string;
  pi_number: string | null;
  inquiry_id: string | null;
  source_pi_id: string | null;
  source_document_set_id: string | null;
  source_quote_number: string | null;
  source_quote_version: number | null;
  fulfillment_locked_by: string | null;
  fulfillment_locked_at: Date | null;
  currency: string;
  total_amount: string;
  status: string;
  // Phase 1F-B FX snapshot (original currency -> tenant base currency).
  fx_rate: string | null;
  fx_rate_source: string | null;
  fx_captured_at: Date | null;
  total_amount_base: string | null;
  created_at: Date;
  updated_at: Date;
  // Present on single-order responses (create/getOne/update); omitted from list
  // rows to keep the list payload lightweight.
  items?: OrderItemResponse[];
}

/**
 * Maps a DB row to the public response shape. Explicit allowlist: tenant_id,
 * deleted_at, notes and pi_file_id are never exposed (pi_file_id is not
 * supported in this phase).
 */
export function toSalesOrderResponse(row: SalesOrderRow): SalesOrderResponse {
  return {
    id: row.id,
    customer_id: row.customer_id,
    owner_user_id: row.owner_user_id,
    order_number: row.order_number,
    pi_number: row.pi_number,
    inquiry_id: row.inquiry_id,
    source_pi_id: row.source_pi_id,
    source_document_set_id: row.source_document_set_id,
    source_quote_number: row.source_quote_number,
    source_quote_version: row.source_quote_version,
    fulfillment_locked_by: row.fulfillment_locked_by,
    fulfillment_locked_at: row.fulfillment_locked_at,
    currency: row.currency,
    total_amount: row.total_amount,
    status: row.status,
    fx_rate: row.fx_rate,
    fx_rate_source: row.fx_rate_source,
    fx_captured_at: row.fx_captured_at,
    total_amount_base: row.total_amount_base,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
