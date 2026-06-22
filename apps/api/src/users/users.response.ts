/**
 * Response shaping for user management (plan §3, §4.1 guard: never leak
 * password_hash). The API contract exposes only these fields. Role assignments
 * are attached as a separate roles[] array on the detail shape.
 */

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  phone: string | null;
  status: string;
  is_tenant_owner: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface UserRoleBrief {
  id: string;
  name: string;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  status: string;
  isTenantOwner: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface UserDetail extends UserSummary {
  roles: UserRoleBrief[];
}

export function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    status: row.status,
    isTenantOwner: row.is_tenant_owner,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export function toUserDetail(row: UserRow, roles: UserRoleBrief[]): UserDetail {
  return { ...toUserSummary(row), roles };
}
