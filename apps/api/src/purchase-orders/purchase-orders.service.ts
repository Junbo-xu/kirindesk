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
import { computeLineTotal, sumMoney, multiplyMoneyByRate } from '../common/order-money';
import {
  ApprovalAction,
  assertTransition,
  ApprovalScopeException,
  SelfApprovalException,
} from '../common/order-approval';

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

// Resolved FX snapshot to freeze on an order. rate is a numeric(18,8) string.
interface FxSnapshot {
  rate: string;
  source: string; // 'manual' | 'mock' | 'system'
}

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const UNIQUE_VIOLATION = '23505';
// Tenant base currency falls back to RMB when no KV setting row exists.
const DEFAULT_BASE_CURRENCY = 'RMB';

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

  // Reads the tenant's base (reporting) currency from the existing key-value
  // tenant_settings table (key='base_currency', value_json a JSON scalar string
  // e.g. "RMB"). Falls back to RMB when no row exists. Runs inside the caller's
  // tenant-context transaction so RLS scopes it to this tenant.
  private async getBaseCurrency(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ base_currency: string | null }>(
      `SELECT value_json #>> '{}' AS base_currency
         FROM tenant_settings
        WHERE key = 'base_currency'
        LIMIT 1`,
    );
    return rows[0]?.base_currency ?? DEFAULT_BASE_CURRENCY;
  }

  // Resolves the FX snapshot (rate + source) to freeze on an order, given the
  // order's original currency. Resolution order:
  //   1. original currency == base currency  -> rate 1, source 'system'.
  //   2. a manual rate supplied on the DTO    -> that rate, source 'manual'.
  //   3. otherwise look up exchange_rates for (base, quote=currency) for the
  //      latest month -> that rate, source 'mock'.
  // Returns null when no rate can be determined (cross-currency, no manual rate,
  // no exchange_rates row): the order is saved with a NULL FX snapshot, matching
  // the nullable columns and the migration's "do not invent rates" stance.
  private async resolveFx(
    client: PoolClient,
    currency: string,
    manualRate: string | undefined,
  ): Promise<FxSnapshot | null> {
    const baseCurrency = await this.getBaseCurrency(client);

    // Same currency: conversion is the identity, regardless of any supplied rate.
    if (currency === baseCurrency) {
      return { rate: '1', source: 'system' };
    }

    // Manual override wins over a looked-up rate.
    if (manualRate !== undefined) {
      return { rate: manualRate, source: 'manual' };
    }

    // Look up the most recent stored rate for this currency pair. exchange_rates
    // is keyed (tenant, base_currency, quote_currency, year_month); take the
    // latest by year_month. RLS scopes the read to this tenant.
    const { rows } = await client.query<{ rate: string }>(
      `SELECT rate FROM exchange_rates
        WHERE base_currency = $1 AND quote_currency = $2
        ORDER BY year_month DESC
        LIMIT 1`,
      [baseCurrency, currency],
    );
    if (rows.length > 0) {
      return { rate: rows[0].rate, source: 'mock' };
    }

    return null;
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

          // Freeze the FX snapshot for this order's original currency and derive
          // the base-currency total from the frozen rate. When no rate can be
          // resolved, all four FX columns stay NULL.
          const fx = await this.resolveFx(client, dto.currency, dto.fx_rate);
          const totalBase = fx ? multiplyMoneyByRate(total, fx.rate) : null;

          // Write the derived total + FX snapshot back onto the header in the tx.
          const { rows: updated } = await client.query<PurchaseOrderRow>(
            `UPDATE purchase_orders
                SET total_amount = $1,
                    fx_rate = $2,
                    fx_rate_source = $3,
                    fx_captured_at = CASE WHEN $2::numeric IS NULL THEN NULL ELSE now() END,
                    total_amount_base = $4
              WHERE id = $5
              RETURNING *`,
            [total, fx?.rate ?? null, fx?.source ?? null, totalBase, header.id],
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

        // Re-freeze the FX snapshot against the resulting currency (which may
        // have changed) and re-derive total_amount_base from the resolved rate.
        // A supplied dto.fx_rate is treated as a manual override; otherwise the
        // rate is re-resolved (same-currency=1, else exchange_rates lookup).
        const resultingCurrency = dto.currency ?? existing.currency;
        const fx = await this.resolveFx(client, resultingCurrency, dto.fx_rate);
        const totalBase = fx ? multiplyMoneyByRate(total, fx.rate) : null;
        params.push(fx?.rate ?? null);
        sets.push(`fx_rate = $${params.length}`);
        params.push(fx?.source ?? null);
        sets.push(`fx_rate_source = $${params.length}`);
        params.push(totalBase);
        sets.push(`total_amount_base = $${params.length}`);
        // captured_at tracks whether a rate is frozen: set when a rate exists,
        // cleared when the snapshot resolves to NULL.
        sets.push(`fx_captured_at = CASE WHEN ${fx ? 'TRUE' : 'FALSE'} THEN now() ELSE NULL END`);

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
  // ---- Phase 1F-C: approval workflow transitions -------------------------
  // submit / approve / reject / withdraw. Each runs in one tenant-context
  // transaction: SELECT ... FOR UPDATE the order, validate the legal transition
  // (409 if illegal), enforce approval guards, UPDATE status, INSERT an
  // immutable order_approvals ledger row, then audit after commit.

  async submit(actor: RequestActor, id: string): Promise<PurchaseOrderResponse> {
    return this.transition(actor, id, 'submit');
  }

  async approve(actor: RequestActor, id: string, reason?: string): Promise<PurchaseOrderResponse> {
    return this.transition(actor, id, 'approve', reason);
  }

  async reject(actor: RequestActor, id: string, reason: string): Promise<PurchaseOrderResponse> {
    return this.transition(actor, id, 'reject', reason);
  }

  async withdraw(actor: RequestActor, id: string, reason?: string): Promise<PurchaseOrderResponse> {
    return this.transition(actor, id, 'withdraw', reason);
  }

  // Looks up the actor_user_id of the most recent 'submit' ledger row for this
  // order (the submitter), used to enforce separation of duties on approve/
  // reject. Returns null if no submit row is found (defensive — should not
  // happen for a pending_approval order).
  private async findSubmitter(client: PoolClient, orderId: string): Promise<string | null> {
    const { rows } = await client.query<{ actor_user_id: string }>(
      `SELECT actor_user_id FROM order_approvals
        WHERE order_type = 'purchase' AND order_id = $1 AND action = 'submit'
        ORDER BY level DESC, created_at DESC
        LIMIT 1`,
      [orderId],
    );
    return rows[0]?.actor_user_id ?? null;
  }

  private async transition(
    actor: RequestActor,
    id: string,
    action: ApprovalAction,
    reason?: string,
  ): Promise<PurchaseOrderResponse> {
    const { before, after } = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        // Lock the order row for the duration of the transaction so two
        // concurrent transitions serialize; the from-state is re-checked after
        // the lock is held (the loser sees a non-matching status -> 409).
        const params: unknown[] = [id];
        let scopeClause = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scopeClause = ' AND owner_user_id = $2';
        }
        const { rows } = await client.query<PurchaseOrderRow>(
          `SELECT * FROM purchase_orders WHERE id = $1 AND deleted_at IS NULL${scopeClause} FOR UPDATE`,
          params,
        );
        if (rows.length === 0) {
          throw new PurchaseOrderNotFoundException();
        }
        const existing = rows[0];

        // Validate the legal from -> to transition (409 if illegal).
        const toStatus = assertTransition(action, existing.status);

        // Approval guards for approve/reject (§D3 / §7.2):
        //   1. the procurement:approve grant must be all-scoped (own rejected);
        //   2. separation of duties — the approver may not be the submitter.
        if (action === 'approve' || action === 'reject') {
          if (actor.dataScope !== 'all') {
            throw new ApprovalScopeException();
          }
          const submitter = await this.findSubmitter(client, existing.id);
          if (submitter !== null && submitter === actor.userId) {
            throw new SelfApprovalException();
          }
        }

        const { rows: updated } = await client.query<PurchaseOrderRow>(
          `UPDATE purchase_orders SET status = $1, updated_at = now()
            WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
          [toStatus, existing.id],
        );

        // Append the immutable approval ledger row (level defaults to 1).
        await client.query(
          `INSERT INTO order_approvals
             (tenant_id, order_type, order_id, action, from_status, to_status, actor_user_id, reason)
           VALUES ($1, 'purchase', $2, $3, $4, $5, $6, $7)`,
          [
            actor.tenantId,
            existing.id,
            action,
            existing.status,
            toStatus,
            actor.userId,
            reason ?? null,
          ],
        );

        return { before: existing, after: updated[0] };
      },
    );

    const afterResponse = toPurchaseOrderResponse(after);

    await this.safeAudit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: `purchase_order.${this.auditVerb(action)}`,
      resourceId: id,
      before: { status: before.status },
      after: {
        status: after.status,
        approval: {
          action,
          actor_user_id: actor.userId,
          reason: reason ?? null,
          level: 1,
        },
      },
      reason: reason ?? null,
    });

    return afterResponse;
  }

  // Maps a transition action to its audit verb (purchase_order.<verb>): submit
  // -> submitted, approve -> approved, reject -> rejected, withdraw -> withdrawn.
  private auditVerb(action: ApprovalAction): string {
    switch (action) {
      case 'submit':
        return 'submitted';
      case 'approve':
        return 'approved';
      case 'reject':
        return 'rejected';
      case 'withdraw':
        return 'withdrawn';
    }
  }

  private async safeAudit(params: {
    tenantId: string;
    actorId: string;
    action: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
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
        reason: params.reason ?? null,
      });
    } catch (err) {
      this.logger.error(
        `Audit write failed for ${params.action} purchase_order=${params.resourceId}: ${String(err)}`,
      );
    }
  }
}
