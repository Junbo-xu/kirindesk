export interface CustomerRow {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  company_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  source: string | null;
  status: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CustomerResponse {
  id: string;
  company_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  source: string | null;
  status: string;
  owner_user_id: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Maps a DB row to the public response shape. Explicit allowlist: tenant_id,
 * deleted_at and any future internal columns are never exposed.
 */
export function toCustomerResponse(row: CustomerRow): CustomerResponse {
  return {
    id: row.id,
    company_name: row.company_name,
    contact_name: row.contact_name,
    email: row.email,
    phone: row.phone,
    country: row.country,
    source: row.source,
    status: row.status,
    owner_user_id: row.owner_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
