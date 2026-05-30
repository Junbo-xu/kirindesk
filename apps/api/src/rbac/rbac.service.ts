import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';

export interface PermissionCheckResult {
  allowed: boolean;
  dataScope: string;
}

const SCOPE_PRIORITY: Record<string, number> = { all: 4, assigned: 3, own: 2, none: 1 };

@Injectable()
export class RbacService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  async checkPermission(userId: string, tenantId: string, permissionCode: string): Promise<PermissionCheckResult> {
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
          (best, r) => ((SCOPE_PRIORITY[r.data_scope] || 0) > (SCOPE_PRIORITY[best] || 0) ? r.data_scope : best),
          'none',
        );
        return { allowed: true, dataScope: widest };
      },
    );
  }
}
