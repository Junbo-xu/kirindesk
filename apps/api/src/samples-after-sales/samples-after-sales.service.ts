import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import {
  CommercialService,
  type CommercialActor,
  type NewCommercialOrderContext,
} from '../commercial/commercial.service';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { FinanceService } from '../finance/finance.service';
import { BusinessEventsService } from '../workbench/business-events.service';
import {
  CloseDto,
  ConfirmSampleDto,
  ConvertSampleOrderDto,
  CreateAfterSalesCaseDto,
  CreateSampleOrderDto,
  DecideDto,
  DeliverSampleDto,
  DispatchSampleDto,
  ExecuteAfterSalesDto,
  ReplaceAfterSalesApprovalConfigDto,
} from './dto/samples-after-sales.dto';
import {
  InvalidSampleAfterSalesDataException,
  SampleAfterSalesConflictException,
  SampleAfterSalesDutyException,
  SampleAfterSalesNotFoundException,
} from './samples-after-sales.errors';

export interface SamplesAfterSalesActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

interface SampleRow {
  id: string;
  inquiry_id: string;
  customer_id: string;
  owner_user_id: string;
  sample_number: string;
  status: string;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  recipient_country: string;
  shipping_fee: string;
  shipping_currency: string;
  note: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

interface SampleItemRow {
  id: string;
  inquiry_item_id: string;
  source_selection_id: string;
  supplier_id: string;
  line_no: number;
  description: string;
  specifications: string | null;
  sample_quantity: string;
  maximum_conversion_quantity: string;
  unit: string;
  sales_currency: string;
  sales_unit_price: string;
  purchase_unit_cost: string;
  purchase_to_sales_fx_rate: string;
  fx_rate_source: string;
  fx_captured_at: Date;
  gross_profit_unit: string;
  gross_margin_bps: number;
  margin_threshold_bps: number;
  margin_status: string;
  margin_formula_version: string;
  source_quotation_id: string;
  source_quotation_line_id: string;
  source_quotation_version: number;
  source_snapshot: Record<string, unknown>;
  created_at: Date;
}

interface SourceSelectionRow {
  id: string;
  inquiry_item_id: string;
  quotation_id: string;
  quotation_line_id: string;
  quotation_version: number;
  snapshot_json: Record<string, unknown>;
  sales_currency: string;
  sales_unit_price: string;
  purchase_to_sales_fx_rate: string;
  fx_rate_source: string;
  fx_captured_at: Date;
  purchase_unit_cost: string;
  gross_profit_unit: string;
  gross_margin_bps: number;
  margin_threshold_bps: number;
  margin_status: string;
  margin_formula_version: string;
  margin_approval_id: string | null;
  margin_approved_by: string | null;
  margin_approval_reason: string | null;
  margin_approved_at: Date | null;
  description: string;
  specifications: string | null;
  maximum_quantity: string;
  unit: string;
  supplier_id: string;
  customer_id: string;
  owner_user_id: string;
}

interface AfterSalesCaseRow {
  id: string;
  sales_order_id: string;
  order_number: string;
  order_owner_user_id: string;
  shipment_id: string | null;
  case_number: string;
  case_type: 'refund' | 'compensation';
  responsibility: string;
  reason: string;
  requested_amount: string;
  currency: string;
  proof_file_id: string | null;
  status: string;
  requested_by: string;
  approval_config_id: string;
  approval_config_version: number;
  completed_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SAMPLE_COLUMNS = `sample.id, sample.inquiry_id, sample.customer_id,
  sample.owner_user_id, sample.sample_number, sample.status,
  sample.recipient_name, sample.recipient_phone, sample.recipient_address,
  sample.recipient_country, sample.shipping_fee::text AS shipping_fee,
  sample.shipping_currency, sample.note, sample.created_by,
  sample.created_at, sample.updated_at`;

const SAMPLE_ITEM_COLUMNS = `id, inquiry_item_id, source_selection_id, supplier_id,
  line_no, description, specifications, sample_quantity::text AS sample_quantity,
  maximum_conversion_quantity::text AS maximum_conversion_quantity, unit,
  sales_currency, sales_unit_price::text AS sales_unit_price,
  purchase_unit_cost::text AS purchase_unit_cost,
  purchase_to_sales_fx_rate::text AS purchase_to_sales_fx_rate,
  fx_rate_source, fx_captured_at, gross_profit_unit::text AS gross_profit_unit,
  gross_margin_bps, margin_threshold_bps, margin_status, margin_formula_version,
  source_quotation_id, source_quotation_line_id, source_quotation_version,
  source_snapshot, created_at`;

const CASE_COLUMNS = `cases.id, cases.sales_order_id, orders.order_number,
  orders.owner_user_id AS order_owner_user_id, cases.shipment_id, cases.case_number,
  cases.case_type, cases.responsibility, cases.reason,
  cases.requested_amount::text AS requested_amount, cases.currency,
  cases.proof_file_id, cases.status, cases.requested_by,
  cases.approval_config_id, cases.approval_config_version,
  cases.completed_at, cases.closed_at, cases.created_at, cases.updated_at`;

@Injectable()
export class SamplesAfterSalesService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly events: BusinessEventsService,
    private readonly commercial: CommercialService,
    private readonly finance: FinanceService,
  ) {}

  private context(actor: SamplesAfterSalesActor) {
    return { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' as const };
  }

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private assertAllScope(actor: SamplesAfterSalesActor): void {
    if (actor.dataScope !== 'all') {
      throw new SampleAfterSalesDutyException(
        'This action requires an all-scope permission grant',
        'SAMPLE_AFTER_SALES_ALL_SCOPE_REQUIRED',
      );
    }
  }

  private async recordEvent(
    client: PoolClient,
    actor: SamplesAfterSalesActor,
    chainType: 'inquiry' | 'sales_order' | 'sample_order',
    chainId: string,
    credentialType: string,
    credentialId: string,
    eventType: string,
    scopeUserId: string,
    visibilityPermission: 'sample_orders:view' | 'after_sales:view',
  ): Promise<void> {
    await this.events.recordInTransaction(client, {
      tenantId: actor.tenantId,
      chainType,
      chainId,
      credentialType,
      credentialId,
      eventType,
      actorType: 'tenant_user',
      actorId: actor.userId,
      scopeUserId,
      visibilityPermission,
    });
  }

  private async sampleById(
    client: PoolClient,
    actor: SamplesAfterSalesActor,
    id: string,
    lock = false,
    bypassOwnerScope = false,
  ): Promise<SampleRow> {
    const params: unknown[] = [id];
    let scope = '';
    if (!bypassOwnerScope && this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND sample.owner_user_id = $${params.length}`;
    }
    const rows = await client.query<SampleRow>(
      `SELECT ${SAMPLE_COLUMNS} FROM sample_orders sample
        WHERE sample.id = $1${scope}${lock ? ' FOR UPDATE OF sample' : ''}`,
      params,
    );
    if (!rows.rows[0]) throw new SampleAfterSalesNotFoundException('Sample order not found');
    return rows.rows[0];
  }

  private async sampleItems(client: PoolClient, sampleId: string): Promise<SampleItemRow[]> {
    return (
      await client.query<SampleItemRow>(
        `SELECT ${SAMPLE_ITEM_COLUMNS} FROM sample_order_items
          WHERE sample_order_id = $1 ORDER BY line_no`,
        [sampleId],
      )
    ).rows;
  }

  private async sampleResponse(
    client: PoolClient,
    actor: SamplesAfterSalesActor,
    sample: SampleRow,
  ) {
    const items = await this.sampleItems(client, sample.id);
    const approval = await client.query(
      `SELECT id, decision, reason, decided_by, created_at
         FROM sample_order_approvals WHERE sample_order_id = $1`,
      [sample.id],
    );
    const shipment = await client.query(
      `SELECT id, carrier, tracking_number, dispatched_by, dispatched_at, created_at
         FROM sample_shipments WHERE sample_order_id = $1`,
      [sample.id],
    );
    const delivery = await client.query(
      `SELECT id, shipment_id, received_by, delivered_at, confirmed_by, created_at
         FROM sample_delivery_confirmations WHERE sample_order_id = $1`,
      [sample.id],
    );
    const feedback = await client.query(
      `SELECT id, feedback, confirmed_by, confirmed_at, created_at
         FROM sample_customer_feedback WHERE sample_order_id = $1`,
      [sample.id],
    );
    const conversion = await client.query(
      `SELECT id, inquiry_id, proforma_invoice_id, sales_order_id,
              snapshot, converted_by, created_at
         FROM sample_order_conversions WHERE sample_order_id = $1`,
      [sample.id],
    );
    const closure = await client.query(
      `SELECT id, reason, closed_by, created_at
         FROM sample_order_closures WHERE sample_order_id = $1`,
      [sample.id],
    );
    const full = actor.dataScope === 'all';
    return {
      id: sample.id,
      inquiry_id: sample.inquiry_id,
      customer_id: sample.customer_id,
      owner_user_id: sample.owner_user_id,
      sample_number: sample.sample_number,
      status: sample.status,
      recipient: {
        name: sample.recipient_name,
        phone: sample.recipient_phone,
        address: sample.recipient_address,
        country: sample.recipient_country,
      },
      shipping_fee: sample.shipping_fee,
      shipping_currency: sample.shipping_currency,
      note: sample.note,
      items: items.map((item) => ({
        id: item.id,
        line_no: item.line_no,
        description: item.description,
        specifications: item.specifications,
        sample_quantity: item.sample_quantity,
        maximum_conversion_quantity: item.maximum_conversion_quantity,
        unit: item.unit,
        sales_currency: item.sales_currency,
        sales_unit_price: item.sales_unit_price,
        margin_status: item.margin_status,
        ...(full
          ? {
              supplier_id: item.supplier_id,
              purchase_unit_cost: item.purchase_unit_cost,
              purchase_to_sales_fx_rate: item.purchase_to_sales_fx_rate,
              fx_rate_source: item.fx_rate_source,
              fx_captured_at: item.fx_captured_at,
              source_selection_id: item.source_selection_id,
              source_snapshot: item.source_snapshot,
            }
          : {}),
      })),
      approval: approval.rows[0] ?? null,
      shipment: shipment.rows[0] ?? null,
      delivery: delivery.rows[0] ?? null,
      feedback: feedback.rows[0] ?? null,
      conversion: conversion.rows[0] ?? null,
      closure: closure.rows[0] ?? null,
      created_by: sample.created_by,
      created_at: sample.created_at,
      updated_at: sample.updated_at,
    };
  }

  async listSamples(actor: SamplesAfterSalesActor) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const params: unknown[] = [];
      let scope = '';
      if (this.restrictsToOwner(actor.dataScope)) {
        params.push(actor.userId);
        scope = ` WHERE sample.owner_user_id = $1`;
      }
      const rows = await client.query<SampleRow>(
        `SELECT ${SAMPLE_COLUMNS} FROM sample_orders sample${scope}
          ORDER BY sample.created_at DESC, sample.id DESC`,
        params,
      );
      const samples = [];
      for (const row of rows.rows) {
        samples.push(await this.sampleResponse(client, actor, row));
      }
      return samples;
    });
  }

  async getSample(actor: SamplesAfterSalesActor, id: string) {
    return withTenantContext(this.pool, this.context(actor), async (client) =>
      this.sampleResponse(client, actor, await this.sampleById(client, actor, id)),
    );
  }

  async createSample(actor: SamplesAfterSalesActor, dto: CreateSampleOrderDto) {
    const selectionIds = dto.items.map((item) => item.selection_id);
    if (new Set(selectionIds).size !== selectionIds.length) {
      throw new InvalidSampleAfterSalesDataException(
        'A quote selection can appear only once',
        'DUPLICATE_SAMPLE_SELECTION',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      await client.query(
        `WITH ordered_selection_ids AS MATERIALIZED (
           SELECT id
             FROM unnest($1::uuid[]) AS source(id)
            ORDER BY id
         )
         SELECT pg_advisory_xact_lock(hashtextextended(id::text, 0))
           FROM ordered_selection_ids`,
        [selectionIds],
      );
      const params: unknown[] = [dto.inquiry_id, selectionIds];
      let scope = '';
      if (this.restrictsToOwner(actor.dataScope)) {
        params.push(actor.userId);
        scope = ` AND inquiry.owner_user_id = $${params.length}`;
      }
      const source = await client.query<SourceSelectionRow>(
        `SELECT selection.id, selection.inquiry_item_id, selection.quotation_id,
                selection.quotation_line_id, selection.quotation_version,
                selection.snapshot_json, selection.sales_currency,
                selection.sales_unit_price::text AS sales_unit_price,
                selection.purchase_to_sales_fx_rate::text AS purchase_to_sales_fx_rate,
                selection.fx_rate_source, selection.fx_captured_at,
                selection.purchase_unit_cost::text AS purchase_unit_cost,
                selection.gross_profit_unit::text AS gross_profit_unit,
                selection.gross_margin_bps, selection.margin_threshold_bps,
                selection.margin_status, selection.margin_formula_version,
                margin_approval.id AS margin_approval_id,
                margin_approval.approved_by AS margin_approved_by,
                margin_approval.reason AS margin_approval_reason,
                margin_approval.created_at AS margin_approved_at,
                item.description, item.specifications,
                item.quantity::text AS maximum_quantity, item.unit,
                quotation.supplier_id, inquiry.customer_id, inquiry.owner_user_id
           FROM quote_selection_snapshots selection
           JOIN inquiry_items item
             ON item.id = selection.inquiry_item_id AND item.tenant_id = selection.tenant_id
           JOIN inquiries inquiry
             ON inquiry.id = selection.inquiry_id AND inquiry.tenant_id = selection.tenant_id
           JOIN supplier_quotations quotation
             ON quotation.id = selection.quotation_id AND quotation.tenant_id = selection.tenant_id
           LEFT JOIN quote_selection_margin_approvals margin_approval
             ON margin_approval.selection_id = selection.id
            AND margin_approval.tenant_id = selection.tenant_id
          WHERE selection.inquiry_id = $1 AND selection.id = ANY($2::uuid[])${scope}
          ORDER BY item.line_no, selection.id`,
        params,
      );
      if (source.rows.length !== selectionIds.length) {
        throw new SampleAfterSalesNotFoundException(
          'One or more quote selections were not found in the inquiry',
        );
      }
      if (!source.rows[0].customer_id) {
        throw new SampleAfterSalesConflictException(
          'A sample order requires a linked customer',
          'SAMPLE_CUSTOMER_REQUIRED',
        );
      }
      if (new Set(source.rows.map((row) => row.sales_currency)).size !== 1) {
        throw new InvalidSampleAfterSalesDataException(
          'All sample items must use one sales currency',
          'SAMPLE_CURRENCY_MISMATCH',
        );
      }
      const unapprovedLowMargin = source.rows
        .filter((row) => row.margin_status === 'below_threshold' && !row.margin_approval_id)
        .map((row) => row.id);
      if (unapprovedLowMargin.length > 0) {
        throw new SampleAfterSalesConflictException(
          'Low-margin selections require independent commercial approval before sampling',
          'SAMPLE_MARGIN_APPROVAL_REQUIRED',
          { selection_ids: unapprovedLowMargin },
        );
      }
      const quantityBySelection = new Map(
        dto.items.map((item) => [item.selection_id, item.quantity]),
      );
      for (const row of source.rows) {
        const allocated = await client.query<{ quantity: string; allowed: boolean }>(
          `SELECT COALESCE(sum(item.sample_quantity), 0)::text AS quantity,
                  COALESCE(sum(item.sample_quantity), 0) + $2::numeric <= $3::numeric AS allowed
             FROM sample_order_items item
            WHERE item.source_selection_id = $1`,
          [row.id, quantityBySelection.get(row.id), row.maximum_quantity],
        );
        if (!allocated.rows[0].allowed) {
          throw new SampleAfterSalesConflictException(
            'Sample quantity exceeds the selected quotation quantity',
            'SAMPLE_QUANTITY_EXCEEDED',
            {
              selection_id: row.id,
              allocated_quantity: allocated.rows[0].quantity,
              maximum_quantity: row.maximum_quantity,
            },
          );
        }
      }
      const identity = await client.query<{ id: string; sample_number: string }>(
        `SELECT generated.id,
                'SMP-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
                  || upper(substr(replace(generated.id::text, '-', ''), 1, 8)) AS sample_number
           FROM (SELECT uuid_generate_v4() AS id) generated`,
      );
      const inserted = await client.query<SampleRow>(
        `INSERT INTO sample_orders
           (id, tenant_id, inquiry_id, customer_id, owner_user_id, sample_number,
            recipient_name, recipient_phone, recipient_address, recipient_country,
            shipping_fee, shipping_currency, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${SAMPLE_COLUMNS.replaceAll('sample.', '')}`,
        [
          identity.rows[0].id,
          actor.tenantId,
          dto.inquiry_id,
          source.rows[0].customer_id,
          source.rows[0].owner_user_id,
          identity.rows[0].sample_number,
          dto.recipient_name,
          dto.recipient_phone,
          dto.recipient_address,
          dto.recipient_country,
          dto.shipping_fee,
          dto.shipping_currency,
          dto.note?.trim() || null,
          actor.userId,
        ],
      );
      const sample = inserted.rows[0];
      for (const [index, row] of source.rows.entries()) {
        await client.query(
          `INSERT INTO sample_order_items
             (tenant_id, sample_order_id, inquiry_item_id, source_selection_id,
              supplier_id, line_no, description, specifications, sample_quantity,
              maximum_conversion_quantity, unit, sales_currency, sales_unit_price,
              purchase_unit_cost, purchase_to_sales_fx_rate, fx_rate_source,
              fx_captured_at, gross_profit_unit, gross_margin_bps,
              margin_threshold_bps, margin_status, margin_formula_version,
              source_quotation_id, source_quotation_line_id,
              source_quotation_version, source_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                   $17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
          [
            actor.tenantId,
            sample.id,
            row.inquiry_item_id,
            row.id,
            row.supplier_id,
            index + 1,
            row.description,
            row.specifications,
            quantityBySelection.get(row.id),
            row.maximum_quantity,
            row.unit,
            row.sales_currency,
            row.sales_unit_price,
            row.purchase_unit_cost,
            row.purchase_to_sales_fx_rate,
            row.fx_rate_source,
            row.fx_captured_at,
            row.gross_profit_unit,
            row.gross_margin_bps,
            row.margin_threshold_bps,
            row.margin_status,
            row.margin_formula_version,
            row.quotation_id,
            row.quotation_line_id,
            row.quotation_version,
            JSON.stringify({
              ...row.snapshot_json,
              sample_margin_approval: row.margin_approval_id
                ? {
                    id: row.margin_approval_id,
                    approved_by: row.margin_approved_by,
                    reason: row.margin_approval_reason,
                    approved_at: row.margin_approved_at,
                  }
                : null,
            }),
          ],
        );
      }
      const response = await this.sampleResponse(client, actor, sample);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'sample_order.created',
        resourceType: 'sample_order',
        resourceId: sample.id,
        after: response,
      });
      await this.recordEvent(
        client,
        actor,
        'inquiry',
        sample.inquiry_id,
        'sample_order',
        sample.id,
        'sample_order.created',
        sample.owner_user_id,
        'sample_orders:view',
      );
      return response;
    });
  }

  private async updateSampleStatus(
    client: PoolClient,
    actor: SamplesAfterSalesActor,
    sample: SampleRow,
    status: string,
    action: string,
  ): Promise<SampleRow> {
    const rows = await client.query<SampleRow>(
      `UPDATE sample_orders SET status = $1, updated_at = now() WHERE id = $2
       RETURNING ${SAMPLE_COLUMNS.replaceAll('sample.', '')}`,
      [status, sample.id],
    );
    await this.audit.logInTransaction(client, {
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action,
      resourceType: 'sample_order',
      resourceId: sample.id,
      before: { status: sample.status },
      after: { status },
    });
    await this.recordEvent(
      client,
      actor,
      'inquiry',
      sample.inquiry_id,
      'sample_order',
      sample.id,
      action,
      sample.owner_user_id,
      'sample_orders:view',
    );
    return rows.rows[0];
  }

  async submitSample(actor: SamplesAfterSalesActor, id: string) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const sample = await this.sampleById(client, actor, id, true);
      if (sample.status !== 'draft') {
        throw new SampleAfterSalesConflictException(
          'Only a draft sample can be submitted',
          'SAMPLE_NOT_DRAFT',
        );
      }
      return this.sampleResponse(
        client,
        actor,
        await this.updateSampleStatus(
          client,
          actor,
          sample,
          'pending_approval',
          'sample_order.submitted',
        ),
      );
    });
  }

  async decideSample(actor: SamplesAfterSalesActor, id: string, dto: DecideDto) {
    this.assertAllScope(actor);
    if (dto.decision === 'rejected' && !dto.reason?.trim()) {
      throw new InvalidSampleAfterSalesDataException(
        'A rejection reason is required',
        'SAMPLE_REJECTION_REASON_REQUIRED',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const sample = await this.sampleById(client, actor, id, true, true);
      if (sample.status !== 'pending_approval') {
        throw new SampleAfterSalesConflictException(
          'Only a pending sample can be decided',
          'SAMPLE_NOT_PENDING_APPROVAL',
        );
      }
      if (sample.created_by === actor.userId) {
        throw new SampleAfterSalesDutyException(
          'The sample creator cannot approve the same sample',
          'SAMPLE_SELF_APPROVAL_FORBIDDEN',
        );
      }
      const decision = await client.query<{ id: string }>(
        `INSERT INTO sample_order_approvals
           (tenant_id, sample_order_id, decision, reason, decided_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [actor.tenantId, sample.id, dto.decision, dto.reason?.trim() || null, actor.userId],
      );
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: `sample_order.${dto.decision}`,
        resourceType: 'sample_order_approval',
        resourceId: decision.rows[0].id,
        after: { sample_order_id: sample.id, decision: dto.decision },
        reason: dto.reason?.trim() || null,
      });
      const updated = await this.updateSampleStatus(
        client,
        actor,
        sample,
        dto.decision,
        `sample_order.${dto.decision}`,
      );
      return this.sampleResponse(client, actor, updated);
    });
  }

  async dispatchSample(actor: SamplesAfterSalesActor, id: string, dto: DispatchSampleDto) {
    this.assertAllScope(actor);
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const sample = await this.sampleById(client, actor, id, true, true);
      if (sample.status !== 'approved') {
        throw new SampleAfterSalesConflictException(
          'Only an approved sample can be dispatched',
          'SAMPLE_NOT_DISPATCHABLE',
        );
      }
      const shipment = await client.query<{ id: string }>(
        `INSERT INTO sample_shipments
           (tenant_id, sample_order_id, carrier, tracking_number,
            dispatched_by, dispatched_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          actor.tenantId,
          sample.id,
          dto.carrier,
          dto.tracking_number,
          actor.userId,
          new Date(dto.dispatched_at),
        ],
      );
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'sample_order.dispatched',
        resourceType: 'sample_shipment',
        resourceId: shipment.rows[0].id,
        after: { sample_order_id: sample.id, carrier: dto.carrier },
      });
      return this.sampleResponse(
        client,
        actor,
        await this.updateSampleStatus(
          client,
          actor,
          sample,
          'dispatched',
          'sample_order.dispatched',
        ),
      );
    });
  }

  async deliverSample(actor: SamplesAfterSalesActor, id: string, dto: DeliverSampleDto) {
    this.assertAllScope(actor);
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const sample = await this.sampleById(client, actor, id, true, true);
      if (sample.status !== 'dispatched') {
        throw new SampleAfterSalesConflictException(
          'Only a dispatched sample can be marked delivered',
          'SAMPLE_NOT_DELIVERABLE',
        );
      }
      const shipment = await client.query<{ id: string }>(
        `SELECT id FROM sample_shipments WHERE sample_order_id = $1`,
        [sample.id],
      );
      await client.query(
        `INSERT INTO sample_delivery_confirmations
           (tenant_id, sample_order_id, shipment_id, received_by, delivered_at, confirmed_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          actor.tenantId,
          sample.id,
          shipment.rows[0].id,
          dto.received_by,
          new Date(dto.delivered_at),
          actor.userId,
        ],
      );
      return this.sampleResponse(
        client,
        actor,
        await this.updateSampleStatus(client, actor, sample, 'delivered', 'sample_order.delivered'),
      );
    });
  }

  async confirmSample(actor: SamplesAfterSalesActor, id: string, dto: ConfirmSampleDto) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const sample = await this.sampleById(client, actor, id, true);
      if (sample.status !== 'delivered') {
        throw new SampleAfterSalesConflictException(
          'Only a delivered sample can be customer-confirmed',
          'SAMPLE_NOT_CONFIRMABLE',
        );
      }
      await client.query(
        `INSERT INTO sample_customer_feedback
           (tenant_id, sample_order_id, feedback, confirmed_by)
         VALUES ($1,$2,$3,$4)`,
        [actor.tenantId, sample.id, dto.feedback, actor.userId],
      );
      return this.sampleResponse(
        client,
        actor,
        await this.updateSampleStatus(client, actor, sample, 'confirmed', 'sample_order.confirmed'),
      );
    });
  }

  async convertSample(actor: SamplesAfterSalesActor, id: string, dto: ConvertSampleOrderDto) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const sample = await this.sampleById(client, actor, id, true);
      if (sample.status !== 'confirmed') {
        throw new SampleAfterSalesConflictException(
          'Only a customer-confirmed sample can be converted',
          'SAMPLE_NOT_CONVERTIBLE',
        );
      }
      const items = await this.sampleItems(client, sample.id);
      const inputIds = dto.items.map((row) => row.sample_item_id);
      if (
        new Set(inputIds).size !== inputIds.length ||
        items.length !== inputIds.length ||
        items.some((item) => !inputIds.includes(item.id))
      ) {
        throw new InvalidSampleAfterSalesDataException(
          'Conversion quantities must cover every sample item exactly once',
          'SAMPLE_CONVERSION_ITEMS_MISMATCH',
        );
      }
      const quantityByItem = new Map(dto.items.map((row) => [row.sample_item_id, row.quantity]));
      for (const item of items) {
        const allowed = await client.query<{ allowed: boolean }>(
          `SELECT $1::numeric <= $2::numeric AS allowed`,
          [quantityByItem.get(item.id), item.maximum_conversion_quantity],
        );
        if (!allowed.rows[0].allowed) {
          throw new SampleAfterSalesConflictException(
            'Conversion quantity exceeds the frozen selected quantity',
            'SAMPLE_CONVERSION_QUANTITY_EXCEEDED',
            { sample_item_id: item.id },
          );
        }
      }
      const sourceInquiry = await client.query<{
        customer_code: string;
        customer_country: string;
        customer_message: string;
      }>(
        `SELECT customer_code, customer_country, customer_message
           FROM inquiries WHERE id = $1`,
        [sample.inquiry_id],
      );
      const identity = await client.query<{
        inquiry_id: string;
        pi_id: string;
        series_id: string;
        sales_order_id: string;
        pi_number: string;
        order_number: string;
      }>(
        `SELECT generated.inquiry_id, generated.pi_id, generated.series_id,
                generated.sales_order_id,
                'PI-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
                  || upper(substr(replace(generated.pi_id::text, '-', ''), 1, 8)) AS pi_number,
                'SO-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
                  || upper(substr(replace(generated.sales_order_id::text, '-', ''), 1, 8)) AS order_number
           FROM (SELECT uuid_generate_v4() AS inquiry_id,
                        uuid_generate_v4() AS pi_id,
                        uuid_generate_v4() AS series_id,
                        uuid_generate_v4() AS sales_order_id) generated`,
      );
      const ids = identity.rows[0];
      await client.query(
        `INSERT INTO inquiries
           (id, tenant_id, owner_user_id, customer_code, customer_country,
            customer_message, status, submitted_at, customer_id, source_sample_order_id)
         VALUES ($1,$2,$3,$4,$5,$6,'selected',now(),$7,$8)`,
        [
          ids.inquiry_id,
          actor.tenantId,
          sample.owner_user_id,
          sourceInquiry.rows[0].customer_code,
          sourceInquiry.rows[0].customer_country,
          `Converted from sample ${sample.sample_number}: ${sourceInquiry.rows[0].customer_message}`,
          sample.customer_id,
          sample.id,
        ],
      );
      const derivedItems: Array<SampleItemRow & { derived_item_id: string; selection_id: string }> =
        [];
      for (const item of items) {
        const generated = await client.query<{ item_id: string; selection_id: string }>(
          `SELECT uuid_generate_v4()::text AS item_id,
                  uuid_generate_v4()::text AS selection_id`,
        );
        const quantity = quantityByItem.get(item.id)!;
        await client.query(
          `INSERT INTO inquiry_items
             (id, tenant_id, inquiry_id, line_no, description, specifications, quantity, unit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            generated.rows[0].item_id,
            actor.tenantId,
            ids.inquiry_id,
            item.line_no,
            item.description,
            item.specifications,
            quantity,
            item.unit,
          ],
        );
        const conversionSnapshot = {
          ...item.source_snapshot,
          sample_conversion: {
            sample_order_id: sample.id,
            sample_item_id: item.id,
            source_selection_id: item.source_selection_id,
            converted_quantity: quantity,
          },
        };
        await client.query(
          `INSERT INTO quote_selection_snapshots
             (id, tenant_id, inquiry_id, inquiry_item_id, quotation_id,
              quotation_line_id, quotation_version, selected_by, snapshot_json,
              sales_currency, sales_unit_price, purchase_to_sales_fx_rate,
              fx_rate_source, fx_captured_at, purchase_unit_cost, gross_profit_unit,
              gross_margin_bps, margin_threshold_bps, margin_status,
              margin_formula_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                   $17,$18,$19,$20)`,
          [
            generated.rows[0].selection_id,
            actor.tenantId,
            ids.inquiry_id,
            generated.rows[0].item_id,
            item.source_quotation_id,
            item.source_quotation_line_id,
            item.source_quotation_version,
            actor.userId,
            JSON.stringify(conversionSnapshot),
            item.sales_currency,
            item.sales_unit_price,
            item.purchase_to_sales_fx_rate,
            item.fx_rate_source,
            item.fx_captured_at,
            item.purchase_unit_cost,
            item.gross_profit_unit,
            item.gross_margin_bps,
            item.margin_threshold_bps,
            item.margin_status,
            item.margin_formula_version,
          ],
        );
        if (item.margin_status === 'below_threshold') {
          const marginApproval = item.source_snapshot.sample_margin_approval as
            | Record<string, unknown>
            | undefined;
          if (
            typeof marginApproval?.approved_by !== 'string' ||
            typeof marginApproval.reason !== 'string'
          ) {
            throw new SampleAfterSalesConflictException(
              'The frozen low-margin selection has no independent commercial approval',
              'SAMPLE_FROZEN_MARGIN_APPROVAL_MISSING',
              { sample_item_id: item.id },
            );
          }
          await client.query(
            `INSERT INTO quote_selection_margin_approvals
               (tenant_id, selection_id, approved_by, reason)
             VALUES ($1,$2,$3,$4)`,
            [
              actor.tenantId,
              generated.rows[0].selection_id,
              marginApproval.approved_by,
              marginApproval.reason,
            ],
          );
        }
        derivedItems.push({
          ...item,
          derived_item_id: generated.rows[0].item_id,
          selection_id: generated.rows[0].selection_id,
        });
      }
      const totalRows = await client.query<{ total: string }>(
        `SELECT round(sum(quantity::numeric * price::numeric), 2)::text AS total
           FROM unnest($1::text[], $2::text[]) AS lines(quantity, price)`,
        [
          derivedItems.map((item) => quantityByItem.get(item.id)!),
          derivedItems.map((item) => item.sales_unit_price),
        ],
      );
      const total = totalRows.rows[0].total;
      const currency = derivedItems[0].sales_currency;
      await client.query(
        `INSERT INTO proforma_invoices
           (id, tenant_id, series_id, inquiry_id, customer_id, pi_number, version,
            currency, payment_terms, status, total_amount, created_by, issued_by, issued_at)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,'issued',$9,$10,$10,now())`,
        [
          ids.pi_id,
          actor.tenantId,
          ids.series_id,
          ids.inquiry_id,
          sample.customer_id,
          ids.pi_number,
          currency,
          dto.payment_terms,
          total,
          actor.userId,
        ],
      );
      for (const item of derivedItems) {
        const quantity = quantityByItem.get(item.id)!;
        const lineTotal = await client.query<{ value: string }>(
          `SELECT round($1::numeric * $2::numeric, 2)::text AS value`,
          [quantity, item.sales_unit_price],
        );
        await client.query(
          `INSERT INTO proforma_invoice_series_selections
             (tenant_id, series_id, selection_id) VALUES ($1,$2,$3)`,
          [actor.tenantId, ids.series_id, item.selection_id],
        );
        await client.query(
          `INSERT INTO proforma_invoice_items
             (tenant_id, proforma_invoice_id, series_id, selection_id, line_no,
              description, specifications, quantity, unit, unit_price,
              line_total, selection_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            actor.tenantId,
            ids.pi_id,
            ids.series_id,
            item.selection_id,
            item.line_no,
            item.description,
            item.specifications,
            quantity,
            item.unit,
            item.sales_unit_price,
            lineTotal.rows[0].value,
            JSON.stringify({
              ...item.source_snapshot,
              sample_conversion: { sample_order_id: sample.id, sample_item_id: item.id },
            }),
          ],
        );
      }
      await client.query(
        `INSERT INTO sales_orders
           (id, tenant_id, customer_id, owner_user_id, order_number, pi_number,
            currency, total_amount, status, inquiry_id, source_pi_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'customer_confirmed',$9,$10)`,
        [
          ids.sales_order_id,
          actor.tenantId,
          sample.customer_id,
          sample.owner_user_id,
          ids.order_number,
          ids.pi_number,
          currency,
          total,
          ids.inquiry_id,
          ids.pi_id,
        ],
      );
      await client.query(
        `INSERT INTO sales_order_items
           (tenant_id, order_id, line_no, description, unit, quantity, unit_price, line_total)
         SELECT tenant_id, $1, line_no, description, unit, quantity, unit_price, line_total
           FROM proforma_invoice_items WHERE proforma_invoice_id = $2 ORDER BY line_no`,
        [ids.sales_order_id, ids.pi_id],
      );
      await client.query(
        `UPDATE proforma_invoices
            SET status = 'customer_confirmed', confirmed_by = $1, confirmed_at = now(),
                sales_order_id = $2, updated_at = now()
          WHERE id = $3`,
        [actor.userId, ids.sales_order_id, ids.pi_id],
      );
      const orderContext: NewCommercialOrderContext = {
        id: ids.sales_order_id,
        inquiry_id: ids.inquiry_id,
        proforma_invoice_id: ids.pi_id,
        owner_user_id: sample.owner_user_id,
        total_amount: total,
        currency,
        status: 'customer_confirmed',
      };
      const gate = await this.commercial.evaluateNewOrderGateInTransaction(
        client,
        actor as CommercialActor,
        orderContext,
      );
      const conversionSnapshot = {
        source_sample: { id: sample.id, sample_number: sample.sample_number },
        generated: {
          inquiry_id: ids.inquiry_id,
          proforma_invoice_id: ids.pi_id,
          sales_order_id: ids.sales_order_id,
        },
        item_mappings: derivedItems.map((item) => ({
          sample_item_id: item.id,
          source_selection_id: item.source_selection_id,
          generated_selection_id: item.selection_id,
          quantity: quantityByItem.get(item.id),
        })),
      };
      const conversion = await client.query<{ id: string }>(
        `INSERT INTO sample_order_conversions
           (tenant_id, sample_order_id, inquiry_id, proforma_invoice_id,
            sales_order_id, snapshot, converted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          actor.tenantId,
          sample.id,
          ids.inquiry_id,
          ids.pi_id,
          ids.sales_order_id,
          JSON.stringify(conversionSnapshot),
          actor.userId,
        ],
      );
      const updated = await this.updateSampleStatus(
        client,
        actor,
        sample,
        'converted',
        'sample_order.converted',
      );
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'sales_order.created_from_sample',
        resourceType: 'sample_order_conversion',
        resourceId: conversion.rows[0].id,
        after: conversionSnapshot,
      });
      await this.recordEvent(
        client,
        actor,
        'sample_order',
        sample.id,
        'inquiry',
        ids.inquiry_id,
        'inquiry.created_from_sample',
        sample.owner_user_id,
        'sample_orders:view',
      );
      await this.recordEvent(
        client,
        actor,
        'inquiry',
        ids.inquiry_id,
        'sales_order',
        ids.sales_order_id,
        'sales_order.created_from_sample',
        sample.owner_user_id,
        'sample_orders:view',
      );
      return { sample_order: await this.sampleResponse(client, actor, updated), gate };
    });
  }

  async closeSample(actor: SamplesAfterSalesActor, id: string, dto: CloseDto) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const sample = await this.sampleById(client, actor, id, true);
      if (!['approved', 'dispatched', 'delivered', 'confirmed'].includes(sample.status)) {
        throw new SampleAfterSalesConflictException(
          'This sample cannot be closed from its current state',
          'SAMPLE_NOT_CLOSABLE',
        );
      }
      await client.query(
        `INSERT INTO sample_order_closures
           (tenant_id, sample_order_id, reason, closed_by) VALUES ($1,$2,$3,$4)`,
        [actor.tenantId, sample.id, dto.reason, actor.userId],
      );
      return this.sampleResponse(
        client,
        actor,
        await this.updateSampleStatus(client, actor, sample, 'closed', 'sample_order.closed'),
      );
    });
  }

  private async activeConfig(client: PoolClient) {
    const config = await client.query<{ id: string; version: number; created_at: Date }>(
      `SELECT id, version, created_at FROM after_sales_approval_configs
        WHERE active ORDER BY version DESC LIMIT 1`,
    );
    if (!config.rows[0]) {
      throw new SampleAfterSalesConflictException(
        'An active after-sales approval config is required',
        'AFTER_SALES_APPROVAL_CONFIG_REQUIRED',
      );
    }
    return config.rows[0];
  }

  private async configResponse(client: PoolClient, config: { id: string; version: number }) {
    const steps = await client.query(
      `SELECT step.id, step.step_no, step.approver_user_id, users.name AS approver_name
         FROM after_sales_approval_config_steps step
         JOIN users ON users.id = step.approver_user_id AND users.tenant_id = step.tenant_id
        WHERE step.config_id = $1 ORDER BY step.step_no`,
      [config.id],
    );
    return { ...config, steps: steps.rows };
  }

  async getAfterSalesApprovalConfig(actor: SamplesAfterSalesActor) {
    this.assertAllScope(actor);
    return withTenantContext(this.pool, this.context(actor), async (client) =>
      this.configResponse(client, await this.activeConfig(client)),
    );
  }

  async replaceAfterSalesApprovalConfig(
    actor: SamplesAfterSalesActor,
    dto: ReplaceAfterSalesApprovalConfigDto,
  ) {
    this.assertAllScope(actor);
    const approvers = dto.steps.map((step) => step.approver_user_id);
    if (new Set(approvers).size !== approvers.length) {
      throw new InvalidSampleAfterSalesDataException(
        'An approver can appear only once in a flow',
        'DUPLICATE_AFTER_SALES_APPROVER',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      await client.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [actor.tenantId]);
      const users = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'active'
          AND deleted_at IS NULL`,
        [approvers],
      );
      if (users.rows.length !== approvers.length) {
        throw new InvalidSampleAfterSalesDataException(
          'Every approver must be an active tenant user',
          'AFTER_SALES_APPROVER_NOT_FOUND',
        );
      }
      const version = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0)::integer + 1 AS version
           FROM after_sales_approval_configs`,
      );
      await client.query(`UPDATE after_sales_approval_configs SET active = false WHERE active`);
      const config = await client.query<{ id: string; version: number; created_at: Date }>(
        `INSERT INTO after_sales_approval_configs
           (tenant_id, version, active, created_by)
         VALUES ($1,$2,true,$3) RETURNING id, version, created_at`,
        [actor.tenantId, version.rows[0].version, actor.userId],
      );
      for (const [index, step] of dto.steps.entries()) {
        await client.query(
          `INSERT INTO after_sales_approval_config_steps
             (tenant_id, config_id, step_no, approver_user_id)
           VALUES ($1,$2,$3,$4)`,
          [actor.tenantId, config.rows[0].id, index + 1, step.approver_user_id],
        );
      }
      const response = await this.configResponse(client, config.rows[0]);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'after_sales_approval_config.revised',
        resourceType: 'after_sales_approval_config',
        resourceId: config.rows[0].id,
        after: response,
      });
      return response;
    });
  }

  private async caseById(
    client: PoolClient,
    actor: SamplesAfterSalesActor,
    id: string,
    lock = false,
    bypassOwnerScope = false,
  ): Promise<AfterSalesCaseRow> {
    const params: unknown[] = [id];
    let scope = '';
    if (!bypassOwnerScope && this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND orders.owner_user_id = $${params.length}`;
    }
    const rows = await client.query<AfterSalesCaseRow>(
      `SELECT ${CASE_COLUMNS}
         FROM after_sales_cases cases
         JOIN sales_orders orders
           ON orders.id = cases.sales_order_id AND orders.tenant_id = cases.tenant_id
        WHERE cases.id = $1${scope}${lock ? ' FOR UPDATE OF cases' : ''}`,
      params,
    );
    if (!rows.rows[0]) throw new SampleAfterSalesNotFoundException('After-sales case not found');
    return rows.rows[0];
  }

  private async caseResponse(client: PoolClient, row: AfterSalesCaseRow) {
    const steps = await client.query(
      `SELECT step.id, step.step_no, step.approver_user_id,
              decision.decision, decision.decided_by, decision.reason,
              decision.created_at AS decided_at
         FROM after_sales_case_approval_steps step
         LEFT JOIN after_sales_case_decisions decision
           ON decision.approval_step_id = step.id AND decision.tenant_id = step.tenant_id
        WHERE step.case_id = $1 ORDER BY step.step_no`,
      [row.id],
    );
    const adjustment = await client.query(
      `SELECT id, adjustment_type, amount::text AS amount, currency,
              fx_rate_to_rmb::text AS fx_rate_to_rmb, fx_source, fx_captured_at,
              amount_rmb::text AS amount_rmb, external_reference,
              proof_file_id, executed_by, created_at
         FROM after_sales_adjustments WHERE case_id = $1`,
      [row.id],
    );
    const currentStep = steps.rows.find((step) => !step.decision)?.step_no ?? null;
    return {
      id: row.id,
      sales_order_id: row.sales_order_id,
      order_number: row.order_number,
      shipment_id: row.shipment_id,
      case_number: row.case_number,
      case_type: row.case_type,
      responsibility: row.responsibility,
      reason: row.reason,
      requested_amount: row.requested_amount,
      currency: row.currency,
      proof_file_id: row.proof_file_id,
      status: row.status,
      requested_by: row.requested_by,
      approval_config: { id: row.approval_config_id, version: row.approval_config_version },
      current_approval_step: row.status === 'pending_approval' ? currentStep : null,
      approval_steps: steps.rows.map((step) => ({
        ...step,
        status:
          step.decision ??
          (row.status === 'pending_approval' && step.step_no === currentStep
            ? 'current'
            : 'waiting'),
      })),
      adjustment: adjustment.rows[0] ?? null,
      completed_at: row.completed_at,
      closed_at: row.closed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async listAfterSalesCases(actor: SamplesAfterSalesActor) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const params: unknown[] = [];
      let scope = '';
      if (this.restrictsToOwner(actor.dataScope)) {
        params.push(actor.userId);
        scope = ` WHERE orders.owner_user_id = $1`;
      }
      const rows = await client.query<AfterSalesCaseRow>(
        `SELECT ${CASE_COLUMNS}
           FROM after_sales_cases cases
           JOIN sales_orders orders
             ON orders.id = cases.sales_order_id AND orders.tenant_id = cases.tenant_id
          ${scope} ORDER BY cases.created_at DESC, cases.id DESC`,
        params,
      );
      const cases = [];
      for (const row of rows.rows) {
        cases.push(await this.caseResponse(client, row));
      }
      return cases;
    });
  }

  async getAfterSalesCase(actor: SamplesAfterSalesActor, id: string) {
    return withTenantContext(this.pool, this.context(actor), async (client) =>
      this.caseResponse(client, await this.caseById(client, actor, id)),
    );
  }

  async createAfterSalesCase(
    actor: SamplesAfterSalesActor,
    orderId: string,
    dto: CreateAfterSalesCaseDto,
  ) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const params: unknown[] = [orderId];
      let scope = '';
      if (this.restrictsToOwner(actor.dataScope)) {
        params.push(actor.userId);
        scope = ` AND owner_user_id = $${params.length}`;
      }
      const order = await client.query<{
        id: string;
        owner_user_id: string;
        status: string;
        order_number: string;
      }>(
        `SELECT id, owner_user_id, status, order_number FROM sales_orders
          WHERE id = $1 AND source_pi_id IS NOT NULL AND deleted_at IS NULL${scope}
          FOR UPDATE`,
        params,
      );
      if (!order.rows[0]) {
        throw new SampleAfterSalesNotFoundException('PI-backed sales order not found');
      }
      if (order.rows[0].status !== 'settled') {
        throw new SampleAfterSalesConflictException(
          'After-sales cases require a settled sales order',
          'AFTER_SALES_ORDER_NOT_SETTLED',
        );
      }
      if (dto.shipment_id) {
        const shipment = await client.query<{ id: string }>(
          `SELECT id FROM shipments WHERE id = $1 AND sales_order_id = $2`,
          [dto.shipment_id, orderId],
        );
        if (!shipment.rows[0]) {
          throw new InvalidSampleAfterSalesDataException(
            'The shipment does not belong to the sales order',
            'AFTER_SALES_SHIPMENT_MISMATCH',
          );
        }
      }
      const config = await this.activeConfig(client);
      const steps = await client.query<{ id: string; step_no: number; approver_user_id: string }>(
        `SELECT id, step_no, approver_user_id FROM after_sales_approval_config_steps
          WHERE config_id = $1 ORDER BY step_no`,
        [config.id],
      );
      if (steps.rows.some((step) => step.approver_user_id === actor.userId)) {
        throw new SampleAfterSalesDutyException(
          'A requester cannot be an approver on the same frozen flow',
          'AFTER_SALES_REQUESTER_APPROVER_CONFLICT',
        );
      }
      const identity = await client.query<{ id: string; case_number: string }>(
        `SELECT generated.id,
                'AS-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
                  || upper(substr(replace(generated.id::text, '-', ''), 1, 8)) AS case_number
           FROM (SELECT uuid_generate_v4() AS id) generated`,
      );
      const inserted = await client.query<AfterSalesCaseRow>(
        `WITH inserted AS (
           INSERT INTO after_sales_cases
             (id, tenant_id, sales_order_id, shipment_id, case_number, case_type,
              responsibility, reason, requested_amount, currency, proof_file_id,
              requested_by, approval_config_id, approval_config_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           RETURNING *
         )
         SELECT ${CASE_COLUMNS}
           FROM inserted cases
           JOIN sales_orders orders ON orders.id = cases.sales_order_id`,
        [
          identity.rows[0].id,
          actor.tenantId,
          orderId,
          dto.shipment_id ?? null,
          identity.rows[0].case_number,
          dto.case_type,
          dto.responsibility,
          dto.reason,
          dto.requested_amount,
          dto.currency,
          dto.proof_file_id ?? null,
          actor.userId,
          config.id,
          config.version,
        ],
      );
      const row = inserted.rows[0];
      for (const step of steps.rows) {
        await client.query(
          `INSERT INTO after_sales_case_approval_steps
             (tenant_id, case_id, config_step_id, step_no, approver_user_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [actor.tenantId, row.id, step.id, step.step_no, step.approver_user_id],
        );
      }
      const response = await this.caseResponse(client, row);
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: 'after_sales_case.created',
        resourceType: 'after_sales_case',
        resourceId: row.id,
        after: response,
      });
      await this.recordEvent(
        client,
        actor,
        'sales_order',
        row.sales_order_id,
        'after_sales_case',
        row.id,
        'after_sales_case.created',
        row.order_owner_user_id,
        'after_sales:view',
      );
      return response;
    });
  }

  private async updateCaseStatus(
    client: PoolClient,
    actor: SamplesAfterSalesActor,
    row: AfterSalesCaseRow,
    status: string,
    action: string,
  ): Promise<AfterSalesCaseRow> {
    const updates =
      status === 'completed'
        ? `status = $1, completed_at = now(), updated_at = now()`
        : status === 'closed'
          ? `status = $1, closed_at = now(), updated_at = now()`
          : `status = $1, updated_at = now()`;
    const result = await client.query<AfterSalesCaseRow>(
      `WITH updated AS (
         UPDATE after_sales_cases SET ${updates} WHERE id = $2 RETURNING *
       )
       SELECT ${CASE_COLUMNS}
         FROM updated cases
         JOIN sales_orders orders ON orders.id = cases.sales_order_id`,
      [status, row.id],
    );
    await this.audit.logInTransaction(client, {
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action,
      resourceType: 'after_sales_case',
      resourceId: row.id,
      before: { status: row.status },
      after: { status },
    });
    await this.recordEvent(
      client,
      actor,
      'sales_order',
      row.sales_order_id,
      'after_sales_case',
      row.id,
      action,
      row.order_owner_user_id,
      'after_sales:view',
    );
    return result.rows[0];
  }

  async submitAfterSalesCase(actor: SamplesAfterSalesActor, id: string) {
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const row = await this.caseById(client, actor, id, true);
      if (row.status !== 'draft') {
        throw new SampleAfterSalesConflictException(
          'Only a draft after-sales case can be submitted',
          'AFTER_SALES_CASE_NOT_DRAFT',
        );
      }
      return this.caseResponse(
        client,
        await this.updateCaseStatus(
          client,
          actor,
          row,
          'pending_approval',
          'after_sales_case.submitted',
        ),
      );
    });
  }

  async decideAfterSalesCase(actor: SamplesAfterSalesActor, id: string, dto: DecideDto) {
    this.assertAllScope(actor);
    if (dto.decision === 'rejected' && !dto.reason?.trim()) {
      throw new InvalidSampleAfterSalesDataException(
        'A rejection reason is required',
        'AFTER_SALES_REJECTION_REASON_REQUIRED',
      );
    }
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const row = await this.caseById(client, actor, id, true, true);
      if (row.status !== 'pending_approval') {
        throw new SampleAfterSalesConflictException(
          'Only a pending case can receive a decision',
          'AFTER_SALES_CASE_NOT_PENDING',
        );
      }
      if (row.requested_by === actor.userId) {
        throw new SampleAfterSalesDutyException(
          'The requester cannot decide the same after-sales case',
          'AFTER_SALES_SELF_APPROVAL_FORBIDDEN',
        );
      }
      const current = await client.query<{
        id: string;
        step_no: number;
        approver_user_id: string;
      }>(
        `SELECT step.id, step.step_no, step.approver_user_id
           FROM after_sales_case_approval_steps step
           LEFT JOIN after_sales_case_decisions decision
             ON decision.approval_step_id = step.id AND decision.tenant_id = step.tenant_id
          WHERE step.case_id = $1 AND decision.id IS NULL
          ORDER BY step.step_no LIMIT 1`,
        [row.id],
      );
      const step = current.rows[0];
      if (!step) {
        throw new SampleAfterSalesConflictException(
          'All frozen approval steps already have decisions',
          'AFTER_SALES_APPROVAL_ALREADY_COMPLETE',
        );
      }
      if (step.approver_user_id !== actor.userId) {
        throw new SampleAfterSalesDutyException(
          'Only the current frozen-step approver can decide',
          'AFTER_SALES_WRONG_APPROVER',
        );
      }
      const decision = await client.query<{ id: string }>(
        `INSERT INTO after_sales_case_decisions
           (tenant_id, case_id, approval_step_id, step_no, decision, decided_by, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          actor.tenantId,
          row.id,
          step.id,
          step.step_no,
          dto.decision,
          actor.userId,
          dto.reason?.trim() || null,
        ],
      );
      await this.audit.logInTransaction(client, {
        tenantId: actor.tenantId,
        actorType: 'tenant_user',
        actorId: actor.userId,
        action: `after_sales_case.${dto.decision}`,
        resourceType: 'after_sales_case_decision',
        resourceId: decision.rows[0].id,
        after: { case_id: row.id, step_no: step.step_no, decision: dto.decision },
        reason: dto.reason?.trim() || null,
      });
      let nextStatus = row.status;
      if (dto.decision === 'rejected') nextStatus = 'rejected';
      else {
        const remaining = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM after_sales_case_approval_steps step
             LEFT JOIN after_sales_case_decisions decision
               ON decision.approval_step_id = step.id AND decision.tenant_id = step.tenant_id
            WHERE step.case_id = $1 AND decision.id IS NULL`,
          [row.id],
        );
        if (remaining.rows[0].count === '0') nextStatus = 'approved';
      }
      const currentRow =
        nextStatus === row.status
          ? row
          : await this.updateCaseStatus(
              client,
              actor,
              row,
              nextStatus,
              `after_sales_case.${nextStatus}`,
            );
      return this.caseResponse(client, currentRow);
    });
  }

  async startAfterSalesCase(actor: SamplesAfterSalesActor, id: string) {
    this.assertAllScope(actor);
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const row = await this.caseById(client, actor, id, true, true);
      if (row.status !== 'approved') {
        throw new SampleAfterSalesConflictException(
          'Only an approved after-sales case can start execution',
          'AFTER_SALES_CASE_NOT_APPROVED',
        );
      }
      return this.caseResponse(
        client,
        await this.updateCaseStatus(
          client,
          actor,
          row,
          'executing',
          'after_sales_case.execution_started',
        ),
      );
    });
  }

  async executeAfterSalesCase(
    actor: SamplesAfterSalesActor,
    id: string,
    dto: ExecuteAfterSalesDto,
  ) {
    this.assertAllScope(actor);
    try {
      return await withTenantContext(this.pool, this.context(actor), async (client) => {
        const row = await this.caseById(client, actor, id, true, true);
        if (row.status !== 'executing') {
          throw new SampleAfterSalesConflictException(
            'Only an executing after-sales case can create an adjustment',
            'AFTER_SALES_CASE_NOT_EXECUTING',
          );
        }
        const match = await client.query<{ matches: boolean }>(
          `SELECT $1::numeric = $2::numeric AS matches`,
          [dto.amount, row.requested_amount],
        );
        if (!match.rows[0].matches) {
          throw new SampleAfterSalesConflictException(
            'Executed amount must equal the approved requested amount',
            'AFTER_SALES_AMOUNT_MISMATCH',
          );
        }
        const revision = await this.finance.appendAfterSalesAdjustmentInTransaction(client, actor, {
          caseId: row.id,
          caseNumber: row.case_number,
          caseType: row.case_type,
          salesOrderId: row.sales_order_id,
          amount: dto.amount,
          currency: row.currency,
          fxRateToRmb: dto.fx_rate_to_rmb,
          fxSource: dto.fx_source,
          fxCapturedAt: new Date(dto.fx_captured_at),
          externalReference: dto.external_reference,
          proofFileId: dto.proof_file_id ?? row.proof_file_id,
        });
        const updated = await this.updateCaseStatus(
          client,
          actor,
          row,
          'completed',
          'after_sales_case.completed',
        );
        return { case: await this.caseResponse(client, updated), revision };
      });
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (
        constraint === 'uq_after_sales_adjustment_case' ||
        constraint === 'uq_after_sales_adjustment_reference'
      ) {
        throw new SampleAfterSalesConflictException(
          'This adjustment or external reference has already been executed',
          'AFTER_SALES_DUPLICATE_ADJUSTMENT',
        );
      }
      throw error;
    }
  }

  async closeAfterSalesCase(actor: SamplesAfterSalesActor, id: string) {
    this.assertAllScope(actor);
    return withTenantContext(this.pool, this.context(actor), async (client) => {
      const row = await this.caseById(client, actor, id, true, true);
      if (row.status !== 'completed') {
        throw new SampleAfterSalesConflictException(
          'Only a completed after-sales case can be closed',
          'AFTER_SALES_CASE_NOT_COMPLETED',
        );
      }
      const currentCandidate = await client.query<{ id: string; lock_id: string | null }>(
        `SELECT candidate.id, lock.id AS lock_id
           FROM commission_candidates_v2 candidate
           LEFT JOIN commission_candidate_locks_v2 lock ON lock.candidate_id = candidate.id
          WHERE candidate.sales_order_id = $1
          ORDER BY candidate.version DESC LIMIT 1`,
        [row.sales_order_id],
      );
      if (!currentCandidate.rows[0]?.lock_id) {
        throw new SampleAfterSalesConflictException(
          'Lock the revised commission version before closing after-sales',
          'AFTER_SALES_REVISED_COMMISSION_NOT_LOCKED',
        );
      }
      return this.caseResponse(
        client,
        await this.updateCaseStatus(client, actor, row, 'closed', 'after_sales_case.closed'),
      );
    });
  }
}
