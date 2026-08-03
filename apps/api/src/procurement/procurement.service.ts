import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { BusinessEventsService } from '../workbench/business-events.service';
import {
  CreateProcurementRequestDto,
  DecideProcurementRequestDto,
  PlacePurchaseOrderDto,
  UpdateProcurementApprovalConfigDto,
  WithdrawProcurementRequestDto,
} from './dto/procurement.dto';
import {
  InvalidProcurementDataException,
  ProcurementConflictException,
  ProcurementDutyException,
  ProcurementResourceNotFoundException,
} from './procurement.errors';

export interface ProcurementActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

interface ApprovalConfigRow {
  id: string;
  version: number;
  is_active: boolean;
  price_variance_threshold_bps: number;
  created_by: string;
  created_at: Date;
}

export interface ApprovalConfigStepRow {
  id: string;
  step_no: number;
  approver_user_id: string;
  approver_name: string;
  approver_email: string;
}

interface SalesOrderContext {
  id: string;
  source_pi_id: string;
  owner_user_id: string;
  pi_number: string | null;
  status: string;
}

interface GateRow {
  id: string;
  status: string;
  created_at: Date;
}

interface RequestRow {
  id: string;
  sales_order_id: string;
  request_number: string;
  requested_by: string;
  approval_config_id: string;
  approval_config_version: number;
  gate_evaluation_id: string;
  gate_status: string;
  price_variance_threshold_bps: number;
  status: string;
  note: string | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SourceItemRow {
  proforma_invoice_item_id: string;
  sales_order_item_id: string;
  selection_id: string;
  line_no: number;
  description: string;
  maximum_quantity: string;
  unit: string;
  supplier_id: string;
  currency: string;
  expected_unit_price: string;
  selection_snapshot: Record<string, unknown>;
}

interface RequestItemRow {
  id: string;
  request_id: string;
  sales_order_item_id: string;
  proforma_invoice_item_id: string;
  selection_id: string;
  supplier_id: string;
  line_no: number;
  description: string;
  quantity: string;
  unit: string;
  currency: string;
  expected_unit_price: string;
  expected_line_total: string;
  selection_snapshot: Record<string, unknown>;
  created_at: Date;
}

interface RequestStepRow {
  id: string;
  step_no: number;
  approver_user_id: string;
  decision: string | null;
  decided_by: string | null;
  reason: string | null;
  decided_at: Date | null;
}

interface GeneratedOrderRow {
  id: string;
  supplier_id: string;
  owner_user_id: string;
  order_number: string;
  pi_number: string | null;
  currency: string;
  total_amount: string;
  status: string;
  source_procurement_request_id: string;
  expected_total_amount: string;
  final_total_amount: string | null;
  placed_by: string | null;
  placed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GeneratedOrderItemRow {
  id: string;
  line_no: number;
  description: string;
  unit: string | null;
  quantity: string;
  expected_unit_price: string;
  final_unit_price: string | null;
  expected_line_total: string;
  final_line_total: string | null;
  price_variance_amount: string | null;
  price_variance_bps: number | null;
  price_variance_status: string | null;
  price_variance_threshold_bps: number;
  price_finalized_at: Date | null;
  source_procurement_request_item_id: string;
}

interface PriceCalculation {
  final_line_total: string;
  variance_amount: string;
  variance_bps: number | null;
  variance_status: 'within_tolerance' | 'exception';
}

const REQUEST_COLUMNS = `id, sales_order_id, request_number, requested_by,
  approval_config_id, approval_config_version, gate_evaluation_id, gate_status,
  price_variance_threshold_bps, status, note, completed_at, created_at, updated_at`;
const REQUEST_ITEM_COLUMNS = `id, request_id, sales_order_item_id,
  proforma_invoice_item_id, selection_id, supplier_id, line_no, description,
  quantity::text AS quantity, unit, currency,
  expected_unit_price::text AS expected_unit_price,
  expected_line_total::text AS expected_line_total, selection_snapshot, created_at`;
const ORDER_COLUMNS = `id, supplier_id, owner_user_id, order_number, pi_number,
  currency, total_amount::text AS total_amount, status, source_procurement_request_id,
  expected_total_amount::text AS expected_total_amount,
  final_total_amount::text AS final_total_amount, placed_by, placed_at, created_at, updated_at`;
const QUALIFIED_ORDER_COLUMNS = `po.id, po.supplier_id, po.owner_user_id, po.order_number,
  po.pi_number, po.currency, po.total_amount::text AS total_amount, po.status,
  po.source_procurement_request_id,
  po.expected_total_amount::text AS expected_total_amount,
  po.final_total_amount::text AS final_total_amount, po.placed_by, po.placed_at,
  po.created_at, po.updated_at`;
const ORDER_ITEM_COLUMNS = `id, line_no, description, unit,
  quantity::text AS quantity, expected_unit_price::text AS expected_unit_price,
  final_unit_price::text AS final_unit_price,
  expected_line_total::text AS expected_line_total,
  final_line_total::text AS final_line_total,
  price_variance_amount::text AS price_variance_amount, price_variance_bps,
  price_variance_status, price_variance_threshold_bps, price_finalized_at,
  source_procurement_request_item_id`;

@Injectable()
export class ProcurementService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly events: BusinessEventsService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private assertAllScope(actor: ProcurementActor): void {
    if (actor.dataScope !== 'all') {
      throw new ProcurementDutyException(
        'This procurement action requires an all-scope permission grant',
        'PROCUREMENT_ALL_SCOPE_REQUIRED',
      );
    }
  }

  private async configSteps(
    client: PoolClient,
    configId: string,
  ): Promise<ApprovalConfigStepRow[]> {
    const result = await client.query<ApprovalConfigStepRow>(
      `SELECT s.id, s.step_no, s.approver_user_id,
              u.name AS approver_name, u.email AS approver_email
         FROM procurement_approval_config_steps s
         JOIN users u ON u.id = s.approver_user_id AND u.tenant_id = s.tenant_id
        WHERE s.config_id = $1
        ORDER BY s.step_no`,
      [configId],
    );
    return result.rows;
  }

  private async configResponse(client: PoolClient, row: ApprovalConfigRow) {
    return {
      id: row.id,
      version: row.version,
      is_active: row.is_active,
      price_variance_threshold_bps: row.price_variance_threshold_bps,
      created_by: row.created_by,
      created_at: row.created_at,
      steps: await this.configSteps(client, row.id),
    };
  }

  async getApprovalConfig(actor: ProcurementActor) {
    this.assertAllScope(actor);
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const result = await client.query<ApprovalConfigRow>(
          `SELECT id, version, is_active, price_variance_threshold_bps, created_by, created_at
             FROM procurement_approval_configs
            WHERE is_active = true`,
        );
        if (result.rows.length === 0) {
          throw new ProcurementResourceNotFoundException(
            'Active procurement approval config not found',
          );
        }
        return this.configResponse(client, result.rows[0]);
      },
    );
  }

  async updateApprovalConfig(actor: ProcurementActor, dto: UpdateProcurementApprovalConfigDto) {
    this.assertAllScope(actor);
    const approverIds = dto.steps.map((step) => step.approver_user_id);
    if (new Set(approverIds).size !== approverIds.length) {
      throw new InvalidProcurementDataException(
        'Each approval step must use a different approver',
        'DUPLICATE_PROCUREMENT_APPROVER',
      );
    }
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const users = await client.query<{ id: string }>(
          `SELECT id FROM users
            WHERE id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL`,
          [approverIds],
        );
        if (users.rows.length !== approverIds.length) {
          throw new InvalidProcurementDataException(
            'Every approver must be an active user in this tenant',
            'PROCUREMENT_APPROVER_NOT_FOUND',
          );
        }
        const active = await client.query<ApprovalConfigRow>(
          `SELECT id, version, is_active, price_variance_threshold_bps, created_by, created_at
             FROM procurement_approval_configs
            WHERE is_active = true
            FOR UPDATE`,
        );
        if (active.rows.length > 0) {
          await client.query(
            `UPDATE procurement_approval_configs SET is_active = false WHERE id = $1`,
            [active.rows[0].id],
          );
        }
        const inserted = await client.query<ApprovalConfigRow>(
          `INSERT INTO procurement_approval_configs
             (tenant_id, version, price_variance_threshold_bps, created_by)
           SELECT $1, COALESCE(max(version), 0) + 1, $2, $3
             FROM procurement_approval_configs
            WHERE tenant_id = $1
           RETURNING id, version, is_active, price_variance_threshold_bps, created_by, created_at`,
          [actor.tenantId, dto.price_variance_threshold_bps, actor.userId],
        );
        for (const [index, approverId] of approverIds.entries()) {
          await client.query(
            `INSERT INTO procurement_approval_config_steps
               (tenant_id, config_id, step_no, approver_user_id)
             VALUES ($1,$2,$3,$4)`,
            [actor.tenantId, inserted.rows[0].id, index + 1, approverId],
          );
        }
        const response = await this.configResponse(client, inserted.rows[0]);
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'procurement_approval_config.activated',
          resourceType: 'procurement_approval_config',
          resourceId: inserted.rows[0].id,
          before: active.rows[0]
            ? { id: active.rows[0].id, version: active.rows[0].version, is_active: true }
            : undefined,
          after: response,
        });
        return response;
      },
    );
  }

  private async salesOrder(
    client: PoolClient,
    actor: ProcurementActor,
    orderId: string,
    lock = false,
  ): Promise<SalesOrderContext> {
    const params: unknown[] = [orderId];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND owner_user_id = $${params.length}`;
    }
    const result = await client.query<SalesOrderContext>(
      `SELECT id, source_pi_id, owner_user_id, pi_number, status
         FROM sales_orders
        WHERE id = $1 AND source_pi_id IS NOT NULL AND deleted_at IS NULL${scope}
        ${lock ? 'FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new ProcurementResourceNotFoundException('PI-backed sales order not found');
    }
    return result.rows[0];
  }

  private async latestOpenGate(client: PoolClient, orderId: string): Promise<GateRow> {
    const result = await client.query<GateRow>(
      `SELECT id, status, created_at
         FROM procurement_gate_evaluations
        WHERE sales_order_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [orderId],
    );
    const gate = result.rows[0];
    if (!gate || !['open', 'bypassed'].includes(gate.status)) {
      throw new ProcurementConflictException(
        'The latest procurement gate evaluation is not open',
        'PROCUREMENT_GATE_CLOSED',
      );
    }
    return gate;
  }

  private async activeConfig(client: PoolClient): Promise<ApprovalConfigRow> {
    const result = await client.query<ApprovalConfigRow>(
      `SELECT id, version, is_active, price_variance_threshold_bps, created_by, created_at
         FROM procurement_approval_configs
        WHERE is_active = true
        FOR UPDATE`,
    );
    if (result.rows.length === 0) {
      throw new ProcurementConflictException(
        'Configure a procurement approval flow before creating requests',
        'PROCUREMENT_APPROVAL_CONFIG_REQUIRED',
      );
    }
    return result.rows[0];
  }

  private async sourceItems(
    client: PoolClient,
    order: SalesOrderContext,
    selectionIds: string[],
  ): Promise<SourceItemRow[]> {
    const result = await client.query<SourceItemRow>(
      `SELECT pi_item.id AS proforma_invoice_item_id,
              order_item.id AS sales_order_item_id,
              pi_item.selection_id, pi_item.line_no, pi_item.description,
              pi_item.quantity::text AS maximum_quantity, pi_item.unit,
              supplier.id AS supplier_id,
              pi_item.selection_snapshot->>'currency' AS currency,
              (pi_item.selection_snapshot #>> '{line,unit_price}')::numeric::text
                AS expected_unit_price,
              pi_item.selection_snapshot
         FROM proforma_invoice_items pi_item
         JOIN sales_order_items order_item
           ON order_item.order_id = $1
          AND order_item.line_no = pi_item.line_no
          AND order_item.tenant_id = pi_item.tenant_id
          AND order_item.deleted_at IS NULL
         JOIN suppliers supplier
           ON supplier.id = (pi_item.selection_snapshot->>'supplier_id')::uuid
          AND supplier.tenant_id = pi_item.tenant_id
          AND supplier.deleted_at IS NULL
        WHERE pi_item.proforma_invoice_id = $2
          AND pi_item.selection_id = ANY($3::uuid[])
        ORDER BY pi_item.line_no`,
      [order.id, order.source_pi_id, selectionIds],
    );
    return result.rows;
  }

  async createRequest(
    actor: ProcurementActor,
    salesOrderId: string,
    dto: CreateProcurementRequestDto,
  ) {
    const selectionIds = dto.items.map((item) => item.selection_id);
    if (new Set(selectionIds).size !== selectionIds.length) {
      throw new InvalidProcurementDataException(
        'A selection can appear only once in a procurement request',
        'DUPLICATE_PROCUREMENT_SELECTION',
      );
    }
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const order = await this.salesOrder(client, actor, salesOrderId, true);
        const gate = await this.latestOpenGate(client, order.id);
        const config = await this.activeConfig(client);
        const configSteps = await this.configSteps(client, config.id);
        if (configSteps.length === 0) {
          throw new ProcurementConflictException(
            'The active procurement approval flow has no steps',
            'PROCUREMENT_APPROVAL_STEPS_REQUIRED',
          );
        }
        if (configSteps.some((step) => step.approver_user_id === actor.userId)) {
          throw new ProcurementDutyException(
            'A requester cannot be assigned as an approver on the same frozen flow',
            'PROCUREMENT_REQUESTER_APPROVER_CONFLICT',
          );
        }
        const sourceItems = await this.sourceItems(client, order, selectionIds);
        if (sourceItems.length !== selectionIds.length) {
          throw new InvalidProcurementDataException(
            'Every requested selection must belong to the sales order PI',
            'PROCUREMENT_SELECTION_NOT_IN_ORDER',
          );
        }
        const requestedBefore = await client.query<{ selection_id: string; quantity: string }>(
          `SELECT item.selection_id, sum(item.quantity)::text AS quantity
             FROM procurement_request_items item
             JOIN procurement_requests request
               ON request.id = item.request_id AND request.tenant_id = item.tenant_id
            WHERE request.sales_order_id = $1
              AND request.status NOT IN ('rejected', 'withdrawn')
              AND item.selection_id = ANY($2::uuid[])
            GROUP BY item.selection_id`,
          [order.id, selectionIds],
        );
        const previousBySelection = new Map(
          requestedBefore.rows.map((row) => [row.selection_id, row.quantity]),
        );
        const inputBySelection = new Map(
          dto.items.map((item) => [item.selection_id, item.quantity]),
        );
        for (const item of sourceItems) {
          const comparison = await client.query<{ allowed: boolean }>(
            `SELECT COALESCE($1::numeric, 0) + $2::numeric <= $3::numeric AS allowed`,
            [
              previousBySelection.get(item.selection_id) ?? '0',
              inputBySelection.get(item.selection_id),
              item.maximum_quantity,
            ],
          );
          if (!comparison.rows[0].allowed) {
            throw new ProcurementConflictException(
              'Requested quantity exceeds the unallocated sales-order quantity',
              'PROCUREMENT_QUANTITY_EXCEEDED',
            );
          }
        }
        const identity = await client.query<{ id: string; request_number: string }>(
          `SELECT generated.id,
                  'PR-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
                    || upper(substr(replace(generated.id::text, '-', ''), 1, 8)) AS request_number
             FROM (SELECT uuid_generate_v4() AS id) generated`,
        );
        const inserted = await client.query<RequestRow>(
          `INSERT INTO procurement_requests
             (id, tenant_id, sales_order_id, request_number, requested_by,
              approval_config_id, approval_config_version, gate_evaluation_id, gate_status,
              price_variance_threshold_bps, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${REQUEST_COLUMNS}`,
          [
            identity.rows[0].id,
            actor.tenantId,
            order.id,
            identity.rows[0].request_number,
            actor.userId,
            config.id,
            config.version,
            gate.id,
            gate.status,
            config.price_variance_threshold_bps,
            dto.note?.trim() || null,
          ],
        );
        for (const item of sourceItems) {
          const quantity = inputBySelection.get(item.selection_id)!;
          await client.query(
            `INSERT INTO procurement_request_items
               (tenant_id, request_id, sales_order_item_id, proforma_invoice_item_id,
                selection_id, supplier_id, line_no, description, quantity, unit, currency,
                expected_unit_price, expected_line_total, selection_snapshot)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                     round($9::numeric * $12::numeric, 2),$13)`,
            [
              actor.tenantId,
              inserted.rows[0].id,
              item.sales_order_item_id,
              item.proforma_invoice_item_id,
              item.selection_id,
              item.supplier_id,
              item.line_no,
              item.description,
              quantity,
              item.unit,
              item.currency,
              item.expected_unit_price,
              JSON.stringify(item.selection_snapshot),
            ],
          );
        }
        await client.query(
          `INSERT INTO procurement_request_approval_steps
             (tenant_id, request_id, config_step_id, step_no, approver_user_id)
           SELECT tenant_id, $1, id, step_no, approver_user_id
             FROM procurement_approval_config_steps
            WHERE config_id = $2
            ORDER BY step_no`,
          [inserted.rows[0].id, config.id],
        );
        if (order.status === 'payment_gate_open') {
          await client.query(
            `UPDATE sales_orders SET status = 'procurement', updated_at = now() WHERE id = $1`,
            [order.id],
          );
        }
        const auditResponse = await this.requestResponse(client, inserted.rows[0], true);
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'procurement_request.created',
          resourceType: 'procurement_request',
          resourceId: inserted.rows[0].id,
          after: auditResponse,
          metadata: { gate_evaluation_id: gate.id, approval_config_id: config.id },
        });
        await this.recordEvent(
          client,
          actor,
          order.id,
          inserted.rows[0].id,
          'procurement_request.created',
          actor.userId,
        );
        return this.requestResponse(client, inserted.rows[0], actor.dataScope === 'all');
      },
    );
  }

  private async requestById(
    client: PoolClient,
    actor: ProcurementActor,
    requestId: string,
    lock = false,
    bypassOwnerScope = false,
  ): Promise<RequestRow> {
    const params: unknown[] = [requestId];
    let scope = '';
    if (!bypassOwnerScope && this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND requested_by = $${params.length}`;
    }
    const result = await client.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS}
         FROM procurement_requests
        WHERE id = $1${scope}${lock ? ' FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new ProcurementResourceNotFoundException('Procurement request not found');
    }
    return result.rows[0];
  }

  private async requestResponse(
    client: PoolClient,
    request: RequestRow,
    includeSupplierIdentity: boolean,
  ) {
    const items = await client.query<RequestItemRow>(
      `SELECT ${REQUEST_ITEM_COLUMNS}
         FROM procurement_request_items
        WHERE request_id = $1
        ORDER BY line_no`,
      [request.id],
    );
    const steps = await client.query<RequestStepRow>(
      `SELECT step.id, step.step_no, step.approver_user_id,
              decision.decision, decision.decided_by, decision.reason,
              decision.created_at AS decided_at
         FROM procurement_request_approval_steps step
         LEFT JOIN procurement_request_decisions decision
           ON decision.approval_step_id = step.id AND decision.tenant_id = step.tenant_id
        WHERE step.request_id = $1
        ORDER BY step.step_no`,
      [request.id],
    );
    const orders = await client.query<GeneratedOrderRow>(
      `SELECT ${ORDER_COLUMNS}
         FROM purchase_orders
        WHERE source_procurement_request_id = $1 AND deleted_at IS NULL
        ORDER BY order_number, id`,
      [request.id],
    );
    const currentStep = steps.rows.find((step) => !step.decision)?.step_no ?? null;
    return {
      id: request.id,
      sales_order_id: request.sales_order_id,
      request_number: request.request_number,
      requested_by: request.requested_by,
      status: request.status,
      note: request.note,
      approval_config: {
        id: request.approval_config_id,
        version: request.approval_config_version,
        price_variance_threshold_bps: request.price_variance_threshold_bps,
      },
      procurement_gate: {
        evaluation_id: request.gate_evaluation_id,
        status: request.gate_status,
      },
      current_approval_step: request.status === 'pending_approval' ? currentStep : null,
      items: items.rows.map((item) => ({
        id: item.id,
        sales_order_item_id: item.sales_order_item_id,
        selection_id: item.selection_id,
        line_no: item.line_no,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        currency: item.currency,
        expected_unit_price: item.expected_unit_price,
        expected_line_total: item.expected_line_total,
        ...(includeSupplierIdentity ? { supplier_id: item.supplier_id } : {}),
      })),
      approval_steps: steps.rows.map((step) => ({
        step_no: step.step_no,
        status:
          step.decision ??
          (request.status === 'pending_approval' && step.step_no === currentStep
            ? 'current'
            : 'waiting'),
        ...(includeSupplierIdentity
          ? {
              approver_user_id: step.approver_user_id,
              decided_by: step.decided_by,
              reason: step.reason,
              decided_at: step.decided_at,
            }
          : { decided_at: step.decided_at }),
      })),
      purchase_orders: orders.rows.map((order) => ({
        id: order.id,
        order_number: order.order_number,
        currency: order.currency,
        expected_total_amount: order.expected_total_amount,
        final_total_amount: order.final_total_amount,
        status: order.status,
        placed_at: order.placed_at,
        ...(includeSupplierIdentity ? { supplier_id: order.supplier_id } : {}),
      })),
      completed_at: request.completed_at,
      created_at: request.created_at,
      updated_at: request.updated_at,
    };
  }

  async listRequests(actor: ProcurementActor, salesOrderId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.salesOrder(client, actor, salesOrderId);
        const params: unknown[] = [salesOrderId];
        let scope = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scope = ` AND requested_by = $${params.length}`;
        }
        const rows = await client.query<RequestRow>(
          `SELECT ${REQUEST_COLUMNS}
             FROM procurement_requests
            WHERE sales_order_id = $1${scope}
            ORDER BY created_at DESC, id DESC`,
          params,
        );
        return Promise.all(
          rows.rows.map((row) => this.requestResponse(client, row, actor.dataScope === 'all')),
        );
      },
    );
  }

  async getRequest(actor: ProcurementActor, requestId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.requestById(client, actor, requestId);
        return this.requestResponse(client, row, actor.dataScope === 'all');
      },
    );
  }

  async decideRequest(
    actor: ProcurementActor,
    requestId: string,
    dto: DecideProcurementRequestDto,
  ) {
    this.assertAllScope(actor);
    const reason = dto.reason?.trim() || null;
    if (dto.decision === 'rejected' && !reason) {
      throw new InvalidProcurementDataException(
        'A rejection reason is required',
        'PROCUREMENT_REJECTION_REASON_REQUIRED',
      );
    }
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const request = await this.requestById(client, actor, requestId, true, true);
        if (request.status !== 'pending_approval') {
          throw new ProcurementConflictException(
            'Only a pending procurement request can receive a decision',
            'PROCUREMENT_REQUEST_NOT_PENDING',
          );
        }
        if (request.requested_by === actor.userId) {
          throw new ProcurementDutyException(
            'The requester cannot approve or reject the same request',
            'PROCUREMENT_SELF_APPROVAL_FORBIDDEN',
          );
        }
        const current = await client.query<{
          id: string;
          step_no: number;
          approver_user_id: string;
        }>(
          `SELECT step.id, step.step_no, step.approver_user_id
             FROM procurement_request_approval_steps step
             LEFT JOIN procurement_request_decisions decision
               ON decision.approval_step_id = step.id AND decision.tenant_id = step.tenant_id
            WHERE step.request_id = $1 AND decision.id IS NULL
            ORDER BY step.step_no
            LIMIT 1`,
          [request.id],
        );
        const step = current.rows[0];
        if (!step) {
          throw new ProcurementConflictException(
            'All frozen approval steps already have decisions',
            'PROCUREMENT_APPROVAL_ALREADY_COMPLETE',
          );
        }
        if (step.approver_user_id !== actor.userId) {
          throw new ProcurementDutyException(
            'Only the approver assigned to the current frozen step may decide',
            'PROCUREMENT_WRONG_APPROVER',
          );
        }
        const decision = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO procurement_request_decisions
             (tenant_id, request_id, approval_step_id, step_no, decision, decided_by, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, created_at`,
          [actor.tenantId, request.id, step.id, step.step_no, dto.decision, actor.userId, reason],
        );
        let finalized = false;
        if (dto.decision === 'rejected') {
          await client.query(
            `UPDATE procurement_requests
                SET status = 'rejected', completed_at = now(), updated_at = now()
              WHERE id = $1`,
            [request.id],
          );
          finalized = true;
        } else {
          const remaining = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM procurement_request_approval_steps step
               LEFT JOIN procurement_request_decisions decision
                 ON decision.approval_step_id = step.id AND decision.tenant_id = step.tenant_id
              WHERE step.request_id = $1 AND decision.id IS NULL`,
            [request.id],
          );
          if (remaining.rows[0].count === '0') {
            await client.query(
              `UPDATE procurement_requests
                  SET status = 'approved', completed_at = now(), updated_at = now()
                WHERE id = $1`,
              [request.id],
            );
            await this.splitApprovedRequest(client, actor, request);
            finalized = true;
          }
        }
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: `procurement_request.${dto.decision}`,
          resourceType: 'procurement_request_decision',
          resourceId: decision.rows[0].id,
          after: {
            request_id: request.id,
            approval_config_id: request.approval_config_id,
            approval_config_version: request.approval_config_version,
            step_no: step.step_no,
            decision: dto.decision,
            decided_by: actor.userId,
            reason,
            decided_at: decision.rows[0].created_at,
          },
          reason,
        });
        await this.recordEvent(
          client,
          actor,
          request.sales_order_id,
          decision.rows[0].id,
          `procurement_request.${dto.decision}`,
          request.requested_by,
        );
        const after = await this.requestById(client, actor, request.id, false, true);
        if (finalized) {
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: `procurement_request.${after.status}`,
            resourceType: 'procurement_request',
            resourceId: request.id,
            before: { status: request.status },
            after: { status: after.status, completed_at: after.completed_at },
            reason,
          });
        }
        return this.requestResponse(client, after, true);
      },
    );
  }

  private async splitApprovedRequest(
    client: PoolClient,
    actor: ProcurementActor,
    request: RequestRow,
  ): Promise<void> {
    const items = await client.query<RequestItemRow>(
      `SELECT ${REQUEST_ITEM_COLUMNS}
         FROM procurement_request_items
        WHERE request_id = $1
        ORDER BY supplier_id, currency, line_no`,
      [request.id],
    );
    const orderContext = await client.query<{ pi_number: string | null }>(
      `SELECT pi_number FROM sales_orders WHERE id = $1`,
      [request.sales_order_id],
    );
    const groups = new Map<string, RequestItemRow[]>();
    for (const item of items.rows) {
      const key = `${item.supplier_id}:${item.currency}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const group of groups.values()) {
      const totals = await client.query<{ total: string }>(
        `SELECT sum(value::numeric)::text AS total
           FROM unnest($1::text[]) AS totals(value)`,
        [group.map((item) => item.expected_line_total)],
      );
      const identity = await client.query<{ id: string; order_number: string }>(
        `SELECT generated.id,
                'PO-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
                  || upper(substr(replace(generated.id::text, '-', ''), 1, 8)) AS order_number
           FROM (SELECT uuid_generate_v4() AS id) generated`,
      );
      const inserted = await client.query<GeneratedOrderRow>(
        `INSERT INTO purchase_orders
           (id, tenant_id, supplier_id, owner_user_id, order_number, pi_number,
            currency, total_amount, status, notes, source_procurement_request_id,
            expected_total_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved',$9,$10,$8)
         RETURNING ${ORDER_COLUMNS}`,
        [
          identity.rows[0].id,
          actor.tenantId,
          group[0].supplier_id,
          request.requested_by,
          identity.rows[0].order_number,
          orderContext.rows[0]?.pi_number ?? null,
          group[0].currency,
          totals.rows[0].total,
          `Generated from ${request.request_number}`,
          request.id,
        ],
      );
      await client.query(
        `INSERT INTO sales_order_purchase_orders
           (tenant_id, sales_order_id, purchase_order_id, procurement_request_id)
         VALUES ($1,$2,$3,$4)`,
        [actor.tenantId, request.sales_order_id, inserted.rows[0].id, request.id],
      );
      for (const [index, item] of group.entries()) {
        await client.query(
          `INSERT INTO purchase_order_items
             (tenant_id, order_id, line_no, description, unit, quantity, unit_price,
              line_total, source_procurement_request_item_id, selection_id,
              expected_unit_price, expected_line_total, price_variance_threshold_bps,
              pricing_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$7,$8,$11,$12)`,
          [
            actor.tenantId,
            inserted.rows[0].id,
            index + 1,
            item.description,
            item.unit,
            item.quantity,
            item.expected_unit_price,
            item.expected_line_total,
            item.id,
            item.selection_id,
            request.price_variance_threshold_bps,
            JSON.stringify({
              formula_version: 'purchase_price_variance_bps_v1',
              procurement_request_id: request.id,
              procurement_request_item_id: item.id,
              selection_id: item.selection_id,
              expected_unit_price: item.expected_unit_price,
              expected_line_total: item.expected_line_total,
              quantity: item.quantity,
              currency: item.currency,
            }),
          ],
        );
      }
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'purchase_order.generated_from_procurement_request',
        resourceType: 'purchase_order',
        resourceId: inserted.rows[0].id,
        after: {
          procurement_request_id: request.id,
          supplier_id: group[0].supplier_id,
          currency: group[0].currency,
          expected_total_amount: totals.rows[0].total,
          item_count: group.length,
          status: 'approved',
        },
      });
      await this.recordEvent(
        client,
        actor,
        request.sales_order_id,
        inserted.rows[0].id,
        'purchase_order.generated',
        request.requested_by,
      );
    }
  }

  async withdrawRequest(
    actor: ProcurementActor,
    requestId: string,
    dto: WithdrawProcurementRequestDto,
  ) {
    const reason = dto.reason.trim();
    if (!reason) {
      throw new InvalidProcurementDataException('A withdrawal reason is required');
    }
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const request = await this.requestById(client, actor, requestId, true);
        if (request.requested_by !== actor.userId || request.status !== 'pending_approval') {
          throw new ProcurementConflictException(
            'Only the requester can withdraw a pending procurement request',
            'PROCUREMENT_REQUEST_NOT_WITHDRAWABLE',
          );
        }
        const updated = await client.query<RequestRow>(
          `UPDATE procurement_requests
              SET status = 'withdrawn', completed_at = now(), updated_at = now()
            WHERE id = $1
            RETURNING ${REQUEST_COLUMNS}`,
          [request.id],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'procurement_request.withdrawn',
          resourceType: 'procurement_request',
          resourceId: request.id,
          before: { status: request.status },
          after: { status: 'withdrawn', completed_at: updated.rows[0].completed_at },
          reason,
        });
        await this.recordEvent(
          client,
          actor,
          request.sales_order_id,
          request.id,
          'procurement_request.withdrawn',
          request.requested_by,
        );
        return this.requestResponse(client, updated.rows[0], actor.dataScope === 'all');
      },
    );
  }

  private async generatedOrderItems(
    client: PoolClient,
    orderId: string,
  ): Promise<GeneratedOrderItemRow[]> {
    const result = await client.query<GeneratedOrderItemRow>(
      `SELECT ${ORDER_ITEM_COLUMNS}
         FROM purchase_order_items
        WHERE order_id = $1 AND deleted_at IS NULL
        ORDER BY line_no`,
      [orderId],
    );
    return result.rows;
  }

  private async generatedOrderResponse(client: PoolClient, order: GeneratedOrderRow) {
    return {
      id: order.id,
      procurement_request_id: order.source_procurement_request_id,
      supplier_id: order.supplier_id,
      owner_user_id: order.owner_user_id,
      order_number: order.order_number,
      pi_number: order.pi_number,
      currency: order.currency,
      expected_total_amount: order.expected_total_amount,
      final_total_amount: order.final_total_amount,
      status: order.status,
      placed_by: order.placed_by,
      placed_at: order.placed_at,
      items: await this.generatedOrderItems(client, order.id),
      created_at: order.created_at,
      updated_at: order.updated_at,
    };
  }

  async placePurchaseOrder(
    actor: ProcurementActor,
    purchaseOrderId: string,
    dto: PlacePurchaseOrderDto,
  ) {
    this.assertAllScope(actor);
    const inputById = new Map(dto.items.map((item) => [item.item_id, item]));
    if (inputById.size !== dto.items.length) {
      throw new InvalidProcurementDataException(
        'Each purchase order item can appear only once',
        'DUPLICATE_PURCHASE_ORDER_ITEM',
      );
    }
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const serializedOrder = await client.query<{ sales_order_id: string }>(
          `SELECT request.sales_order_id
             FROM purchase_orders po
             JOIN procurement_requests request
               ON request.id = po.source_procurement_request_id
              AND request.tenant_id = po.tenant_id
             JOIN sales_orders sales_order
               ON sales_order.id = request.sales_order_id
              AND sales_order.tenant_id = request.tenant_id
              AND sales_order.deleted_at IS NULL
            WHERE po.id = $1 AND po.deleted_at IS NULL
            FOR UPDATE OF sales_order`,
          [purchaseOrderId],
        );
        if (serializedOrder.rows.length === 0) {
          throw new ProcurementResourceNotFoundException('Generated purchase order not found');
        }
        const result = await client.query<
          GeneratedOrderRow & {
            sales_order_id: string;
            request_status: string;
            request_owner_user_id: string;
          }
        >(
          `SELECT ${QUALIFIED_ORDER_COLUMNS},
                  request.sales_order_id, request.status AS request_status,
                  request.requested_by AS request_owner_user_id
             FROM purchase_orders po
             JOIN procurement_requests request
               ON request.id = po.source_procurement_request_id
              AND request.tenant_id = po.tenant_id
            WHERE po.id = $1 AND po.deleted_at IS NULL
              AND request.sales_order_id = $2
            FOR UPDATE OF po`,
          [purchaseOrderId, serializedOrder.rows[0].sales_order_id],
        );
        const order = result.rows[0];
        if (!order) {
          throw new ProcurementResourceNotFoundException('Generated purchase order not found');
        }
        if (order.status !== 'approved' || order.request_status !== 'approved') {
          throw new ProcurementConflictException(
            'Only an approved request purchase order can be placed',
            'PURCHASE_ORDER_NOT_PLACEABLE',
          );
        }
        await this.latestOpenGate(client, order.sales_order_id);
        const orderItems = await this.generatedOrderItems(client, order.id);
        if (
          orderItems.length !== dto.items.length ||
          orderItems.some((item) => !inputById.has(item.id))
        ) {
          throw new InvalidProcurementDataException(
            'Final prices must be provided exactly once for every purchase order item',
            'PURCHASE_ORDER_FINAL_PRICES_INCOMPLETE',
          );
        }
        for (const item of orderItems) {
          const input = inputById.get(item.id)!;
          const calculation = await client.query<PriceCalculation>(
            `WITH calculated AS (
               SELECT round($1::numeric * $2::numeric, 2)::text AS final_line_total,
                      round(($1::numeric - $3::numeric) * $2::numeric, 2)::text
                        AS variance_amount,
                      CASE WHEN $3::numeric = 0 THEN NULL
                           ELSE round((($1::numeric - $3::numeric) / $3::numeric) * 10000)::integer
                       END AS variance_bps
             )
             SELECT final_line_total, variance_amount, variance_bps,
                    CASE
                      WHEN $3::numeric = 0 AND $1::numeric <> 0 THEN 'exception'
                      WHEN abs(COALESCE(variance_bps, 0)) > $4::integer THEN 'exception'
                      ELSE 'within_tolerance'
                    END AS variance_status
               FROM calculated`,
            [
              input.final_unit_price,
              item.quantity,
              item.expected_unit_price,
              item.price_variance_threshold_bps,
            ],
          );
          const price = calculation.rows[0];
          const snapshot = await client.query<{ id: string; created_at: Date }>(
            `INSERT INTO purchase_price_snapshots
               (tenant_id, purchase_order_id, purchase_order_item_id,
                procurement_request_id, procurement_request_item_id,
                expected_unit_price, final_unit_price, quantity, expected_line_total,
                final_line_total, variance_amount, variance_bps, variance_threshold_bps,
                variance_status, finalized_by, reason)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             RETURNING id, created_at`,
            [
              actor.tenantId,
              order.id,
              item.id,
              order.source_procurement_request_id,
              item.source_procurement_request_item_id,
              item.expected_unit_price,
              input.final_unit_price,
              item.quantity,
              item.expected_line_total,
              price.final_line_total,
              price.variance_amount,
              price.variance_bps,
              item.price_variance_threshold_bps,
              price.variance_status,
              actor.userId,
              input.reason?.trim() || null,
            ],
          );
          await client.query(
            `UPDATE purchase_order_items
                SET final_unit_price = $1, final_line_total = $2,
                    price_variance_amount = $3, price_variance_bps = $4,
                    price_variance_status = $5, price_finalized_by = $6,
                    price_finalized_at = $7, updated_at = now()
              WHERE id = $8`,
            [
              input.final_unit_price,
              price.final_line_total,
              price.variance_amount,
              price.variance_bps,
              price.variance_status,
              actor.userId,
              snapshot.rows[0].created_at,
              item.id,
            ],
          );
          if (price.variance_status === 'exception') {
            const exception = await client.query<{
              id: string;
              status: string;
              severity: string;
              version: number;
            }>(
              `INSERT INTO business_exceptions
                 (tenant_id, context_type, context_id, exception_type, severity, summary,
                  owner_user_id)
               VALUES ($1,'purchase_order',$2,'price_variance','high',$3,$4)
               RETURNING id, status, severity, version`,
              [
                actor.tenantId,
                order.id,
                `Purchase price variance on ${order.order_number} line ${item.line_no}`,
                order.request_owner_user_id,
              ],
            );
            await this.audit.logInTransaction(client, {
              tenantId: actor.tenantId,
              actorType: 'tenant_user',
              actorId: actor.userId,
              action: 'business_exception.opened',
              resourceType: 'business_exception',
              resourceId: exception.rows[0].id,
              after: {
                status: exception.rows[0].status,
                severity: exception.rows[0].severity,
                assignedToUserId: null,
                version: exception.rows[0].version,
              },
            });
            await this.events.recordInTransaction(client, {
              tenantId: actor.tenantId,
              chainType: 'purchase_order',
              chainId: order.id,
              credentialType: 'business_exception',
              credentialId: exception.rows[0].id,
              eventType: 'business_exception.opened',
              actorType: 'tenant_user',
              actorId: actor.userId,
              scopeUserId: order.request_owner_user_id,
              visibilityPermission: 'business_exceptions:view',
            });
          }
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: `purchase_price.${price.variance_status}`,
            resourceType: 'purchase_price_snapshot',
            resourceId: snapshot.rows[0].id,
            before: {
              expected_unit_price: item.expected_unit_price,
              expected_line_total: item.expected_line_total,
            },
            after: {
              final_unit_price: input.final_unit_price,
              final_line_total: price.final_line_total,
              variance_amount: price.variance_amount,
              variance_bps: price.variance_bps,
              variance_threshold_bps: item.price_variance_threshold_bps,
              variance_status: price.variance_status,
              formula_version: 'purchase_price_variance_bps_v1',
            },
            reason: input.reason?.trim() || null,
          });
        }
        const total = await client.query<{ amount: string }>(
          `SELECT sum(final_line_total)::text AS amount
             FROM purchase_order_items
            WHERE order_id = $1 AND deleted_at IS NULL`,
          [order.id],
        );
        const placed = await client.query<GeneratedOrderRow>(
          `UPDATE purchase_orders
              SET status = 'placed', total_amount = $1, final_total_amount = $1,
                  placed_by = $2, placed_at = now(), updated_at = now()
            WHERE id = $3
            RETURNING ${ORDER_COLUMNS}`,
          [total.rows[0].amount, actor.userId, order.id],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'purchase_order.placed',
          resourceType: 'purchase_order',
          resourceId: order.id,
          before: {
            status: order.status,
            expected_total_amount: order.expected_total_amount,
          },
          after: {
            status: 'placed',
            final_total_amount: total.rows[0].amount,
            placed_by: actor.userId,
            placed_at: placed.rows[0].placed_at,
          },
        });
        await this.recordEvent(
          client,
          actor,
          order.sales_order_id,
          order.id,
          'purchase_order.placed',
          order.request_owner_user_id,
        );
        return this.generatedOrderResponse(client, placed.rows[0]);
      },
    );
  }

  private async recordEvent(
    client: PoolClient,
    actor: ProcurementActor,
    salesOrderId: string,
    credentialId: string,
    eventType: string,
    scopeUserId: string,
  ): Promise<void> {
    await this.events.recordInTransaction(client, {
      tenantId: actor.tenantId,
      chainType: 'sales_order',
      chainId: salesOrderId,
      credentialType: eventType.startsWith('purchase_order')
        ? 'purchase_order'
        : 'procurement_request',
      credentialId,
      eventType,
      actorType: 'tenant_user',
      actorId: actor.userId,
      scopeUserId,
      visibilityPermission: 'procurement:view',
    });
  }
}
