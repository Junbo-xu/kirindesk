import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';

export interface PermissionCheckResult {
  allowed: boolean;
  dataScope: string;
}

const SCOPE_PRIORITY: Record<string, number> = { all: 4, assigned: 3, own: 2, none: 1 };

/** True if `requested` scope is within (no wider than) `held` scope. */
export function scopeWithin(requested: string, held: string): boolean {
  return (SCOPE_PRIORITY[requested] || 0) <= (SCOPE_PRIORITY[held] || 0);
}

@Injectable()
export class RbacService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  async checkPermission(
    userId: string,
    tenantId: string,
    permissionCode: string,
  ): Promise<PermissionCheckResult> {
    return withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<{ data_scope: string }>(
          `SELECT rp.data_scope
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.tenant_id = ur.tenant_id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE ur.user_id = $1 AND p.code = $2`,
          [userId, permissionCode],
        );

        if (rows.length === 0) return { allowed: false, dataScope: 'none' };

        const widest = rows.reduce(
          (best, r) =>
            (SCOPE_PRIORITY[r.data_scope] || 0) > (SCOPE_PRIORITY[best] || 0) ? r.data_scope : best,
          'none',
        );
        return { allowed: true, dataScope: widest };
      },
    );
  }

  /**
   * Returns the caller's full effective permission set as a map of
   * permission code → widest data_scope held (plan §4.1 guard 1, subset check).
   * Used to verify an admin never grants a permission/scope beyond their own.
   */
  async listEffectivePermissions(userId: string, tenantId: string): Promise<Map<string, string>> {
    return withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<{ code: string; data_scope: string }>(
          `SELECT p.code, rp.data_scope
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.tenant_id = ur.tenant_id
           JOIN permissions p ON p.id = rp.permission_id
           WHERE ur.user_id = $1`,
          [userId],
        );
        const held = new Map<string, string>();
        for (const r of rows) {
          const cur = held.get(r.code);
          if (!cur || (SCOPE_PRIORITY[r.data_scope] || 0) > (SCOPE_PRIORITY[cur] || 0)) {
            held.set(r.code, r.data_scope);
          }
        }
        return held;
      },
    );
  }
}
