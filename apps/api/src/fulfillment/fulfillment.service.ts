import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { FilesService } from '../files/files.service';
import { RbacService } from '../rbac/rbac.service';
import { BusinessEventsService } from '../workbench/business-events.service';
import {
  AddLogisticsEventDto,
  CompleteExpenseFxDto,
  ConfirmGoodsReceiptDto,
  CreateGoodsReceiptDto,
  CreateShipmentBoxDto,
  CreateShipmentDto,
  DeliverShipmentDto,
  InspectGoodsReceiptDto,
  LinkShipmentReceiptDto,
  RecordOrderExpenseDto,
  UpdateFulfillmentSettingsDto,
} from './dto/fulfillment.dto';
import {
  FulfillmentConflictException,
  FulfillmentDutyException,
  FulfillmentNotFoundException,
  InvalidFulfillmentDataException,
} from './fulfillment.errors';

export interface FulfillmentActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

interface SalesOrderRow {
  id: string;
  owner_user_id: string;
  order_number: string;
  currency: string;
  status: string;
  source_pi_id: string | null;
  fulfillment_locked_snapshot: SalesOrderPackingSnapshot | null;
}

interface SalesOrderPackingSnapshot {
  id: string;
  items: Array<{
    id: string;
    line_no: number;
    quantity: string;
    product: {
      weight_kg: string | null;
      volume_cbm: string | null;
    } | null;
  }>;
}

interface PackingListLineRow {
  line_no: number;
  sales_order_item_id: string;
  quantity: string;
  weight_kg: string | null;
  volume_cbm: string | null;
  package_no: string | null;
}

export interface PackingListPackage {
  package_no: string;
  net_weight_kg: string | null;
  volume_cbm: string | null;
  items: Array<{
    sales_order_item_id: string;
    quantity: string;
    weight_kg: string | null;
    volume_cbm: string | null;
  }>;
}

export interface PackingListSourceDetails {
  document_set_id: string;
  version: number;
  source_order_locked: boolean | null;
  packages: PackingListPackage[];
}

interface PurchaseOrderRow {
  id: string;
  sales_order_id: string;
  owner_user_id: string;
  order_number: string;
  currency: string;
  status: string;
}

interface PurchaseItemRow {
  id: string;
  sales_order_item_id: string;
  line_no: number;
  description: string;
  quantity: string;
  unit: string | null;
  received_quantity: string;
}

interface GoodsReceiptRow {
  id: string;
  sales_order_id: string;
  purchase_order_id: string;
  batch_number: string;
  status: string;
  qc_result: string | null;
  is_final_batch: boolean;
  sales_confirmation_required: boolean;
  note: string | null;
  created_by: string;
  inspected_by: string | null;
  inspected_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GoodsReceiptItemRow {
  id: string;
  purchase_order_item_id: string;
  sales_order_item_id: string;
  received_quantity: string;
  accepted_quantity: string;
  rejected_quantity: string;
  quantity_variance: string;
}

interface ShipmentRow {
  id: string;
  sales_order_id: string;
  batch_number: string;
  status: string;
  carrier: string;
  tracking_number: string;
  idempotency_key: string | null;
  creation_request: Record<string, unknown> | null;
  packing_list_document_set_id: string | null;
  packing_list_version: number | null;
  packing_list_snapshot: Record<string, unknown> | null;
  created_by: string;
  dispatched_by: string | null;
  dispatched_at: Date | null;
  in_transit_by: string | null;
  in_transit_at: Date | null;
  delivered_by: string | null;
  delivered_at: Date | null;
  delivery_proof_file_id: string | null;
  delivery_note: string | null;
  received_by_name: string | null;
  delivery_exception_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AvailableItemRow {
  id: string;
  line_no: number;
  description: string;
  quantity: string;
  unit: string | null;
  accepted_quantity: string;
  shipped_quantity: string;
  delivered_quantity: string;
  available_quantity: string;
}

export interface ExpenseRow {
  id: string;
  sales_order_id: string;
  shipment_id: string | null;
  expense_type: string;
  amount: string;
  currency: string;
  fx_rate_to_rmb: string | null;
  fx_source: string | null;
  fx_captured_at: Date | null;
  amount_rmb: string | null;
  status: string;
  note: string | null;
  recorded_by: string;
  completed_by: string | null;
  completed_at: Date | null;
  created_at: Date;
}

const RECEIPT_COLUMNS = `id, sales_order_id, purchase_order_id, batch_number, status,
  qc_result, is_final_batch, sales_confirmation_required, note, created_by,
  inspected_by, inspected_at, completed_at, created_at, updated_at`;
const RECEIPT_ITEM_COLUMNS = `id, purchase_order_item_id, sales_order_item_id,
  received_quantity::text AS received_quantity,
  accepted_quantity::text AS accepted_quantity,
  rejected_quantity::text AS rejected_quantity,
  quantity_variance::text AS quantity_variance`;
const SHIPMENT_COLUMNS = `id, sales_order_id, batch_number, status, carrier, tracking_number,
  idempotency_key, creation_request, packing_list_document_set_id, packing_list_version,
  packing_list_snapshot, created_by, dispatched_by, dispatched_at, in_transit_by,
  in_transit_at, delivered_by, delivered_at, delivery_proof_file_id, delivery_note,
  received_by_name, delivery_exception_note, created_at, updated_at`;
const EXPENSE_COLUMNS = `id, sales_order_id, shipment_id, expense_type,
  amount::text AS amount, currency, fx_rate_to_rmb::text AS fx_rate_to_rmb,
  fx_source, fx_captured_at, amount_rmb::text AS amount_rmb, status, note,
  recorded_by, completed_by, completed_at, created_at`;

@Injectable()
export class FulfillmentService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly files: FilesService,
    private readonly events: BusinessEventsService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private assertAllScope(actor: FulfillmentActor): void {
    if (actor.dataScope !== 'all') {
      throw new FulfillmentDutyException(
        'This fulfillment action requires an all-scope permission grant',
        'FULFILLMENT_ALL_SCOPE_REQUIRED',
      );
    }
  }

  private context(actor: FulfillmentActor) {
    return { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' as const };
  }

  private async fileScope(actor: FulfillmentActor): Promise<string> {
    const permission = await this.rbac.checkPermission(actor.userId, actor.tenantId, 'files:view');
    return permission.allowed ? permission.dataScope : 'none';
  }

  private scaled(value: string, places: number): bigint {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(`${whole || '0'}${(fraction + '0'.repeat(places)).slice(0, places)}`);
  }

  private decimal(value: bigint, places: number): string {
    const text = value.toString().padStart(places + 1, '0');
    return `${text.slice(0, -places)}.${text.slice(-places)}`;
  }

  private measure(quantity: string, perUnit: string, places: number): string {
    const multiplied = this.scaled(quantity, 3) * this.scaled(perUnit, places);
    return this.decimal((multiplied + 500n) / 1000n, places);
  }

  private async salesOrder(
    client: PoolClient,
    actor: FulfillmentActor,
    orderId: string,
    lock = false,
  ): Promise<SalesOrderRow> {
    const params: unknown[] = [orderId];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND owner_user_id = $${params.length}`;
    }
    const result = await client.query<SalesOrderRow>(
      `SELECT id, owner_user_id, order_number, currency, status, source_pi_id,
              fulfillment_locked_snapshot
         FROM sales_orders
        WHERE id = $1
          AND (source_pi_id IS NOT NULL OR fulfillment_locked_snapshot IS NOT NULL)
          AND deleted_at IS NULL${scope}
        ${lock ? 'FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new FulfillmentNotFoundException('PI-backed sales order not found');
    }
    return result.rows[0];
  }

  private async lockSalesOrderByReceipt(
    client: PoolClient,
    actor: FulfillmentActor,
    receiptId: string,
  ): Promise<SalesOrderRow> {
    const linked = await client.query<{ sales_order_id: string }>(
      `SELECT sales_order_id FROM goods_receipts WHERE id = $1`,
      [receiptId],
    );
    if (linked.rows.length === 0) throw new FulfillmentNotFoundException('Goods receipt not found');
    return this.salesOrder(client, actor, linked.rows[0].sales_order_id, true);
  }

  private async lockSalesOrderByShipment(
    client: PoolClient,
    actor: FulfillmentActor,
    shipmentId: string,
  ): Promise<SalesOrderRow> {
    const linked = await client.query<{ sales_order_id: string }>(
      `SELECT sales_order_id FROM shipments WHERE id = $1`,
      [shipmentId],
    );
    if (linked.rows.length === 0) throw new FulfillmentNotFoundException('Shipment not found');
    return this.salesOrder(client, actor, linked.rows[0].sales_order_id, true);
  }

  private async readSettings(client: PoolClient): Promise<UpdateFulfillmentSettingsDto> {
    const result = await client.query<{ value_json: Record<string, unknown> }>(
      `SELECT value_json FROM tenant_settings WHERE key = 'fulfillment'`,
    );
    return {
      require_sales_receipt_confirmation:
        result.rows[0]?.value_json.require_sales_receipt_confirmation !== false,
    };
  }

  async getSettings(actor: FulfillmentActor) {
    return withTenantContext(this.pool, this.context(actor), (client) => this.readSettings(client));
  }

  async updateSettings(actor: FulfillmentActor, dto: UpdateFulfillmentSettingsDto) {
    this.assertAllScope(actor);
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const before = await this.readSettings(client);
      const after = {
        require_sales_receipt_confirmation: dto.require_sales_receipt_confirmation,
      };
      await client.query(
        `INSERT INTO tenant_settings (tenant_id, key, value_json, updated_by)
         VALUES ($1, 'fulfillment', $2::jsonb, $3)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [actor.tenantId, JSON.stringify(after), actor.userId],
      );
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'fulfillment_settings.updated',
        resourceType: 'tenant_settings',
        resourceId: null,
        before,
        after,
      });
      return after;
    });
  }

  private async availableItems(client: PoolClient, orderId: string): Promise<AvailableItemRow[]> {
    const result = await client.query<AvailableItemRow>(
      `SELECT item.id, item.line_no, item.description, item.quantity::text AS quantity, item.unit,
              COALESCE(accepted.quantity, 0)::text AS accepted_quantity,
              COALESCE(shipped.quantity, 0)::text AS shipped_quantity,
              COALESCE(delivered.quantity, 0)::text AS delivered_quantity,
              GREATEST(
                LEAST(
                  item.quantity,
                  CASE WHEN sales_order.fulfillment_locked_snapshot IS NOT NULL
                    THEN item.quantity ELSE COALESCE(accepted.quantity, 0) END
                )
                  - COALESCE(shipped.quantity, 0), 0
              )::text AS available_quantity
         FROM sales_order_items item
         JOIN sales_orders sales_order ON sales_order.id = item.order_id
         LEFT JOIN LATERAL (
           SELECT sum(receipt_item.accepted_quantity) AS quantity
             FROM goods_receipt_items receipt_item
             JOIN goods_receipts receipt
               ON receipt.id = receipt_item.goods_receipt_id
              AND receipt.tenant_id = receipt_item.tenant_id
            WHERE receipt_item.sales_order_item_id = item.id AND receipt.status = 'accepted'
         ) accepted ON true
         LEFT JOIN LATERAL (
           SELECT sum(shipment_item.quantity) AS quantity
             FROM shipment_items shipment_item
             JOIN shipments shipment
               ON shipment.id = shipment_item.shipment_id
              AND shipment.tenant_id = shipment_item.tenant_id
            WHERE shipment_item.sales_order_item_id = item.id
              AND shipment.status IN ('dispatched', 'in_transit', 'delivered')
         ) shipped ON true
         LEFT JOIN LATERAL (
           SELECT sum(shipment_item.quantity) AS quantity
             FROM shipment_items shipment_item
             JOIN shipments shipment
               ON shipment.id = shipment_item.shipment_id
              AND shipment.tenant_id = shipment_item.tenant_id
            WHERE shipment_item.sales_order_item_id = item.id AND shipment.status = 'delivered'
         ) delivered ON true
        WHERE item.order_id = $1 AND item.deleted_at IS NULL
        ORDER BY item.line_no`,
      [orderId],
    );
    return result.rows;
  }

  private async packingListSourceDetails(
    client: PoolClient,
    orderId: string,
  ): Promise<PackingListSourceDetails | null> {
    const source = await client.query<{
      document_set_id: string;
      version: number;
      source_order_locked: boolean | null;
      packing_mode: 'normal' | 'combined';
    }>(
      `SELECT id AS document_set_id, version,
              source_sales_order_locked AS source_order_locked, packing_mode
         FROM trade_document_sets
        WHERE sales_order_id = $1 AND source_sales_order_snapshot IS NOT NULL`,
      [orderId],
    );
    if (!source.rows[0]) return null;

    const lines = await client.query<PackingListLineRow>(
      `SELECT document_line.line_no, order_item.id AS sales_order_item_id,
              document_line.quantity::text AS quantity,
              document_line.weight_kg::text AS weight_kg,
              document_line.volume_cbm::text AS volume_cbm,
              document_line.package_no
         FROM trade_document_lines document_line
         JOIN sales_order_items order_item
           ON order_item.order_id = $2
          AND order_item.line_no = document_line.line_no
          AND order_item.deleted_at IS NULL
        WHERE document_line.document_set_id = $1
        ORDER BY document_line.line_no`,
      [source.rows[0].document_set_id, orderId],
    );

    const packageGroups = new Map<string, PackingListLineRow[]>();
    for (const line of lines.rows) {
      const packageNo =
        line.package_no?.trim() ||
        (source.rows[0].packing_mode === 'normal' ? `PKG-${line.line_no}` : 'COMBINED-1');
      if (source.rows[0].packing_mode === 'normal') {
        packageGroups.set(`${packageNo}\u0000${line.line_no}`, [line]);
      } else {
        packageGroups.set(packageNo, [...(packageGroups.get(packageNo) ?? []), line]);
      }
    }

    return {
      document_set_id: source.rows[0].document_set_id,
      version: source.rows[0].version,
      source_order_locked: source.rows[0].source_order_locked,
      packages: [...packageGroups.entries()].map(([key, packageLines]) => {
        const packageNo = key.split('\u0000', 1)[0];
        const completeMeasures = packageLines.every(
          (line) => line.weight_kg !== null && line.volume_cbm !== null,
        );
        return {
          package_no: packageNo,
          net_weight_kg: completeMeasures
            ? this.decimal(
                packageLines.reduce(
                  (total, line) =>
                    total + this.scaled(this.measure(line.quantity, line.weight_kg!, 4), 4),
                  0n,
                ),
                4,
              )
            : null,
          volume_cbm: completeMeasures
            ? this.decimal(
                packageLines.reduce(
                  (total, line) =>
                    total + this.scaled(this.measure(line.quantity, line.volume_cbm!, 6), 6),
                  0n,
                ),
                6,
              )
            : null,
          items: packageLines.map((line) => ({
            sales_order_item_id: line.sales_order_item_id,
            quantity: line.quantity,
            weight_kg: line.weight_kg,
            volume_cbm: line.volume_cbm,
          })),
        };
      }),
    };
  }

  private async deriveAggregateStatus(client: PoolClient, order: SalesOrderRow): Promise<string> {
    if (['cancelled', 'on_hold', 'finance_review', 'settled'].includes(order.status)) {
      return order.status;
    }
    const delivery = await client.query<{
      all_delivered: boolean;
      any_fulfillment: boolean;
      any_procurement: boolean;
    }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM sales_order_items item
            WHERE item.order_id = $1 AND item.deleted_at IS NULL
         ) AND NOT EXISTS (
           SELECT 1
             FROM sales_order_items item
            WHERE item.order_id = $1 AND item.deleted_at IS NULL
              AND COALESCE((
                SELECT sum(shipment_item.quantity)
                  FROM shipment_items shipment_item
                  JOIN shipments shipment
                    ON shipment.id = shipment_item.shipment_id
                   AND shipment.tenant_id = shipment_item.tenant_id
                 WHERE shipment_item.sales_order_item_id = item.id
                   AND shipment.status = 'delivered'
              ), 0) < item.quantity
         ) AS all_delivered,
         EXISTS (SELECT 1 FROM goods_receipts WHERE sales_order_id = $1)
           OR EXISTS (SELECT 1 FROM shipments WHERE sales_order_id = $1) AS any_fulfillment,
         EXISTS (
           SELECT 1
             FROM sales_order_purchase_orders link
             JOIN purchase_orders purchase_order ON purchase_order.id = link.purchase_order_id
            WHERE link.sales_order_id = $1
              AND purchase_order.status IN ('placed', 'received', 'closed')
         ) AS any_procurement`,
      [order.id],
    );
    if (delivery.rows[0].all_delivered) return 'delivered';
    if (delivery.rows[0].any_fulfillment) return 'fulfillment';
    if (delivery.rows[0].any_procurement) return 'procurement';
    return order.status;
  }

  private async syncAggregateStatus(client: PoolClient, order: SalesOrderRow): Promise<string> {
    const aggregateStatus = await this.deriveAggregateStatus(client, order);
    if (aggregateStatus !== order.status) {
      await client.query(`UPDATE sales_orders SET status = $1, updated_at = now() WHERE id = $2`, [
        aggregateStatus,
        order.id,
      ]);
      order.status = aggregateStatus;
    }
    return aggregateStatus;
  }

  private async receiptResponse(client: PoolClient, receipt: GoodsReceiptRow) {
    const items = await client.query<GoodsReceiptItemRow>(
      `SELECT ${RECEIPT_ITEM_COLUMNS}
         FROM goods_receipt_items WHERE goods_receipt_id = $1
        ORDER BY id`,
      [receipt.id],
    );
    const files = await client.query<{ file_id: string; file_role: string }>(
      `SELECT file_id, file_role FROM goods_receipt_files
        WHERE goods_receipt_id = $1 ORDER BY created_at, id`,
      [receipt.id],
    );
    const confirmations = await client.query(
      `SELECT id, confirmation_type, decision, confirmed_by, reason, confirmed_at
         FROM goods_receipt_confirmations
        WHERE goods_receipt_id = $1 ORDER BY confirmed_at, id`,
      [receipt.id],
    );
    return { ...receipt, items: items.rows, files: files.rows, confirmations: confirmations.rows };
  }

  private async shipmentResponse(client: PoolClient, shipment: ShipmentRow, idempotent = false) {
    const items = await client.query(
      `SELECT id, sales_order_item_id, quantity::text AS quantity,
              available_quantity_snapshot::text AS available_quantity_snapshot
         FROM shipment_items WHERE shipment_id = $1 ORDER BY id`,
      [shipment.id],
    );
    const events = await client.query(
      `SELECT id, event_type, location, description, occurred_at, recorded_by, created_at
         FROM logistics_events WHERE shipment_id = $1 ORDER BY occurred_at, created_at, id`,
      [shipment.id],
    );
    const boxes = await client.query(
      `SELECT box.id, box.package_no,
              box.gross_weight_kg::text AS gross_weight_kg,
              box.net_weight_kg::text AS net_weight_kg,
              box.volume_cbm::text AS volume_cbm,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'id', item.id,
                    'sales_order_item_id', item.sales_order_item_id,
                    'quantity', item.quantity::text
                  ) ORDER BY item.id
                ) FILTER (WHERE item.id IS NOT NULL),
                '[]'::jsonb
              ) AS items
         FROM shipment_boxes box
         LEFT JOIN shipment_box_items item ON item.shipment_box_id = box.id
        WHERE box.shipment_id = $1
        GROUP BY box.id, box.package_no, box.gross_weight_kg, box.net_weight_kg, box.volume_cbm
        ORDER BY box.package_no, box.id`,
      [shipment.id],
    );
    const deliveryFiles = await client.query(
      `SELECT file_id, file_role, created_at
         FROM shipment_delivery_files WHERE shipment_id = $1 ORDER BY created_at, id`,
      [shipment.id],
    );
    const receipts = await client.query(
      `SELECT link.id, receipt.id AS customer_receipt_id,
              receipt.amount::text AS amount, receipt.currency, receipt.received_at,
              COALESCE(decision.decision, 'recorded') AS status,
              link.linked_by, link.linked_at
         FROM shipment_customer_receipts link
         JOIN customer_receipts receipt
           ON receipt.id = link.customer_receipt_id AND receipt.tenant_id = link.tenant_id
         LEFT JOIN customer_receipt_decisions decision
           ON decision.receipt_id = receipt.id AND decision.tenant_id = receipt.tenant_id
        WHERE link.shipment_id = $1 ORDER BY link.linked_at, link.id`,
      [shipment.id],
    );
    const { creation_request: _creationRequest, ...publicShipment } = shipment;
    return {
      ...publicShipment,
      idempotent,
      items: items.rows,
      boxes: boxes.rows,
      delivery_files: deliveryFiles.rows,
      logistics_events: events.rows,
      receipts: receipts.rows,
    };
  }

  async getOrder(actor: FulfillmentActor, orderId: string) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.salesOrder(client, actor, orderId);
      const purchaseOrders = await client.query(
        `SELECT purchase_order.id, purchase_order.order_number, purchase_order.currency,
                    purchase_order.status,
                    jsonb_agg(
                      jsonb_build_object(
                        'id', item.id,
                        'line_no', item.line_no,
                        'description', item.description,
                        'quantity', item.quantity::text,
                        'unit', item.unit
                      ) ORDER BY item.line_no
                    ) AS items
               FROM sales_order_purchase_orders link
               JOIN purchase_orders purchase_order ON purchase_order.id = link.purchase_order_id
               JOIN purchase_order_items item ON item.order_id = purchase_order.id
              WHERE link.sales_order_id = $1 AND purchase_order.deleted_at IS NULL
                AND item.deleted_at IS NULL
              GROUP BY purchase_order.id, purchase_order.order_number,
                purchase_order.currency, purchase_order.status
              ORDER BY purchase_order.created_at, purchase_order.id`,
        [order.id],
      );
      const receiptRows = await client.query<GoodsReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS} FROM goods_receipts
          WHERE sales_order_id = $1 ORDER BY created_at, id`,
        [order.id],
      );
      const shipmentRows = await client.query<ShipmentRow>(
        `SELECT ${SHIPMENT_COLUMNS} FROM shipments
          WHERE sales_order_id = $1 ORDER BY created_at, id`,
        [order.id],
      );
      const expenseRows = await client.query<ExpenseRow>(
        `SELECT ${EXPENSE_COLUMNS} FROM order_expenses
          WHERE sales_order_id = $1 ORDER BY created_at, id`,
        [order.id],
      );
      const items = await this.availableItems(client, order.id);
      const settings = await this.readSettings(client);
      const packingSource = await this.packingListSourceDetails(client, order.id);
      const receipts = [];
      for (const receipt of receiptRows.rows) {
        receipts.push(await this.receiptResponse(client, receipt));
      }
      const shipments = [];
      for (const shipment of shipmentRows.rows) {
        shipments.push(await this.shipmentResponse(client, shipment));
      }
      return {
        id: order.id,
        order_number: order.order_number,
        currency: order.currency,
        aggregate_status: await this.deriveAggregateStatus(client, order),
        settings,
        packing_list_source: packingSource,
        items,
        purchase_orders: purchaseOrders.rows,
        goods_receipts: receipts,
        shipments,
        expenses: expenseRows.rows,
      };
    });
  }

  private async purchaseOrderForReceipt(
    client: PoolClient,
    purchaseOrderId: string,
  ): Promise<PurchaseOrderRow> {
    const linked = await client.query<{ sales_order_id: string }>(
      `SELECT sales_order_id FROM sales_order_purchase_orders WHERE purchase_order_id = $1`,
      [purchaseOrderId],
    );
    if (linked.rows.length === 0) {
      throw new FulfillmentNotFoundException('Generated purchase order not found');
    }
    await client.query(`SELECT id FROM sales_orders WHERE id = $1 FOR UPDATE`, [
      linked.rows[0].sales_order_id,
    ]);
    const result = await client.query<PurchaseOrderRow>(
      `SELECT purchase_order.id, link.sales_order_id, purchase_order.owner_user_id,
              purchase_order.order_number, purchase_order.currency, purchase_order.status
         FROM purchase_orders purchase_order
         JOIN sales_order_purchase_orders link ON link.purchase_order_id = purchase_order.id
        WHERE purchase_order.id = $1 AND purchase_order.deleted_at IS NULL
        FOR UPDATE OF purchase_order`,
      [purchaseOrderId],
    );
    if (result.rows.length === 0) {
      throw new FulfillmentNotFoundException('Generated purchase order not found');
    }
    return result.rows[0];
  }

  private async openException(
    client: PoolClient,
    actor: FulfillmentActor,
    input: {
      order: SalesOrderRow;
      contextType: 'purchase_order' | 'shipment' | 'sales_order';
      contextId: string;
      type: 'quantity_variance' | 'quality_variance' | 'missing_expense';
      severity: 'medium' | 'high';
      summary: string;
    },
  ): Promise<string> {
    const result = await client.query<{ id: string; status: string; version: number }>(
      `INSERT INTO business_exceptions
         (tenant_id, context_type, context_id, exception_type, severity, summary, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, status, version`,
      [
        actor.tenantId,
        input.contextType,
        input.contextId,
        input.type,
        input.severity,
        input.summary,
        input.order.owner_user_id,
      ],
    );
    await this.audit.logInTransaction(client, {
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action: 'business_exception.opened',
      resourceType: 'business_exception',
      resourceId: result.rows[0].id,
      after: {
        type: input.type,
        severity: input.severity,
        status: result.rows[0].status,
        version: result.rows[0].version,
      },
    });
    await this.events.recordInTransaction(client, {
      tenantId: actor.tenantId,
      chainType: 'sales_order',
      chainId: input.order.id,
      credentialType: 'business_exception',
      credentialId: result.rows[0].id,
      eventType: 'business_exception.opened',
      actorType: 'tenant_user',
      actorId: actor.userId,
      scopeUserId: input.order.owner_user_id,
      visibilityPermission: 'business_exceptions:view',
    });
    return result.rows[0].id;
  }

  private async recordEvent(
    client: PoolClient,
    actor: FulfillmentActor,
    order: SalesOrderRow,
    credentialType: string,
    credentialId: string,
    eventType: string,
  ): Promise<void> {
    await this.events.recordInTransaction(client, {
      tenantId: actor.tenantId,
      chainType: 'sales_order',
      chainId: order.id,
      credentialType,
      credentialId,
      eventType,
      actorType: 'tenant_user',
      actorId: actor.userId,
      scopeUserId: order.owner_user_id,
      visibilityPermission: 'fulfillment:view',
    });
  }

  async createGoodsReceipt(
    actor: FulfillmentActor,
    purchaseOrderId: string,
    dto: CreateGoodsReceiptDto,
  ) {
    this.assertAllScope(actor);
    const itemIds = dto.items.map((item) => item.purchase_order_item_id);
    const fileIds = dto.file_ids ?? [];
    if (new Set(itemIds).size !== itemIds.length) {
      throw new InvalidFulfillmentDataException(
        'Each purchase order item can appear only once',
        'DUPLICATE_GOODS_RECEIPT_ITEM',
      );
    }
    if (new Set(fileIds).size !== fileIds.length) {
      throw new InvalidFulfillmentDataException(
        'Each receipt file can appear only once',
        'DUPLICATE_GOODS_RECEIPT_FILE',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const purchaseOrder = await this.purchaseOrderForReceipt(client, purchaseOrderId);
      if (!['placed', 'received'].includes(purchaseOrder.status)) {
        throw new FulfillmentConflictException(
          'Only a placed purchase order can receive goods',
          'PURCHASE_ORDER_NOT_RECEIVABLE',
        );
      }
      const order = await this.salesOrder(client, actor, purchaseOrder.sales_order_id);
      const purchaseItems = await client.query<PurchaseItemRow>(
        `SELECT purchase_item.id, request_item.sales_order_item_id,
                purchase_item.line_no, purchase_item.description,
                purchase_item.quantity::text AS quantity, purchase_item.unit,
                COALESCE(received.quantity, 0)::text AS received_quantity
           FROM purchase_order_items purchase_item
           JOIN procurement_request_items request_item
             ON request_item.id = purchase_item.source_procurement_request_item_id
            AND request_item.tenant_id = purchase_item.tenant_id
           LEFT JOIN LATERAL (
             SELECT sum(receipt_item.received_quantity) AS quantity
               FROM goods_receipt_items receipt_item
              WHERE receipt_item.purchase_order_item_id = purchase_item.id
           ) received ON true
          WHERE purchase_item.order_id = $1 AND purchase_item.deleted_at IS NULL
          ORDER BY purchase_item.line_no`,
        [purchaseOrder.id],
      );
      const selected = purchaseItems.rows.filter((item) => itemIds.includes(item.id));
      if (selected.length !== itemIds.length) {
        throw new InvalidFulfillmentDataException(
          'Every receipt item must belong to the purchase order',
          'GOODS_RECEIPT_ITEM_NOT_IN_PURCHASE_ORDER',
        );
      }
      if (dto.is_final_batch && selected.length !== purchaseItems.rows.length) {
        throw new InvalidFulfillmentDataException(
          'A final receipt batch must include every purchase order item',
          'FINAL_RECEIPT_ITEMS_INCOMPLETE',
        );
      }
      if (fileIds.length > 0) {
        const files = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM files
            WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [fileIds],
        );
        if (Number(files.rows[0].count) !== fileIds.length) {
          throw new InvalidFulfillmentDataException(
            'Every receipt file must exist in this tenant',
            'GOODS_RECEIPT_FILE_NOT_FOUND',
          );
        }
      }
      const settings = await this.readSettings(client);
      const inserted = await client.query<GoodsReceiptRow>(
        `INSERT INTO goods_receipts
           (tenant_id, sales_order_id, purchase_order_id, batch_number, is_final_batch,
            sales_confirmation_required, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${RECEIPT_COLUMNS}`,
        [
          actor.tenantId,
          order.id,
          purchaseOrder.id,
          dto.batch_number.trim(),
          dto.is_final_batch,
          settings.require_sales_receipt_confirmation,
          dto.note?.trim() || null,
          actor.userId,
        ],
      );
      const inputById = new Map(
        dto.items.map((item) => [item.purchase_order_item_id, item.received_quantity]),
      );
      for (const item of selected) {
        const receivedQuantity = inputById.get(item.id)!;
        const calculation = await client.query<{
          cumulative: string;
          variance: string;
          variance_positive: boolean;
          variance_zero: boolean;
        }>(
          `SELECT ($1::numeric + $2::numeric)::text AS cumulative,
                  ($1::numeric + $2::numeric - $3::numeric)::text AS variance,
                  $1::numeric + $2::numeric - $3::numeric > 0 AS variance_positive,
                  $1::numeric + $2::numeric - $3::numeric = 0 AS variance_zero`,
          [item.received_quantity, receivedQuantity, item.quantity],
        );
        const quantityVariance =
          calculation.rows[0].variance_positive ||
          (dto.is_final_batch && !calculation.rows[0].variance_zero)
            ? calculation.rows[0].variance
            : '0';
        await client.query(
          `INSERT INTO goods_receipt_items
             (tenant_id, goods_receipt_id, purchase_order_item_id, sales_order_item_id,
              received_quantity, quantity_variance)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            actor.tenantId,
            inserted.rows[0].id,
            item.id,
            item.sales_order_item_id,
            receivedQuantity,
            quantityVariance,
          ],
        );
        if (quantityVariance !== '0') {
          await this.openException(client, actor, {
            order,
            contextType: 'purchase_order',
            contextId: purchaseOrder.id,
            type: 'quantity_variance',
            severity: 'high',
            summary: `Receipt ${dto.batch_number.trim()} line ${item.line_no} cumulative variance ${quantityVariance}`,
          });
        }
      }
      for (const fileId of fileIds) {
        await client.query(
          `INSERT INTO goods_receipt_files (tenant_id, goods_receipt_id, file_id)
           VALUES ($1,$2,$3)`,
          [actor.tenantId, inserted.rows[0].id, fileId],
        );
      }
      if (dto.is_final_batch) {
        if (purchaseOrder.status === 'placed') {
          await client.query(
            `UPDATE purchase_orders SET status = 'received', updated_at = now() WHERE id = $1`,
            [purchaseOrder.id],
          );
        }
      } else if (purchaseOrder.status === 'placed') {
        const complete = await client.query<{ complete: boolean }>(
          `SELECT NOT EXISTS (
             SELECT 1
               FROM purchase_order_items purchase_item
              WHERE purchase_item.order_id = $1 AND purchase_item.deleted_at IS NULL
                AND COALESCE((
                  SELECT sum(receipt_item.received_quantity)
                    FROM goods_receipt_items receipt_item
                   WHERE receipt_item.purchase_order_item_id = purchase_item.id
                ), 0) < purchase_item.quantity
           ) AS complete`,
          [purchaseOrder.id],
        );
        if (complete.rows[0].complete) {
          await client.query(
            `UPDATE purchase_orders SET status = 'received', updated_at = now() WHERE id = $1`,
            [purchaseOrder.id],
          );
        }
      }
      const response = await this.receiptResponse(client, inserted.rows[0]);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'goods_receipt.created',
        resourceType: 'goods_receipt',
        resourceId: inserted.rows[0].id,
        after: response,
      });
      await this.recordEvent(
        client,
        actor,
        order,
        'goods_receipt',
        inserted.rows[0].id,
        'goods_receipt.created',
      );
      await this.syncAggregateStatus(client, order);
      return response;
    });
  }

  async inspectGoodsReceipt(
    actor: FulfillmentActor,
    receiptId: string,
    dto: InspectGoodsReceiptDto,
  ) {
    this.assertAllScope(actor);
    const inputById = new Map(dto.items.map((item) => [item.item_id, item]));
    if (inputById.size !== dto.items.length) {
      throw new InvalidFulfillmentDataException(
        'Each receipt item can appear only once',
        'DUPLICATE_QC_ITEM',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.lockSalesOrderByReceipt(client, actor, receiptId);
      const receiptResult = await client.query<GoodsReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS} FROM goods_receipts WHERE id = $1 FOR UPDATE`,
        [receiptId],
      );
      const receipt = receiptResult.rows[0];
      if (!receipt) throw new FulfillmentNotFoundException('Goods receipt not found');
      if (receipt.status !== 'pending') {
        throw new FulfillmentConflictException(
          'Only a pending goods receipt can be inspected',
          'GOODS_RECEIPT_NOT_INSPECTABLE',
        );
      }
      const items = await client.query<GoodsReceiptItemRow>(
        `SELECT ${RECEIPT_ITEM_COLUMNS} FROM goods_receipt_items
          WHERE goods_receipt_id = $1 ORDER BY id FOR UPDATE`,
        [receipt.id],
      );
      if (
        items.rows.length !== dto.items.length ||
        items.rows.some((item) => !inputById.has(item.id))
      ) {
        throw new InvalidFulfillmentDataException(
          'QC quantities must be provided exactly once for every receipt item',
          'QC_ITEMS_INCOMPLETE',
        );
      }
      for (const item of items.rows) {
        const input = inputById.get(item.id)!;
        const quantities = await client.query<{ valid: boolean }>(
          `SELECT $1::numeric + $2::numeric = $3::numeric AS valid`,
          [input.accepted_quantity, input.rejected_quantity, item.received_quantity],
        );
        if (!quantities.rows[0].valid) {
          throw new InvalidFulfillmentDataException(
            'Accepted and rejected QC quantities must equal the received quantity',
            'QC_QUANTITY_MISMATCH',
          );
        }
        await client.query(
          `UPDATE goods_receipt_items
              SET accepted_quantity = $1, rejected_quantity = $2, updated_at = now()
            WHERE id = $3`,
          [input.accepted_quantity, input.rejected_quantity, item.id],
        );
      }
      const totals = await client.query<{
        accepted: string;
        rejected: string;
        qc_result: 'passed' | 'partial' | 'failed';
        has_rejected: boolean;
      }>(
        `SELECT sum(accepted_quantity)::text AS accepted,
                sum(rejected_quantity)::text AS rejected,
                CASE
                  WHEN sum(accepted_quantity) = 0 THEN 'failed'
                  WHEN sum(rejected_quantity) > 0 THEN 'partial'
                  ELSE 'passed'
                END AS qc_result,
                sum(rejected_quantity) > 0 AS has_rejected
           FROM goods_receipt_items WHERE goods_receipt_id = $1`,
        [receipt.id],
      );
      const totalAccepted = totals.rows[0].accepted;
      const totalRejected = totals.rows[0].rejected;
      const qcResult = totals.rows[0].qc_result;
      const status =
        qcResult === 'failed'
          ? 'rejected'
          : receipt.sales_confirmation_required
            ? 'inspected'
            : 'accepted';
      const updated = await client.query<GoodsReceiptRow>(
        `UPDATE goods_receipts
            SET status = $1::varchar, qc_result = $2, inspected_by = $3, inspected_at = now(),
                completed_at = CASE WHEN $1::varchar = 'inspected' THEN NULL ELSE now() END,
                note = COALESCE($4, note), updated_at = now()
          WHERE id = $5
          RETURNING ${RECEIPT_COLUMNS}`,
        [status, qcResult, actor.userId, dto.note?.trim() || null, receipt.id],
      );
      await client.query(
        `INSERT INTO goods_receipt_confirmations
           (tenant_id, goods_receipt_id, confirmation_type, decision, confirmed_by, reason)
         VALUES ($1,$2,'procurement_qc',$3,$4,$5)`,
        [
          actor.tenantId,
          receipt.id,
          qcResult === 'failed' ? 'rejected' : 'accepted',
          actor.userId,
          dto.note?.trim() || (qcResult === 'failed' ? 'All received quantity failed QC' : null),
        ],
      );
      if (totals.rows[0].has_rejected) {
        await this.openException(client, actor, {
          order,
          contextType: 'purchase_order',
          contextId: receipt.purchase_order_id,
          type: 'quality_variance',
          severity: 'high',
          summary: `Receipt ${receipt.batch_number} has rejected QC quantity ${totalRejected}`,
        });
      }
      const response = await this.receiptResponse(client, updated.rows[0]);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'goods_receipt.inspected',
        resourceType: 'goods_receipt',
        resourceId: receipt.id,
        before: { status: receipt.status },
        after: {
          status,
          qc_result: qcResult,
          accepted_quantity: totalAccepted,
          rejected_quantity: totalRejected,
        },
        reason: dto.note?.trim() || null,
      });
      await this.recordEvent(
        client,
        actor,
        order,
        'goods_receipt',
        receipt.id,
        'goods_receipt.inspected',
      );
      await this.syncAggregateStatus(client, order);
      return response;
    });
  }

  async confirmGoodsReceipt(
    actor: FulfillmentActor,
    receiptId: string,
    dto: ConfirmGoodsReceiptDto,
  ) {
    if (dto.decision === 'rejected' && !dto.reason?.trim()) {
      throw new InvalidFulfillmentDataException(
        'A rejection reason is required',
        'GOODS_RECEIPT_REJECTION_REASON_REQUIRED',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.lockSalesOrderByReceipt(client, actor, receiptId);
      const result = await client.query<GoodsReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS} FROM goods_receipts WHERE id = $1 FOR UPDATE`,
        [receiptId],
      );
      const receipt = result.rows[0];
      if (!receipt) throw new FulfillmentNotFoundException('Goods receipt not found');
      if (receipt.status !== 'inspected' || !receipt.sales_confirmation_required) {
        throw new FulfillmentConflictException(
          'This goods receipt is not waiting for sales confirmation',
          'GOODS_RECEIPT_NOT_CONFIRMABLE',
        );
      }
      const updated = await client.query<GoodsReceiptRow>(
        `UPDATE goods_receipts
            SET status = $1, completed_at = now(), updated_at = now()
          WHERE id = $2 RETURNING ${RECEIPT_COLUMNS}`,
        [dto.decision, receipt.id],
      );
      await client.query(
        `INSERT INTO goods_receipt_confirmations
           (tenant_id, goods_receipt_id, confirmation_type, decision, confirmed_by, reason)
         VALUES ($1,$2,'sales_acceptance',$3,$4,$5)`,
        [actor.tenantId, receipt.id, dto.decision, actor.userId, dto.reason?.trim() || null],
      );
      const response = await this.receiptResponse(client, updated.rows[0]);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: `goods_receipt.${dto.decision}`,
        resourceType: 'goods_receipt',
        resourceId: receipt.id,
        before: { status: receipt.status },
        after: { status: dto.decision },
        reason: dto.reason?.trim() || null,
      });
      await this.recordEvent(
        client,
        actor,
        order,
        'goods_receipt',
        receipt.id,
        `goods_receipt.${dto.decision}`,
      );
      await this.syncAggregateStatus(client, order);
      return response;
    });
  }

  private shipmentBoxes(dto: CreateShipmentDto): CreateShipmentBoxDto[] {
    if (dto.boxes && dto.items) {
      throw new InvalidFulfillmentDataException(
        'Provide shipment boxes or legacy shipment items, not both',
        'SHIPMENT_INPUT_AMBIGUOUS',
      );
    }
    if (!dto.boxes && !dto.items) {
      throw new InvalidFulfillmentDataException(
        'At least one shipment box or legacy shipment item is required',
        'SHIPMENT_ITEMS_REQUIRED',
      );
    }
    return dto.boxes ?? [];
  }

  private aggregateShipmentQuantities(dto: CreateShipmentDto): Map<string, string> {
    const quantities = new Map<string, bigint>();
    const items = dto.boxes?.flatMap((box) => box.items) ?? dto.items ?? [];
    for (const item of items) {
      quantities.set(
        item.sales_order_item_id,
        (quantities.get(item.sales_order_item_id) ?? 0n) + this.scaled(item.quantity, 3),
      );
    }
    return new Map(
      [...quantities.entries()].map(([itemId, quantity]) => [itemId, this.decimal(quantity, 3)]),
    );
  }

  private validateBoxes(boxes: CreateShipmentBoxDto[]): void {
    const packageNumbers = boxes.map((box) => box.package_no.trim());
    if (new Set(packageNumbers).size !== packageNumbers.length) {
      throw new InvalidFulfillmentDataException(
        'Package numbers must be unique within a shipment',
        'DUPLICATE_PACKAGE_NUMBER',
      );
    }
    for (const box of boxes) {
      const itemIds = box.items.map((item) => item.sales_order_item_id);
      if (new Set(itemIds).size !== itemIds.length) {
        throw new InvalidFulfillmentDataException(
          `Each sales order item can appear only once in package ${box.package_no.trim()}`,
          'DUPLICATE_BOX_ITEM',
        );
      }
      if (this.scaled(box.gross_weight_kg, 4) < this.scaled(box.net_weight_kg, 4)) {
        throw new InvalidFulfillmentDataException(
          `Gross weight cannot be less than net weight for package ${box.package_no.trim()}`,
          'PACKAGE_WEIGHT_INVALID',
        );
      }
    }
  }

  private async assertDirectProcurementApproved(
    client: PoolClient,
    order: SalesOrderRow,
  ): Promise<void> {
    if (!order.fulfillment_locked_snapshot) return;
    const purchaseOrders = await client.query<{ count: string; all_approved: boolean }>(
      `SELECT count(*)::text AS count,
              COALESCE(bool_and(purchase_order.status = 'approved'), false) AS all_approved
         FROM sales_order_purchase_orders link
         JOIN purchase_orders purchase_order ON purchase_order.id = link.purchase_order_id
        WHERE link.sales_order_id = $1
          AND link.source_sales_order_generation_id IS NOT NULL
          AND purchase_order.deleted_at IS NULL`,
      [order.id],
    );
    if (purchaseOrders.rows[0].count === '0' || !purchaseOrders.rows[0].all_approved) {
      throw new FulfillmentConflictException(
        'Every generated purchase order must be approved before packing-driven shipment',
        'PURCHASE_ORDERS_NOT_APPROVED',
      );
    }
  }

  private async packingSource(
    client: PoolClient,
    order: SalesOrderRow,
    dto: CreateShipmentDto,
    boxes: CreateShipmentBoxDto[],
  ): Promise<Record<string, unknown> | null> {
    const hasDocument = dto.packing_list_document_set_id !== undefined;
    const hasVersion = dto.packing_list_version !== undefined;
    if (hasDocument !== hasVersion) {
      throw new InvalidFulfillmentDataException(
        'Packing list document and version must be provided together',
        'PACKING_LIST_SOURCE_INCOMPLETE',
      );
    }
    if (order.fulfillment_locked_snapshot && !hasDocument) {
      throw new FulfillmentConflictException(
        'A locked generated packing list is required for this sales order',
        'PACKING_LIST_SOURCE_REQUIRED',
      );
    }
    if (!hasDocument) return null;
    if (boxes.length === 0) {
      throw new InvalidFulfillmentDataException(
        'Packing-list shipments require box-level input',
        'PACKING_BOXES_REQUIRED',
      );
    }
    const source = await this.packingListSourceDetails(client, order.id);
    if (!source || source.document_set_id !== dto.packing_list_document_set_id) {
      throw new FulfillmentNotFoundException('Packing list source not found');
    }
    if (source.version !== dto.packing_list_version) {
      throw new FulfillmentConflictException(
        'Packing list version changed before shipment creation',
        'PACKING_LIST_VERSION_CONFLICT',
      );
    }
    if (source.source_order_locked !== true) {
      throw new FulfillmentConflictException(
        'Packing list must be synchronized from the locked sales order',
        'PACKING_LIST_SOURCE_NOT_LOCKED',
      );
    }

    const sourcePackages = new Map<string, PackingListPackage>();
    for (const sourcePackage of source.packages) {
      if (sourcePackages.has(sourcePackage.package_no)) {
        throw new FulfillmentConflictException(
          `Packing list package number ${sourcePackage.package_no} is ambiguous`,
          'PACKING_LIST_PACKAGE_AMBIGUOUS',
        );
      }
      sourcePackages.set(sourcePackage.package_no, sourcePackage);
    }
    for (const box of boxes) {
      const packageNo = box.package_no.trim();
      const sourcePackage = sourcePackages.get(packageNo);
      if (!sourcePackage) {
        throw new InvalidFulfillmentDataException(
          `Package ${packageNo} is not present in packing list version ${source.version}`,
          'PACKAGE_NOT_IN_PACKING_LIST',
        );
      }
      const sourceItems = new Map(
        sourcePackage.items.map((item) => [item.sales_order_item_id, item]),
      );
      let expectedNetWeight = 0n;
      let expectedVolume = 0n;
      for (const item of box.items) {
        const sourceItem = sourceItems.get(item.sales_order_item_id);
        if (!sourceItem) {
          throw new InvalidFulfillmentDataException(
            `Sales order item ${item.sales_order_item_id} is not assigned to package ${packageNo}`,
            'PACKAGE_ITEM_MISMATCH',
          );
        }
        if (this.scaled(item.quantity, 3) > this.scaled(sourceItem.quantity, 3)) {
          throw new InvalidFulfillmentDataException(
            `Shipment quantity exceeds packing list quantity for package ${packageNo}`,
            'PACKAGE_QUANTITY_EXCEEDED',
          );
        }
        if (!sourceItem.weight_kg || !sourceItem.volume_cbm) {
          throw new InvalidFulfillmentDataException(
            `Packing measures are missing for sales order item ${item.sales_order_item_id}`,
            'PACKING_MEASURES_MISSING',
          );
        }
        expectedNetWeight += this.scaled(this.measure(item.quantity, sourceItem.weight_kg, 4), 4);
        expectedVolume += this.scaled(this.measure(item.quantity, sourceItem.volume_cbm, 6), 6);
      }
      if (expectedNetWeight !== this.scaled(box.net_weight_kg, 4)) {
        throw new InvalidFulfillmentDataException(
          `Net weight does not match packing list package ${packageNo}`,
          'PACKAGE_NET_WEIGHT_MISMATCH',
        );
      }
      if (expectedVolume !== this.scaled(box.volume_cbm, 6)) {
        throw new InvalidFulfillmentDataException(
          `Volume does not match packing list package ${packageNo}`,
          'PACKAGE_VOLUME_MISMATCH',
        );
      }
    }
    return {
      document_set_id: source.document_set_id,
      document_version: source.version,
      source_order_locked: true,
      source_packages: source.packages,
      boxes: boxes.map((box) => ({
        package_no: box.package_no.trim(),
        gross_weight_kg: box.gross_weight_kg,
        net_weight_kg: box.net_weight_kg,
        volume_cbm: box.volume_cbm,
        items: box.items,
      })),
    };
  }

  async createShipment(actor: FulfillmentActor, orderId: string, dto: CreateShipmentDto) {
    const boxes = this.shipmentBoxes(dto);
    const inputById = this.aggregateShipmentQuantities(dto);
    const itemIds = [...inputById.keys()];
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.salesOrder(client, actor, orderId, true);
      const creationRequest = {
        batch_number: dto.batch_number.trim(),
        carrier: dto.carrier.trim(),
        tracking_number: dto.tracking_number.trim(),
        packing_list_document_set_id: dto.packing_list_document_set_id ?? null,
        packing_list_version: dto.packing_list_version ?? null,
        boxes,
        items: dto.items ?? null,
      };
      const prior = await client.query<{ id: string; sales_order_id: string; same: boolean }>(
        `SELECT id, sales_order_id, creation_request = $2::jsonb AS same
           FROM shipments WHERE idempotency_key = $1`,
        [dto.idempotency_key, JSON.stringify(creationRequest)],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].sales_order_id !== order.id) {
          throw new FulfillmentConflictException(
            'Idempotency key was already used for another sales order',
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        if (!prior.rows[0].same) {
          throw new FulfillmentConflictException(
            'Idempotency key was already used with different shipment input',
            'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
          );
        }
        const replay = await client.query<ShipmentRow>(
          `SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE id = $1`,
          [prior.rows[0].id],
        );
        return this.shipmentResponse(client, replay.rows[0], true);
      }
      const validStatuses = order.fulfillment_locked_snapshot
        ? ['approved', 'procurement', 'fulfillment']
        : ['procurement', 'fulfillment'];
      if (!validStatuses.includes(order.status)) {
        throw new FulfillmentConflictException(
          'The sales order is not ready for fulfillment',
          'SALES_ORDER_NOT_SHIPPABLE',
        );
      }
      await this.assertDirectProcurementApproved(client, order);
      this.validateBoxes(boxes);
      const packingSnapshot = await this.packingSource(client, order, dto, boxes);
      const availableItems = await this.availableItems(client, order.id);
      const selected = availableItems.filter((item) => itemIds.includes(item.id));
      if (selected.length !== itemIds.length) {
        throw new InvalidFulfillmentDataException(
          'Every shipment item must belong to the sales order',
          'SHIPMENT_ITEM_NOT_IN_ORDER',
        );
      }
      for (const item of selected) {
        const allowed = await client.query<{ allowed: boolean }>(
          `SELECT $1::numeric <= $2::numeric AS allowed`,
          [inputById.get(item.id), item.available_quantity],
        );
        if (!allowed.rows[0].allowed) {
          throw new FulfillmentConflictException(
            `Shipment quantity exceeds available quantity for line ${item.line_no}`,
            'SHIPMENT_QUANTITY_EXCEEDED',
          );
        }
      }
      const inserted = await client.query<ShipmentRow>(
        `INSERT INTO shipments
           (tenant_id, sales_order_id, batch_number, carrier, tracking_number,
            idempotency_key, creation_request, packing_list_document_set_id,
            packing_list_version, packing_list_snapshot, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING ${SHIPMENT_COLUMNS}`,
        [
          actor.tenantId,
          order.id,
          creationRequest.batch_number,
          creationRequest.carrier,
          creationRequest.tracking_number,
          dto.idempotency_key,
          JSON.stringify(creationRequest),
          dto.packing_list_document_set_id ?? null,
          dto.packing_list_version ?? null,
          packingSnapshot ? JSON.stringify(packingSnapshot) : null,
          actor.userId,
        ],
      );
      for (const item of selected) {
        await client.query(
          `INSERT INTO shipment_items
             (tenant_id, shipment_id, sales_order_item_id, quantity, available_quantity_snapshot)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            actor.tenantId,
            inserted.rows[0].id,
            item.id,
            inputById.get(item.id),
            item.available_quantity,
          ],
        );
      }
      for (const box of boxes) {
        const insertedBox = await client.query<{ id: string }>(
          `INSERT INTO shipment_boxes
             (tenant_id, shipment_id, package_no, gross_weight_kg, net_weight_kg, volume_cbm)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [
            actor.tenantId,
            inserted.rows[0].id,
            box.package_no.trim(),
            box.gross_weight_kg,
            box.net_weight_kg,
            box.volume_cbm,
          ],
        );
        for (const item of box.items) {
          await client.query(
            `INSERT INTO shipment_box_items
               (tenant_id, shipment_box_id, sales_order_item_id, quantity)
             VALUES ($1,$2,$3,$4)`,
            [actor.tenantId, insertedBox.rows[0].id, item.sales_order_item_id, item.quantity],
          );
        }
      }
      const response = await this.shipmentResponse(client, inserted.rows[0]);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'shipment.created_from_packing_list',
        resourceType: 'shipment',
        resourceId: inserted.rows[0].id,
        after: response,
      });
      await this.recordEvent(
        client,
        actor,
        order,
        'shipment',
        inserted.rows[0].id,
        'shipment.created_from_packing_list',
      );
      await this.syncAggregateStatus(client, order);
      return response;
    });
  }

  async dispatchShipment(actor: FulfillmentActor, shipmentId: string) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.lockSalesOrderByShipment(client, actor, shipmentId);
      const shipmentResult = await client.query<ShipmentRow>(
        `SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE id = $1 FOR UPDATE`,
        [shipmentId],
      );
      const shipment = shipmentResult.rows[0];
      if (!shipment) throw new FulfillmentNotFoundException('Shipment not found');
      if (shipment.status !== 'draft') {
        if (['dispatched', 'in_transit', 'delivered'].includes(shipment.status)) {
          return this.shipmentResponse(client, shipment, true);
        }
        throw new FulfillmentConflictException(
          'Only a draft shipment can be dispatched',
          'SHIPMENT_NOT_DISPATCHABLE',
        );
      }
      const shipmentItems = await client.query<{ sales_order_item_id: string; quantity: string }>(
        `SELECT sales_order_item_id, quantity::text AS quantity
           FROM shipment_items WHERE shipment_id = $1`,
        [shipment.id],
      );
      const availableItems = await this.availableItems(client, order.id);
      const availableById = new Map(availableItems.map((item) => [item.id, item]));
      for (const shipmentItem of shipmentItems.rows) {
        const available = availableById.get(shipmentItem.sales_order_item_id);
        const allowed = await client.query<{ allowed: boolean }>(
          `SELECT $1::numeric <= $2::numeric AS allowed`,
          [shipmentItem.quantity, available?.available_quantity ?? '0'],
        );
        if (!allowed.rows[0].allowed) {
          throw new FulfillmentConflictException(
            'Shipment quantity now exceeds the available accepted quantity',
            'SHIPMENT_QUANTITY_EXCEEDED',
          );
        }
      }
      const updated = await client.query<ShipmentRow>(
        `UPDATE shipments
            SET status = 'dispatched', dispatched_by = $1, dispatched_at = now(), updated_at = now()
          WHERE id = $2 RETURNING ${SHIPMENT_COLUMNS}`,
        [actor.userId, shipment.id],
      );
      await client.query(
        `INSERT INTO logistics_events
           (tenant_id, shipment_id, event_type, description, occurred_at, recorded_by,
            idempotency_key, request_json)
         VALUES ($1,$2,'dispatched','Shipment dispatched',$3,$4,$5,$6)`,
        [
          actor.tenantId,
          shipment.id,
          updated.rows[0].dispatched_at,
          actor.userId,
          `shipment-dispatch:${shipment.id}`,
          JSON.stringify({ shipment_id: shipment.id, action: 'dispatch' }),
        ],
      );
      const expenseCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM order_expenses WHERE shipment_id = $1`,
        [shipment.id],
      );
      if (Number(expenseCount.rows[0].count) === 0) {
        await this.openException(client, actor, {
          order,
          contextType: 'shipment',
          contextId: shipment.id,
          type: 'missing_expense',
          severity: 'medium',
          summary: `Shipment ${shipment.batch_number} was dispatched without an expense record`,
        });
      }
      const response = await this.shipmentResponse(client, updated.rows[0]);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'shipment.dispatched',
        resourceType: 'shipment',
        resourceId: shipment.id,
        before: { status: shipment.status },
        after: { status: 'dispatched', dispatched_at: updated.rows[0].dispatched_at },
      });
      await this.recordEvent(client, actor, order, 'shipment', shipment.id, 'shipment.dispatched');
      await this.syncAggregateStatus(client, order);
      return response;
    });
  }

  async addLogisticsEvent(actor: FulfillmentActor, shipmentId: string, dto: AddLogisticsEventDto) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.lockSalesOrderByShipment(client, actor, shipmentId);
      const requestSnapshot = {
        shipment_id: shipmentId,
        event_type: dto.event_type,
        location: dto.location?.trim() || null,
        description: dto.description?.trim() || null,
        occurred_at: dto.occurred_at,
      };
      const prior = await client.query<{
        id: string;
        shipment_id: string;
        same: boolean;
        event_type: string;
        location: string | null;
        description: string | null;
        occurred_at: Date;
        recorded_by: string;
        created_at: Date;
      }>(
        `SELECT id, shipment_id, request_json = $2::jsonb AS same, event_type, location,
                description, occurred_at, recorded_by, created_at
           FROM logistics_events WHERE idempotency_key = $1`,
        [dto.idempotency_key, JSON.stringify(requestSnapshot)],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].shipment_id !== shipmentId) {
          throw new FulfillmentConflictException(
            'Idempotency key was already used for another shipment',
            'IDEMPOTENCY_KEY_REUSED',
          );
        }
        if (!prior.rows[0].same) {
          throw new FulfillmentConflictException(
            'Idempotency key was already used with different logistics input',
            'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
          );
        }
        return { ...prior.rows[0], same: undefined, idempotent: true };
      }
      const shipment = await client.query<ShipmentRow>(
        `SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE id = $1 FOR UPDATE`,
        [shipmentId],
      );
      if (!shipment.rows[0]) throw new FulfillmentNotFoundException('Shipment not found');
      if (!['dispatched', 'in_transit'].includes(shipment.rows[0].status)) {
        throw new FulfillmentConflictException(
          'Logistics events can only be added to a dispatched or in-transit shipment',
          'SHIPMENT_NOT_TRACKABLE',
        );
      }
      if (dto.event_type === 'in_transit' && shipment.rows[0].status !== 'dispatched') {
        throw new FulfillmentConflictException(
          'Only a dispatched shipment can enter in-transit status',
          'SHIPMENT_NOT_TRANSITABLE',
        );
      }
      if (new Date(dto.occurred_at) < new Date(shipment.rows[0].dispatched_at!)) {
        throw new InvalidFulfillmentDataException(
          'Logistics event time cannot precede dispatch',
          'LOGISTICS_EVENT_BEFORE_DISPATCH',
        );
      }
      const event = await client.query(
        `INSERT INTO logistics_events
           (tenant_id, shipment_id, event_type, location, description, occurred_at, recorded_by,
            idempotency_key, request_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, event_type, location, description, occurred_at, recorded_by, created_at`,
        [
          actor.tenantId,
          shipmentId,
          dto.event_type,
          dto.location?.trim() || null,
          dto.description?.trim() || null,
          dto.occurred_at,
          actor.userId,
          dto.idempotency_key,
          JSON.stringify(requestSnapshot),
        ],
      );
      if (dto.event_type === 'in_transit') {
        await client.query(
          `UPDATE shipments
              SET status = 'in_transit', in_transit_by = $1, in_transit_at = $2,
                  updated_at = now()
            WHERE id = $3`,
          [actor.userId, dto.occurred_at, shipmentId],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'shipment.in_transit',
          resourceType: 'shipment',
          resourceId: shipmentId,
          before: { status: shipment.rows[0].status },
          after: { status: 'in_transit', in_transit_at: dto.occurred_at },
        });
      }
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'shipment.logistics_event_recorded',
        resourceType: 'logistics_event',
        resourceId: event.rows[0].id,
        after: event.rows[0],
      });
      await this.recordEvent(
        client,
        actor,
        order,
        'shipment',
        shipmentId,
        `shipment.${dto.event_type}`,
      );
      return { ...event.rows[0], idempotent: false };
    });
  }

  async deliverShipment(actor: FulfillmentActor, shipmentId: string, dto: DeliverShipmentDto) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.lockSalesOrderByShipment(client, actor, shipmentId);
      const shipment = await client.query<ShipmentRow>(
        `SELECT ${SHIPMENT_COLUMNS} FROM shipments WHERE id = $1 FOR UPDATE`,
        [shipmentId],
      );
      const current = shipment.rows[0];
      if (!current) throw new FulfillmentNotFoundException('Shipment not found');
      if (current.status !== 'in_transit') {
        throw new FulfillmentConflictException(
          'Only an in-transit shipment can be delivered',
          'SHIPMENT_NOT_DELIVERABLE',
        );
      }
      if (new Date(dto.delivered_at) < new Date(current.in_transit_at!)) {
        throw new InvalidFulfillmentDataException(
          'Delivery time cannot precede in-transit time',
          'DELIVERY_BEFORE_IN_TRANSIT',
        );
      }
      const fileIds = [...new Set(dto.attachment_file_ids)];
      if (fileIds.length !== dto.attachment_file_ids.length) {
        throw new InvalidFulfillmentDataException(
          'Delivery attachments must be unique',
          'DUPLICATE_DELIVERY_ATTACHMENT',
        );
      }
      const visibleFiles = await this.files.findManyInScope(
        client,
        {
          userId: actor.userId,
          tenantId: actor.tenantId,
          dataScope: await this.fileScope(actor),
        },
        fileIds,
      );
      if (visibleFiles.length !== fileIds.length) {
        throw new InvalidFulfillmentDataException(
          'Delivery attachment not found in caller file scope',
          'DELIVERY_PROOF_NOT_FOUND',
        );
      }
      const updated = await client.query<ShipmentRow>(
        `UPDATE shipments
            SET status = 'delivered', delivered_by = $1, delivered_at = $2,
                delivery_proof_file_id = $3, delivery_note = $4, received_by_name = $5,
                delivery_exception_note = $6, updated_at = now()
          WHERE id = $7 RETURNING ${SHIPMENT_COLUMNS}`,
        [
          actor.userId,
          dto.delivered_at,
          fileIds[0],
          dto.note?.trim() || null,
          dto.received_by.trim(),
          dto.exception_note?.trim() || null,
          current.id,
        ],
      );
      for (const [index, fileId] of fileIds.entries()) {
        await client.query(
          `INSERT INTO shipment_delivery_files
             (tenant_id, shipment_id, file_id, file_role)
           VALUES ($1,$2,$3,$4)`,
          [
            actor.tenantId,
            current.id,
            fileId,
            index === 0 || !dto.exception_note?.trim() ? 'delivery_proof' : 'exception_evidence',
          ],
        );
      }
      await client.query(
        `INSERT INTO logistics_events
           (tenant_id, shipment_id, event_type, description, occurred_at, recorded_by,
            idempotency_key, request_json)
         VALUES ($1,$2,'delivered',$3,$4,$5,$6,$7)`,
        [
          actor.tenantId,
          current.id,
          dto.note?.trim() || 'Delivery confirmed',
          dto.delivered_at,
          actor.userId,
          `shipment-delivered:${current.id}`,
          JSON.stringify({
            shipment_id: current.id,
            delivered_at: dto.delivered_at,
            received_by: dto.received_by.trim(),
            attachment_file_ids: fileIds,
            note: dto.note?.trim() || null,
            exception_note: dto.exception_note?.trim() || null,
          }),
        ],
      );
      const response = await this.shipmentResponse(client, updated.rows[0]);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'shipment.delivered',
        resourceType: 'shipment',
        resourceId: current.id,
        before: { status: current.status },
        after: {
          status: 'delivered',
          delivered_at: updated.rows[0].delivered_at,
          received_by: dto.received_by.trim(),
          attachment_file_ids: fileIds,
          exception_note: dto.exception_note?.trim() || null,
        },
        reason: dto.exception_note?.trim() || dto.note?.trim() || null,
      });
      await this.recordEvent(client, actor, order, 'shipment', current.id, 'shipment.delivered');
      await this.syncAggregateStatus(client, order);
      return response;
    });
  }

  private validateExpenseFx(dto: RecordOrderExpenseDto): {
    status: 'pending_fx' | 'complete';
    rate: string | null;
    source: string | null;
    capturedAt: string | Date | null;
  } {
    if (dto.currency === 'RMB') {
      if (dto.fx_rate_to_rmb || dto.fx_source || dto.fx_captured_at) {
        throw new InvalidFulfillmentDataException(
          'RMB expenses use the fixed identity conversion and accept no FX override',
          'RMB_FX_OVERRIDE_FORBIDDEN',
        );
      }
      return { status: 'complete', rate: '1', source: 'currency_identity', capturedAt: new Date() };
    }
    const provided = [dto.fx_rate_to_rmb, dto.fx_source, dto.fx_captured_at].filter(Boolean).length;
    if (provided === 0) return { status: 'pending_fx', rate: null, source: null, capturedAt: null };
    if (provided !== 3) {
      throw new InvalidFulfillmentDataException(
        'FX rate, source and capture time must be provided together',
        'EXPENSE_FX_SNAPSHOT_INCOMPLETE',
      );
    }
    return {
      status: 'complete',
      rate: dto.fx_rate_to_rmb!,
      source: dto.fx_source!.trim(),
      capturedAt: dto.fx_captured_at!,
    };
  }

  async recordExpense(actor: FulfillmentActor, orderId: string, dto: RecordOrderExpenseDto) {
    const fx = this.validateExpenseFx(dto);
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.salesOrder(client, actor, orderId, true);
      if (dto.shipment_id) {
        const shipment = await client.query(
          `SELECT id FROM shipments WHERE id = $1 AND sales_order_id = $2`,
          [dto.shipment_id, order.id],
        );
        if (shipment.rows.length === 0) {
          throw new InvalidFulfillmentDataException(
            'Expense shipment must belong to the sales order',
            'EXPENSE_SHIPMENT_NOT_IN_ORDER',
          );
        }
      }
      const amountRmb =
        fx.status === 'complete'
          ? (
              await client.query<{ amount: string }>(
                `SELECT round($1::numeric * $2::numeric, 2)::text AS amount`,
                [dto.amount, fx.rate],
              )
            ).rows[0].amount
          : null;
      const inserted = await client.query<ExpenseRow>(
        `INSERT INTO order_expenses
           (tenant_id, sales_order_id, shipment_id, expense_type, amount, currency,
            fx_rate_to_rmb, fx_source, fx_captured_at, amount_rmb, status, note,
            recorded_by, completed_by, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                 CASE WHEN $11::varchar = 'complete' THEN $13::uuid ELSE NULL END,
                 CASE WHEN $11::varchar = 'complete' THEN now() ELSE NULL END)
         RETURNING ${EXPENSE_COLUMNS}`,
        [
          actor.tenantId,
          order.id,
          dto.shipment_id ?? null,
          dto.expense_type,
          dto.amount,
          dto.currency,
          fx.rate,
          fx.source,
          fx.capturedAt,
          amountRmb,
          fx.status,
          dto.note?.trim() || null,
          actor.userId,
        ],
      );
      if (fx.status === 'pending_fx') {
        await this.openException(client, actor, {
          order,
          contextType: dto.shipment_id ? 'shipment' : 'sales_order',
          contextId: dto.shipment_id ?? order.id,
          type: 'missing_expense',
          severity: 'high',
          summary: `${dto.currency} ${dto.amount} ${dto.expense_type} expense is missing an RMB FX snapshot`,
        });
      }
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: `order_expense.${fx.status === 'complete' ? 'recorded' : 'pending_fx'}`,
        resourceType: 'order_expense',
        resourceId: inserted.rows[0].id,
        after: inserted.rows[0],
      });
      await this.recordEvent(
        client,
        actor,
        order,
        'order_expense',
        inserted.rows[0].id,
        `order_expense.${fx.status === 'complete' ? 'recorded' : 'pending_fx'}`,
      );
      return inserted.rows[0];
    });
  }

  async completeExpenseFx(actor: FulfillmentActor, expenseId: string, dto: CompleteExpenseFxDto) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const linked = await client.query<{ sales_order_id: string }>(
        `SELECT sales_order_id FROM order_expenses WHERE id = $1`,
        [expenseId],
      );
      if (!linked.rows[0]) throw new FulfillmentNotFoundException('Order expense not found');
      const order = await this.salesOrder(client, actor, linked.rows[0].sales_order_id, true);
      const expenseResult = await client.query<ExpenseRow>(
        `SELECT ${EXPENSE_COLUMNS} FROM order_expenses WHERE id = $1 FOR UPDATE`,
        [expenseId],
      );
      const expense = expenseResult.rows[0];
      if (!expense) throw new FulfillmentNotFoundException('Order expense not found');
      if (expense.status !== 'pending_fx') {
        throw new FulfillmentConflictException(
          'Completed expense FX snapshots cannot be changed',
          'EXPENSE_FX_ALREADY_FROZEN',
        );
      }
      const amountRmb = await client.query<{ amount: string }>(
        `SELECT round($1::numeric * $2::numeric, 2)::text AS amount`,
        [expense.amount, dto.fx_rate_to_rmb],
      );
      const updated = await client.query<ExpenseRow>(
        `UPDATE order_expenses
            SET fx_rate_to_rmb = $1, fx_source = $2, fx_captured_at = $3,
                amount_rmb = $4, status = 'complete', completed_by = $5, completed_at = now()
          WHERE id = $6 RETURNING ${EXPENSE_COLUMNS}`,
        [
          dto.fx_rate_to_rmb,
          dto.fx_source.trim(),
          dto.fx_captured_at,
          amountRmb.rows[0].amount,
          actor.userId,
          expense.id,
        ],
      );
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'order_expense.fx_completed',
        resourceType: 'order_expense',
        resourceId: expense.id,
        before: { status: expense.status, amount: expense.amount, currency: expense.currency },
        after: updated.rows[0],
      });
      await this.recordEvent(
        client,
        actor,
        order,
        'order_expense',
        expense.id,
        'order_expense.fx_completed',
      );
      return updated.rows[0];
    });
  }

  async linkCustomerReceipt(
    actor: FulfillmentActor,
    shipmentId: string,
    dto: LinkShipmentReceiptDto,
  ) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const order = await this.lockSalesOrderByShipment(client, actor, shipmentId);
      const receipt = await client.query<{
        id: string;
        amount: string;
        currency: string;
        received_at: string;
        status: string;
      }>(
        `SELECT receipt.id, receipt.amount::text AS amount, receipt.currency,
                receipt.received_at, COALESCE(decision.decision, 'recorded') AS status
           FROM customer_receipts receipt
           LEFT JOIN customer_receipt_decisions decision
             ON decision.receipt_id = receipt.id AND decision.tenant_id = receipt.tenant_id
          WHERE receipt.id = $1 AND receipt.sales_order_id = $2
            AND COALESCE(decision.decision, 'recorded') IN ('recorded', 'confirmed')`,
        [dto.customer_receipt_id, order.id],
      );
      if (!receipt.rows[0]) {
        throw new InvalidFulfillmentDataException(
          'Customer receipt must be an active receipt for the shipment sales order',
          'CUSTOMER_RECEIPT_NOT_LINKABLE',
        );
      }
      const linked = await client.query(
        `INSERT INTO shipment_customer_receipts
           (tenant_id, shipment_id, customer_receipt_id, linked_by)
         VALUES ($1,$2,$3,$4)
         RETURNING id, shipment_id, customer_receipt_id, linked_by, linked_at`,
        [actor.tenantId, shipmentId, receipt.rows[0].id, actor.userId],
      );
      const response = { ...linked.rows[0], ...receipt.rows[0] };
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'shipment.customer_receipt_linked',
        resourceType: 'shipment_customer_receipt',
        resourceId: linked.rows[0].id,
        after: response,
      });
      await this.recordEvent(
        client,
        actor,
        order,
        'shipment',
        shipmentId,
        'shipment.customer_receipt_linked',
      );
      return response;
    });
  }
}
