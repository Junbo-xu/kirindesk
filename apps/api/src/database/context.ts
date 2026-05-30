import type { Pool, PoolClient } from 'pg';

export type ActorType = 'tenant_user' | 'platform_admin' | 'system';

export interface TenantContext {
  tenantId: string | null;
  userId: string | null;
  actorType: ActorType;
}

export async function withTenantContext<T>(
  pool: Pool,
  ctx: TenantContext,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId ?? '']);
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [ctx.userId ?? '']);
    await client.query(`SELECT set_config('app.current_actor_type', $1, true)`, [ctx.actorType]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
