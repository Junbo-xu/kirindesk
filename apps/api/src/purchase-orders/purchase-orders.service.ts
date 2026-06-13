import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { withTenantContext } from '../database/context';
import { APP_POOL } from '../database/database.module';
import { AuditService } from '../audit/audit.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ListPurchaseOrdersQuery } from './dto/list-purchase-orders.query';
import {
  OrderItemInputDto,
  OrderItemRow,
  OrderItemResponse,
  toOrderItemResponse,
} from '../sales-orders/dto/order-item.dto';
import {
  PurchaseOrderNotFoundException,
  OrderSupplierNotFoundException,
  DuplicateOrderNumberException,
  OrderRequiresLineItemException,
} from './purchase-orders.errors';
import {
  PurchaseOrderRow,
  PurchaseOrderResponse,
  toPurchaseOrderResponse,
} from './purchase-orders.response';
import { computeLineTotal, sumMoney } from '../common/order-money';

export interface RequestActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface ListResult {
  data: PurchaseOrderResponse[];
  page: number;
  pageSize: number;
  total: number;
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly auditService: AuditService,
  ) {}

  // own and assigned both restrict to the caller's owned rows. assigned has no
  // dedicated column in MVP, so it is treated as own (defensive narrowing).
  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  // Confirms the supplier exists, is not deleted, belongs to this tenant (RLS)
  // and is within the caller's scope. Throws 404 otherwise so existence is not
  // disclosed. Runs inside the create transaction's client.
  private async assertSupplierInScope(
    client: PoolClient,
    actor: RequestActor,
    supplierId: string,
  ): Promise<void> {
    const params: unknown[] = [supplierId];
    let scopeClause = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scopeClause = ' AND owner_user_id = $2';
    }
    const { rows } = await client.query(
      `SELECT 1 FROM suppliers WHERE id = $1 AND deleted_at IS NULL${scopeClause}`,
      params,
    );
    if (rows.length === 0) {
      throw new OrderSupplierNotFoundException();
    }
  }

  // Inserts the given line items for an order in array order, assigning line_no
  // 1..N and computing line_total per row. Returns the persisted rows (in order)
  // so the caller can derive total_amount and build the response/audit snapshot.
  // Runs inside the caller's transaction client (tenant context already set).
  private async insertItems(
    client: PoolClient,
    actor: RequestActor,
    orderId: string,
    items: OrderItemInputDto[],
  ): Promise<OrderItemRow[]> {
    const rows: OrderItemRow[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const lineNo = i + 1;
      const lineTotal = computeLineTotal(item.quantity, item.unit_price);
      const { rows: inserted } = await client.query<OrderItemRow>(
        `INSERT INTO purchase_order_items
           (tenant_id, order_id, line_no, description, product_code, unit,
            quantity, unit_price, line_total, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          actor.tenantId,
          orderId,
          lineNo,
          item.description,
          item.product_code ?? null,
          item.unit ?? null,
          item.quantity,
          item.unit_price,
          lineTotal,
          item.notes ?? null,
        ],
      );
      rows.push(inserted[0]);
    }
    return rows;
  }

  // Fetches the live (non-soft-deleted) line items for an order, ordered by
  // line_no. Used for the audit before-snapshot and the items-absent update
  // case, and for getOne.
  private async fetchItems(client: PoolClient, orderId: string): Promise<OrderItemRow[]> {
    const { rows } = await client.query<OrderItemRow>(
      `SELECT * FROM purchase_order_items
       WHERE order_id = $1 AND deleted_at IS NULL
       ORDER BY line_no ASC`,
      [orderId],
    );
    return rows;
  }

  async create(actor: RequestActor, dto: CreatePurchaseOrderDto): Promise<PurchaseOrderResponse> {
    const items = dto.items ?? [];
    const status = dto.status ?? 'draft';

    // Phase 1F-A §6/§7: non-draft orders must carry at least one line. Draft
    // orders may be saved with zero lines (work in progress).
    if (status !== 'draft' && items.length === 0) {
      throw new OrderRequiresLineItemException();
    }

    // total_amount is derived server-side from the line items; any client-sent
    // value is ignored (the DTO no longer accepts it). An order with no items
    // (draft, or a historical-style header-only order) totals 0.00.
    let row: PurchaseOrderRow;
    let itemRows: OrderItemRow[];
    try {
      const result = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          await this.assertSupplierInScope(client, actor, dto.supplier_id);
          const { rows } = await client.query<PurchaseOrderRow>(
            `INSERT INTO purchase_orders
               (tenant_id, supplier_id, owner_user_id, order_number, pi_number, pi_file_id,
                currency, total_amount, status, notes)
             VALUES ($1, $2, $3, $4, $5, NULL, $6, 0, COALESCE($7, 'draft'), $8)
             RETURNING *`,
            [
              actor.tenantId,
              dto.supplier_id,
              actor.userId,
              dto.order_number,
              dto.pi_number ?? null,
              dto.currency,
              dto.status ?? null,
              dto.notes ?? null,
            ],
          );
          const header = rows[0];

          const insertedItems = await this.insertItems(client, actor, header.id, items);
          const total = sumMoney(insertedItems.map((r) => r.line_total));

          // Write the derived total back onto the header within the same tx.
          const { rows: updated } = await client.query<PurchaseOrderRow>(
            `UPDATE purchase_orders SET total_amount = $1 WHERE id = $2 RETURNING *`,
            [total, header.id],
          );
          return { header: updated[0], items: insertedItems };
        },
      );
      row = result.header;
      itemRows = result.items;
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateOrderNumberException();
      }
      throw err;
    }

    const itemResponses: OrderItemResponse[] = itemRows.map(toOrderItemResponse);
    const response = { ...toPurchaseOrderResponse(row), items: itemResponses };

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'purchase_order.created',
      resourceId: row.id,
      after: response,
    });

    return response;
  }

  async list(actor: RequestActor, query: ListPurchaseOrdersQuery): Promise<ListResult> {
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
    if (query.supplier_id) {
      params.push(query.supplier_id);
      conditions.push(`supplier_id = $${params.length}`);
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
          `SELECT COUNT(*)::text AS count FROM purchase_orders ${where}`,
          params,
        );
        const dataRes = await client.query<PurchaseOrderRow>(
          `SELECT * FROM purchase_orders ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, offset],
        );
        return {
          data: dataRes.rows.map(toPurchaseOrderResponse),
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
  ): Promise<PurchaseOrderRow> {
    const params: unknown[] = [id];
    let scopeClause = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scopeClause = ' AND owner_user_id = $2';
    }
    const { rows } = await client.query<PurchaseOrderRow>(
      `SELECT * FROM purchase_orders WHERE id = $1 AND deleted_at IS NULL${scopeClause}`,
      params,
    );
    if (rows.length === 0) {
      throw new PurchaseOrderNotFoundException();
    }
    return rows[0];
  }

  async getOne(actor: RequestActor, id: string): Promise<PurchaseOrderResponse> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.fetchInScope(client, actor, id);
        const items = await this.fetchItems(client, row.id);
        return { ...toPurchaseOrderResponse(row), items: items.map(toOrderItemResponse) };
      },
    );
  }

  async update(
    actor: RequestActor,
    id: string,
    dto: UpdatePurchaseOrderDto,
  ): Promise<PurchaseOrderResponse> {
    const { before, beforeItems, after, afterItems } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, actor, id);
        const existingItems = await this.fetchItems(client, existing.id);

        // Determine the resulting status to enforce the line-item rule against
        // the post-update state, and the resulting item set.
        const resultingStatus = dto.status ?? existing.status;
        const replacingItems = dto.items !== undefined;
        const resultingItemCount = replacingItems ? dto.items!.length : existingItems.length;

        // Phase 1F-A §6: a non-draft order must end up with at least one line.
        if (resultingStatus !== 'draft' && resultingItemCount === 0) {
          throw new OrderRequiresLineItemException();
        }

        // Header column whitelist. total_amount is NOT here — it is derived from
        // line items, never set directly. supplier_id/order_number/pi_file_id
        // remain immutable in this phase.
        const allowed = ['pi_number', 'currency', 'status', 'notes'] as const;
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const col of allowed) {
          if (dto[col] !== undefined) {
            params.push(dto[col]);
            sets.push(`${col} = $${params.length}`);
          }
        }

        // Resolve the resulting item rows. When items are provided, replace the
        // whole set (full-array semantics): soft-delete all current live lines,
        // then insert the new set with freshly assigned line_no 1..N. When items
        // are absent, the existing lines stand unchanged.
        let resultingItems: OrderItemRow[];
        if (replacingItems) {
          await client.query(
            `UPDATE purchase_order_items SET deleted_at = now(), updated_at = now()
             WHERE order_id = $1 AND deleted_at IS NULL`,
            [existing.id],
          );
          resultingItems = await this.insertItems(client, actor, existing.id, dto.items!);
        } else {
          resultingItems = existingItems;
        }

        // Always re-derive total_amount from the resulting live items so the
        // header stays consistent.
        const total = sumMoney(resultingItems.map((r) => r.line_total));
        params.push(total);
        sets.push(`total_amount = $${params.length}`);

        sets.push('updated_at = now()');
        params.push(existing.id);

        const { rows } = await client.query<PurchaseOrderRow>(
          `UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = $${params.length} AND deleted_at IS NULL RETURNING *`,
          params,
        );
        return {
          before: existing,
          beforeItems: existingItems,
          after: rows[0],
          afterItems: resultingItems,
        };
      },
    );

    const beforeResponse = {
      ...toPurchaseOrderResponse(before),
      items: beforeItems.map(toOrderItemResponse),
    };
    const afterResponse = {
      ...toPurchaseOrderResponse(after),
      items: afterItems.map(toOrderItemResponse),
    };

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'purchase_order.updated',
      resourceId: id,
      before: beforeResponse,
      after: afterResponse,
    });

    return afterResponse;
  }

  async remove(actor: RequestActor, id: string): Promise<void> {
    const { before, after } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const existing = await this.fetchInScope(client, actor, id);
        // Soft delete: set deleted_at, bump updated_at, leave status unchanged.
        const { rows } = await client.query<PurchaseOrderRow>(
          `UPDATE purchase_orders SET deleted_at = now(), updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
          [id],
        );
        return { before: existing, after: rows[0] };
      },
    );

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'purchase_order.deleted',
      resourceId: id,
      before: toPurchaseOrderResponse(before),
      after: { ...toPurchaseOrderResponse(after), deleted: true },
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
        resourceType: 'purchase_order',
        resourceId: params.resourceId,
        before: params.before,
        after: params.after,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} purchase_order=${params.resourceId}: ${String(err)}`,
      );
    }
  }
}
