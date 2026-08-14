import type { PoolClient } from 'pg';
import { OrderCustomerNotFoundException } from './sales-orders.errors';

interface CustomerScopeActor {
  userId: string;
  dataScope: string;
}

export async function assertSalesOrderCustomerInScope(
  client: PoolClient,
  actor: CustomerScopeActor,
  customerId: string,
): Promise<void> {
  const params: unknown[] = [customerId];
  let scopeClause = '';
  if (actor.dataScope === 'own' || actor.dataScope === 'assigned') {
    params.push(actor.userId);
    scopeClause = ' AND owner_user_id = $2';
  }
  const { rows } = await client.query(
    `SELECT 1 FROM customers WHERE id = $1 AND deleted_at IS NULL${scopeClause}`,
    params,
  );
  if (rows.length === 0) {
    throw new OrderCustomerNotFoundException();
  }
}
