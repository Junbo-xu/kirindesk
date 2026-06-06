export interface SalesOrderRow {
  id: string;
  tenant_id: string;
  customer_id: string;
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
  currency: string;
  total_amount: string;
  status: string;
  created_at: Date;
  updated_at: Date;
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
    currency: row.currency,
    total_amount: row.total_amount,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
