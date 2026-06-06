import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';
import { ListSalesOrdersQuery } from './dto/list-sales-orders.query';
import {
  SalesOrderNotFoundException,
  OrderCustomerNotFoundException,
  DuplicateOrderNumberException,
} from './sales-orders.errors';
import { SalesOrderRow, SalesOrderResponse, toSalesOrderResponse } from './sales-orders.response';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface ListResult {
  data: SalesOrderResponse[];
  page: number;
  pageSize: number;
  total: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class SalesOrdersService {
  private readonly logger = new Logger(SalesOrdersService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
  ) {}

  // own and assigned both restrict to the caller's owned rows. assigned has no
  // dedicated column in MVP, so it is treated as own (defensive narrowing).
  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  // Confirms the customer exists, is not deleted, belongs to this tenant (RLS)
  // and is within the caller's scope. Throws 404 otherwise so existence is not
  // disclosed. Runs inside the create transaction's client.
  private async assertCustomerInScope(
    client: PoolClient,
    actor: RequestActor,
    customerId: string,
  ): Promise<void> {
    const params: unknown[] = [customerId];
    let scopeClause = '';
    if (this.restrictsToOwner(actor.dataScope)) {
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

  async create(actor: RequestActor, dto: CreateSalesOrderDto): Promise<SalesOrderResponse> {
    let row: SalesOrderRow;
    try {
      row = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          await this.assertCustomerInScope(client, actor, dto.customer_id);
          const { rows } = await client.query<SalesOrderRow>(
            `INSERT INTO sales_orders
               (tenant_id, customer_id, owner_user_id, order_number, pi_number, pi_file_id,
                currency, total_amount, status, notes)
             VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, COALESCE($8, 'draft'), $9)
             RETURNING *`,
            [
              actor.tenantId,
              dto.customer_id,
              actor.userId,
              dto.order_number,
              dto.pi_number ?? null,
              dto.currency,
              dto.total_amount,
              dto.status ?? null,
              dto.notes ?? null,
            ],
          );
          return rows[0];
        },
      );
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateOrderNumberException();
      }
      throw err;
    }

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'sales_order.created',
      resourceId: row.id,
      after: toSalesOrderResponse(row),
    });

    return toSalesOrderResponse(row);
  }

  async list(actor: RequestActor, query: ListSalesOrdersQuery): Promise<ListResult> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const conditions: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];

    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      conditions.push(`owner_user_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`status = $${params.length}`);
    }
    if (query.customer_id) {
      params.push(query.customer_id);
      conditions.push(`customer_id = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      const p = `$${params.length}`;
      conditions.push(`(order_number ILIKE ${p} OR pi_number ILIKE ${p})`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const totalRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM sales_orders ${where}`,
          params,
        );
        const dataRes = await client.query<SalesOrderRow>(
          `SELECT * FROM sales_orders ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
        return {
          data: dataRes.rows.map(toSalesOrderResponse),
          page,
          pageSize,
          total: parseInt(totalRes.rows[0].count, 10),
        };
      },
    );
  }

  // Fetches a non-deleted order by id within the caller's scope, using the
  // provided client (inside an existing tenant-context transaction). Throws 404
  // if not found, deleted, or out of scope. RLS already enforces tenant_id.
  private async fetchInScope(
    client: PoolClient,
    actor: RequestActor,
    id: string,
  ): Promise<SalesOrderRow> {
    const params: unknown[] = [id];
    let scopeClause = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scopeClause = ' AND owner_user_id = $2';
    }
    const { rows } = await client.query<SalesOrderRow>(
      `SELECT * FROM sales_orders WHERE id = $1 AND deleted_at IS NULL${scopeClause}`,
      params,
    );
    if (rows.length === 0) {
      throw new SalesOrderNotFoundException();
    }
    return rows[0];
  }

  async getOne(actor: RequestActor, id: string): Promise<SalesOrderResponse> {
    const row = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      (client) => this.fetchInScope(client, actor, id),
    );
    return toSalesOrderResponse(row);
  }

  async update(
    actor: RequestActor,
    id: string,
    dto: UpdateSalesOrderDto,
  ): Promise<SalesOrderResponse> {
    const { before, after } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, actor, id);

        // Whitelist of updatable columns; values are bound as parameters.
        // customer_id, order_number and pi_file_id are immutable in this phase.
        const allowed = ['pi_number', 'currency', 'total_amount', 'status', 'notes'] as const;
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const col of allowed) {
          if (dto[col] !== undefined) {
            params.push(dto[col]);
            sets.push(`${col} = $${params.length}`);
          }
        }
        sets.push('updated_at = now()');
        params.push(id);

        const { rows } = await client.query<SalesOrderRow>(
          `UPDATE sales_orders SET ${sets.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`,
          params,
        );
        return { before: existing, after: rows[0] };
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'sales_order.updated',
      resourceId: id,
      before: toSalesOrderResponse(before),
      after: toSalesOrderResponse(after),
    });

    return toSalesOrderResponse(after);
  }

  async remove(actor: RequestActor, id: string): Promise<void> {
    const { before, after } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, actor, id);
        // Soft delete: set deleted_at, bump updated_at, leave status unchanged.
        const { rows } = await client.query<SalesOrderRow>(
          `UPDATE sales_orders SET deleted_at = now(), updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
          [id],
        );
        return { before: existing, after: rows[0] };
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'sales_order.deleted',
      resourceId: id,
      before: toSalesOrderResponse(before),
      after: { ...toSalesOrderResponse(after), deleted: true },
    });
  }

  // Audit is recorded after the business transaction commits (separate
  // transaction). A failure here must NOT undo the committed business change;
  // we log it so the gap is visible. Append-only chain is enforced in the DB.
  private async safeAudit(params: {
    tenantId: string;
    actorId: string;
    action: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
  }): Promise<void> {
    try {
      await this.auditService.log({
        tenantId: params.tenantId,
        actorType: 'tenant_user',
        actorId: params.actorId,
        action: params.action,
        resourceType: 'sales_order',
        resourceId: params.resourceId,
        before: params.before,
        after: params.after,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} sales_order=${params.resourceId}: ${String(err)}`,
      );
    }
  }
}
