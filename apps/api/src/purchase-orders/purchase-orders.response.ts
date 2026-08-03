import type { OrderItemResponse } from '../sales-orders/dto/order-item.dto';

export interface PurchaseOrderRow {
  id: string;
  tenant_id: string;
  supplier_id: string;
  owner_user_id: string;
  order_number: string;
  pi_number: string | null;
  pi_file_id: string | null;
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
  source_procurement_request_id: string | null;
  expected_total_amount: string | null;
  final_total_amount: string | null;
  placed_by: string | null;
  placed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface PurchaseOrderResponse {
  id: string;
  supplier_id?: string;
  owner_user_id: string;
  order_number: string;
  pi_number: string | null;
  currency: string;
  total_amount: string;
  status: string;
  // Phase 1F-B FX snapshot (original currency -> tenant base currency).
  fx_rate: string | null;
  fx_rate_source: string | null;
  fx_captured_at: Date | null;
  total_amount_base: string | null;
  source_procurement_request_id: string | null;
  expected_total_amount: string | null;
  final_total_amount: string | null;
  placed_at: Date | null;
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
export function toPurchaseOrderResponse(
  row: PurchaseOrderRow,
  includeSupplierIdentity = true,
): PurchaseOrderResponse {
  return {
    id: row.id,
    ...(includeSupplierIdentity ? { supplier_id: row.supplier_id } : {}),
    owner_user_id: row.owner_user_id,
    order_number: row.order_number,
    pi_number: row.pi_number,
    currency: row.currency,
    total_amount: row.total_amount,
    status: row.status,
    fx_rate: row.fx_rate,
    fx_rate_source: row.fx_rate_source,
    fx_captured_at: row.fx_captured_at,
    total_amount_base: row.total_amount_base,
    source_procurement_request_id: row.source_procurement_request_id,
    expected_total_amount: row.expected_total_amount,
    final_total_amount: row.final_total_amount,
    placed_at: row.placed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
