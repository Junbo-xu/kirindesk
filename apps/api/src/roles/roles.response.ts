/**
 * Response shaping for role management (plan §3.2/§3.3). The detail shape
 * attaches the role's permission grants (permission id + code + data_scope) so
 * the web permission matrix can render current selections. The permission
 * catalog (§3.3) is a read-only dictionary grouped by module.
 */

export interface RoleRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RoleCountsRow extends RoleRow {
  permission_count: number;
  user_count: number;
}

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
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleDetail extends RoleSummary {
  permissions: PermissionGrant[];
}

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

export function toRoleSummary(row: RoleCountsRow): RoleSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    permissionCount: Number(row.permission_count),
    userCount: Number(row.user_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toRoleDetail(row: RoleCountsRow, permissions: PermissionGrant[]): RoleDetail {
  return { ...toRoleSummary(row), permissions };
}
