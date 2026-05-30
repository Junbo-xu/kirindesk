import { Injectable, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';

export interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  name: string;
  status: string;
  is_tenant_owner: boolean;
  deleted_at: string | null;
}

@Injectable()
export class UsersService {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  async findByEmailForAuth(tenantId: string, email: string): Promise<UserRow | null> {
    const result = await withTenantContext(
      this.pool,
      { tenantId, userId: null, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query<UserRow>(
          `SELECT id, tenant_id, email, password_hash, name, status, is_tenant_owner, deleted_at
           FROM users WHERE email = $1 AND deleted_at IS NULL`,
          [email],
        );
        return rows[0] ?? null;
      },
    );
    return result;
  }

  async findById(tenantId: string, userId: string): Promise<Omit<UserRow, 'password_hash'> | null> {
    const result = await withTenantContext(
      this.pool,
      { tenantId, userId, actorType: 'tenant_user' },
      async (client) => {
        const { rows } = await client.query(
          `SELECT id, tenant_id, email, name, status, is_tenant_owner, deleted_at
           FROM users WHERE id = $1 AND deleted_at IS NULL`,
          [userId],
        );
        return rows[0] ?? null;
      },
    );
    return result;
  }
}
