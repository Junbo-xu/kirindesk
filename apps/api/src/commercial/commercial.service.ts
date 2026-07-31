import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { ExportFile } from '../common/export-csv';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { BusinessEventsService } from '../workbench/business-events.service';
import {
  CommercialResourceNotFoundException,
  CommercialStateConflictException,
  DuplicateCustomerException,
  DuplicateReceiptException,
  InvalidCommercialDataException,
  LowMarginApprovalRequiredException,
  ReceiptProofRequiredException,
} from './commercial.errors';
import { UpdateCommercialSettingsDto } from './dto/commercial-settings.dto';
import { RecordCustomerReceiptDto, ReviewCustomerReceiptDto } from './dto/customer-receipt.dto';
import { LinkInquiryCustomerDto, UpgradeInquiryCustomerDto } from './dto/customer-upgrade.dto';
import { CreateProformaInvoiceDto, ReviseProformaInvoiceDto } from './dto/proforma-invoice.dto';

export interface CommercialActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

export interface CommercialSettings {
  minimum_margin_bps: number;
  procurement_gate_enabled: boolean;
  required_receipt_ratio_bps: number;
  receipt_proof_required: boolean;
  bypass_reason: string | null;
}

interface InquiryContext {
  id: string;
  owner_user_id: string;
  customer_id: string | null;
  customer_code: string;
  customer_country: string;
  status: string;
}

interface PiRow {
  id: string;
  tenant_id: string;
  series_id: string;
  inquiry_id: string;
  customer_id: string;
  sales_order_id: string | null;
  pi_number: string;
  version: number;
  currency: string;
  payment_terms: string;
  status: string;
  total_amount: string;
  created_by: string;
  issued_by: string | null;
  issued_at: Date | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PiItemRow {
  id: string;
  selection_id: string;
  line_no: number;
  description: string;
  specifications: string | null;
  quantity: string;
  unit: string;
  unit_price: string;
  line_total: string;
  selection_snapshot: Record<string, unknown>;
}

interface SelectionForPi {
  id: string;
  inquiry_item_id: string;
  sales_currency: string;
  sales_unit_price: string;
  gross_margin_bps: number;
  margin_status: string;
  snapshot_json: Record<string, unknown>;
  description: string;
  specifications: string | null;
  quantity: string;
  unit: string;
  line_total: string;
}

interface OrderContext {
  id: string;
  inquiry_id: string;
  proforma_invoice_id: string;
  owner_user_id: string;
  total_amount: string;
  currency: string;
  status: string;
}

interface ReceiptRow {
  id: string;
  proforma_invoice_id: string;
  sales_order_id: string;
  amount: string;
  currency: string;
  received_at: string;
  method: string;
  external_reference: string;
  proof_file_id: string | null;
  recorded_by: string;
  note: string | null;
  created_at: Date;
  decision: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
}

interface GateRow {
  id: string;
  sales_order_id: string;
  proforma_invoice_id: string;
  status: string;
  order_amount: string;
  confirmed_amount: string;
  required_amount: string;
  currency: string;
  required_ratio_bps: number;
  proof_required: boolean;
  config_enabled: boolean;
  bypass_reason: string | null;
  blocking_reasons: string[];
  evaluated_by: string;
  created_at: Date;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
}

const PI_COLUMNS = `p.id, p.tenant_id, p.series_id, p.inquiry_id, p.customer_id,
  p.sales_order_id, p.pi_number, p.version, p.currency, p.payment_terms,
  p.status, p.total_amount::text AS total_amount, p.created_by, p.issued_by,
  p.issued_at, p.confirmed_by, p.confirmed_at, p.created_at, p.updated_at`;
const PI_ITEM_COLUMNS = `id, selection_id, line_no, description, specifications,
  quantity::text AS quantity, unit, unit_price::text AS unit_price,
  line_total::text AS line_total, selection_snapshot`;
const RECEIPT_COLUMNS = `r.id, r.proforma_invoice_id, r.sales_order_id,
  r.amount::text AS amount, r.currency, r.received_at::text AS received_at,
  r.method, r.external_reference, r.proof_file_id, r.recorded_by, r.note,
  r.created_at, d.decision, d.decided_by, d.reason AS decision_reason,
  d.created_at AS decided_at`;
const GATE_COLUMNS = `id, sales_order_id, proforma_invoice_id, status,
  order_amount::text AS order_amount, confirmed_amount::text AS confirmed_amount,
  required_amount::text AS required_amount, currency, required_ratio_bps,
  proof_required, config_enabled, bypass_reason, blocking_reasons,
  evaluated_by, created_at`;
const DEFAULT_SETTINGS: CommercialSettings = {
  minimum_margin_bps: 1500,
  procurement_gate_enabled: true,
  required_receipt_ratio_bps: 10000,
  receipt_proof_required: true,
  bypass_reason: null,
};

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

@Injectable()
export class CommercialService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly events: BusinessEventsService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private async inquiry(
    client: PoolClient,
    actor: CommercialActor,
    inquiryId: string,
    lock = false,
  ): Promise<InquiryContext> {
    const params: unknown[] = [inquiryId];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND owner_user_id = $${params.length}`;
    }
    const result = await client.query<InquiryContext>(
      `SELECT id, owner_user_id, customer_id, customer_code, customer_country, status
         FROM inquiries
        WHERE id = $1${scope}${lock ? ' FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0)
      throw new CommercialResourceNotFoundException('Inquiry not found');
    return result.rows[0];
  }

  private async lockCustomerDuplicateKeys(
    client: PoolClient,
    tenantId: string,
    companyName: string,
    email: string | null,
  ): Promise<void> {
    const keys = await client.query<{ lock_key: string }>(
      `SELECT lock_key
         FROM (
           SELECT 'company:' || lower(btrim($1::text)) AS lock_key
           UNION ALL
           SELECT 'email:' || lower(btrim($2::text)) AS lock_key
            WHERE $2::text IS NOT NULL
         ) duplicate_keys
        ORDER BY lock_key`,
      [companyName, email],
    );
    for (const { lock_key: lockKey } of keys.rows) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `customer_duplicate:${tenantId}:${lockKey}`,
      ]);
    }
  }

  private settingsFromJson(value: unknown): CommercialSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
    const input = value as Partial<CommercialSettings>;
    return {
      minimum_margin_bps:
        Number.isInteger(input.minimum_margin_bps) &&
        input.minimum_margin_bps! >= -100000 &&
        input.minimum_margin_bps! <= 10000
          ? input.minimum_margin_bps!
          : DEFAULT_SETTINGS.minimum_margin_bps,
      procurement_gate_enabled:
        typeof input.procurement_gate_enabled === 'boolean'
          ? input.procurement_gate_enabled
          : DEFAULT_SETTINGS.procurement_gate_enabled,
      required_receipt_ratio_bps:
        Number.isInteger(input.required_receipt_ratio_bps) &&
        input.required_receipt_ratio_bps! >= 0 &&
        input.required_receipt_ratio_bps! <= 10000
          ? input.required_receipt_ratio_bps!
          : DEFAULT_SETTINGS.required_receipt_ratio_bps,
      receipt_proof_required:
        typeof input.receipt_proof_required === 'boolean'
          ? input.receipt_proof_required
          : DEFAULT_SETTINGS.receipt_proof_required,
      bypass_reason:
        typeof input.bypass_reason === 'string' && input.bypass_reason.trim()
          ? input.bypass_reason.trim()
          : null,
    };
  }

  private async readSettings(client: PoolClient): Promise<CommercialSettings> {
    const result = await client.query<{ value_json: unknown }>(
      `SELECT value_json FROM tenant_settings WHERE key = 'commercial_workflow' LIMIT 1`,
    );
    return this.settingsFromJson(result.rows[0]?.value_json);
  }

  async getSettings(actor: CommercialActor): Promise<CommercialSettings> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      (client) => this.readSettings(client),
    );
  }

  async updateSettings(
    actor: CommercialActor,
    dto: UpdateCommercialSettingsDto,
  ): Promise<CommercialSettings> {
    const bypassReason = dto.bypass_reason?.trim() || null;
    if (!dto.procurement_gate_enabled && !bypassReason) {
      throw new InvalidCommercialDataException(
        'bypass_reason is required when the procurement gate is disabled',
        'PROCUREMENT_GATE_BYPASS_REASON_REQUIRED',
      );
    }
    const after: CommercialSettings = {
      minimum_margin_bps: dto.minimum_margin_bps,
      procurement_gate_enabled: dto.procurement_gate_enabled,
      required_receipt_ratio_bps: dto.required_receipt_ratio_bps,
      receipt_proof_required: dto.receipt_proof_required,
      bypass_reason: dto.procurement_gate_enabled ? null : bypassReason,
    };

    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const before = await this.readSettings(client);
        await client.query(
          `INSERT INTO tenant_settings (tenant_id, key, value_json, updated_by)
           VALUES ($1, 'commercial_workflow', $2, $3)
           ON CONFLICT (tenant_id, key)
           DO UPDATE SET value_json = EXCLUDED.value_json,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = now()`,
          [actor.tenantId, JSON.stringify(after), actor.userId],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'commercial_settings.updated',
          resourceType: 'tenant_settings',
          resourceId: 'commercial_workflow',
          before,
          after,
          reason: after.bypass_reason,
        });
        const orders = await client.query<OrderContext>(
          `SELECT so.id, so.inquiry_id, p.id AS proforma_invoice_id,
                  so.owner_user_id, so.total_amount::text AS total_amount,
                  so.currency, so.status
             FROM sales_orders so
             JOIN proforma_invoices p ON p.id = so.source_pi_id AND p.tenant_id = so.tenant_id
            WHERE so.deleted_at IS NULL
              AND so.status IN ('customer_confirmed', 'payment_gate_open')
            ORDER BY so.created_at, so.id
            FOR UPDATE OF so`,
        );
        for (const order of orders.rows) {
          await this.evaluateGateInTransaction(client, actor, order, after);
        }
        return after;
      },
    );
  }

  async upgradeInquiryCustomer(
    actor: CommercialActor,
    inquiryId: string,
    dto: UpgradeInquiryCustomerDto,
  ) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const inquiry = await this.inquiry(client, actor, inquiryId, true);
        if (inquiry.customer_id) {
          throw new CommercialStateConflictException(
            'Inquiry is already linked to a customer',
            'INQUIRY_CUSTOMER_ALREADY_LINKED',
          );
        }
        const companyName = dto.company_name.trim();
        const email = dto.email?.trim().toLowerCase() || null;
        await this.lockCustomerDuplicateKeys(client, actor.tenantId, companyName, email);
        const duplicateParams: unknown[] = [companyName, email];
        const duplicates = await client.query<{
          id: string;
          company_name: string;
          email: string | null;
          owner_user_id: string;
        }>(
          `SELECT id, company_name, email, owner_user_id
             FROM customers
            WHERE deleted_at IS NULL
              AND (
                lower(btrim(company_name)) = lower(btrim($1))
                OR ($2::text IS NOT NULL AND lower(email) = lower($2))
              )
            ORDER BY created_at, id
            LIMIT 10`,
          duplicateParams,
        );
        if (duplicates.rows.length > 0) {
          const visibleCandidates = duplicates.rows
            .filter(
              (candidate) =>
                !this.restrictsToOwner(actor.dataScope) || candidate.owner_user_id === actor.userId,
            )
            .map(({ id, company_name, email: candidateEmail }) => ({
              id,
              company_name,
              email: candidateEmail,
            }));
          throw new DuplicateCustomerException(visibleCandidates);
        }

        const created = await client.query<{
          id: string;
          company_name: string;
          contact_name: string | null;
          email: string | null;
          phone: string | null;
          country: string | null;
          owner_user_id: string;
          source: string;
        }>(
          `INSERT INTO customers
             (tenant_id, owner_user_id, company_name, contact_name, email, phone,
              country, source, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'inquiry_upgrade', 'active')
           RETURNING id, company_name, contact_name, email, phone, country, owner_user_id, source`,
          [
            actor.tenantId,
            inquiry.owner_user_id,
            companyName,
            dto.contact_name?.trim() || null,
            email,
            dto.phone?.trim() || null,
            dto.country?.trim() || inquiry.customer_country,
          ],
        );
        const customer = created.rows[0];
        await client.query(
          `UPDATE inquiries SET customer_id = $1, updated_at = now() WHERE id = $2`,
          [customer.id, inquiry.id],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'customer.created_from_inquiry',
          resourceType: 'customer',
          resourceId: customer.id,
          after: customer,
        });
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'inquiry.customer_upgraded',
          resourceType: 'inquiry',
          resourceId: inquiry.id,
          before: { customer_id: null },
          after: { customer_id: customer.id },
        });
        await this.recordEvent(
          client,
          actor,
          inquiry,
          'customer',
          customer.id,
          'customer.upgraded',
        );
        return customer;
      },
    );
  }

  async linkInquiryCustomer(
    actor: CommercialActor,
    inquiryId: string,
    dto: LinkInquiryCustomerDto,
  ) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const inquiry = await this.inquiry(client, actor, inquiryId, true);
        if (inquiry.customer_id) {
          throw new CommercialStateConflictException(
            'Inquiry is already linked to a customer',
            'INQUIRY_CUSTOMER_ALREADY_LINKED',
          );
        }
        const params: unknown[] = [dto.customer_id];
        let scope = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scope = ` AND owner_user_id = $${params.length}`;
        }
        const customer = await client.query<{
          id: string;
          company_name: string;
          email: string | null;
        }>(
          `SELECT id, company_name, email FROM customers
            WHERE id = $1 AND deleted_at IS NULL${scope}`,
          params,
        );
        if (customer.rows.length === 0) {
          throw new CommercialResourceNotFoundException('Customer not found');
        }
        await client.query(
          `UPDATE inquiries SET customer_id = $1, updated_at = now() WHERE id = $2`,
          [dto.customer_id, inquiry.id],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'inquiry.customer_linked',
          resourceType: 'inquiry',
          resourceId: inquiry.id,
          before: { customer_id: null },
          after: { customer_id: dto.customer_id },
        });
        await this.recordEvent(
          client,
          actor,
          inquiry,
          'customer',
          dto.customer_id,
          'customer.linked',
        );
        return customer.rows[0];
      },
    );
  }

  async approveLowMargin(actor: CommercialActor, selectionId: string, reason: string) {
    const approvalReason = reason.trim();
    if (!approvalReason) {
      throw new InvalidCommercialDataException('Approval reason is required');
    }
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const params: unknown[] = [selectionId];
          let scope = '';
          if (this.restrictsToOwner(actor.dataScope)) {
            params.push(actor.userId);
            scope = ` AND i.owner_user_id = $${params.length}`;
          }
          const selection = await client.query<{
            id: string;
            inquiry_id: string;
            margin_status: string | null;
            owner_user_id: string;
          }>(
            `SELECT s.id, s.inquiry_id, s.margin_status, i.owner_user_id
               FROM quote_selection_snapshots s
               JOIN inquiries i ON i.id = s.inquiry_id AND i.tenant_id = s.tenant_id
              WHERE s.id = $1${scope}`,
            params,
          );
          if (selection.rows.length === 0) {
            throw new CommercialResourceNotFoundException('Quote selection not found');
          }
          if (selection.rows[0].margin_status !== 'below_threshold') {
            throw new CommercialStateConflictException(
              'Only a below-threshold selection needs margin approval',
              'MARGIN_APPROVAL_NOT_REQUIRED',
            );
          }
          const inserted = await client.query<{
            id: string;
            selection_id: string;
            approved_by: string;
            reason: string;
            created_at: Date;
          }>(
            `INSERT INTO quote_selection_margin_approvals
               (tenant_id, selection_id, approved_by, reason)
             VALUES ($1, $2, $3, $4)
             RETURNING id, selection_id, approved_by, reason, created_at`,
            [actor.tenantId, selectionId, actor.userId, approvalReason],
          );
          const approval = inserted.rows[0];
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'quote_selection.margin_approved',
            resourceType: 'quote_selection',
            resourceId: selectionId,
            after: approval,
            reason: approvalReason,
          });
          await this.events.recordInTransaction(client, {
            tenantId: actor.tenantId,
            chainType: 'inquiry',
            chainId: selection.rows[0].inquiry_id,
            credentialType: 'quote_selection',
            credentialId: selectionId,
            eventType: 'quote_selection.margin_approved',
            actorType: 'tenant_user',
            actorId: actor.userId,
            scopeUserId: selection.rows[0].owner_user_id,
            visibilityPermission: 'inquiries:view',
          });
          return approval;
        },
      );
    } catch (error) {
      if ((error as PgErrorLike).constraint === 'uq_quote_selection_margin_approval') {
        throw new CommercialStateConflictException(
          'Selection margin has already been approved',
          'MARGIN_ALREADY_APPROVED',
        );
      }
      throw error;
    }
  }

  async createProformaInvoice(
    actor: CommercialActor,
    inquiryId: string,
    dto: CreateProformaInvoiceDto,
  ) {
    const paymentTerms = dto.payment_terms.trim();
    if (!paymentTerms) throw new InvalidCommercialDataException('Payment terms are required');
    const selectionIds = [...new Set(dto.selection_ids)];
    if (selectionIds.length !== dto.selection_ids.length) {
      throw new InvalidCommercialDataException('selection_ids contains duplicates');
    }

    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const inquiry = await this.inquiry(client, actor, inquiryId, true);
          if (!inquiry.customer_id) {
            throw new CommercialStateConflictException(
              'Upgrade or link the inquiry customer before creating a PI',
              'CUSTOMER_UPGRADE_REQUIRED',
            );
          }
          const selections = await this.selectionsForPi(client, inquiryId, selectionIds);
          if (selections.length !== selectionIds.length) {
            throw new CommercialResourceNotFoundException('One or more selections were not found');
          }
          const currencies = new Set(selections.map((selection) => selection.sales_currency));
          if (currencies.size !== 1) {
            throw new InvalidCommercialDataException('A PI must use one sales currency');
          }
          const total = await client.query<{ total: string }>(
            `SELECT round(sum(value::numeric), 2)::text AS total
               FROM unnest($1::text[]) AS value`,
            [selections.map((selection) => selection.line_total)],
          );
          const identity = await client.query<{ id: string; series_id: string; pi_number: string }>(
            `SELECT generated.id, uuid_generate_v4()::text AS series_id,
                    'PI-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
                      || upper(substr(replace(generated.id::text, '-', ''), 1, 8)) AS pi_number
               FROM (SELECT uuid_generate_v4() AS id) generated`,
          );
          const ids = identity.rows[0];
          const inserted = await client.query<PiRow>(
            `INSERT INTO proforma_invoices
               (id, tenant_id, series_id, inquiry_id, customer_id, pi_number, version,
                currency, payment_terms, total_amount, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10)
             RETURNING ${PI_COLUMNS.replaceAll('p.', '')}`,
            [
              ids.id,
              actor.tenantId,
              ids.series_id,
              inquiry.id,
              inquiry.customer_id,
              ids.pi_number,
              selections[0].sales_currency,
              paymentTerms,
              total.rows[0].total,
              actor.userId,
            ],
          );
          const pi = inserted.rows[0];
          for (const [index, selection] of selections.entries()) {
            await client.query(
              `INSERT INTO proforma_invoice_series_selections
                 (tenant_id, series_id, selection_id)
               VALUES ($1, $2, $3)`,
              [actor.tenantId, pi.series_id, selection.id],
            );
            await client.query(
              `INSERT INTO proforma_invoice_items
                 (tenant_id, proforma_invoice_id, series_id, selection_id, line_no,
                  description, specifications, quantity, unit, unit_price, line_total,
                  selection_snapshot)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
              [
                actor.tenantId,
                pi.id,
                pi.series_id,
                selection.id,
                index + 1,
                selection.description,
                selection.specifications,
                selection.quantity,
                selection.unit,
                selection.sales_unit_price,
                selection.line_total,
                JSON.stringify(selection.snapshot_json),
              ],
            );
          }
          const response = await this.piResponse(client, pi);
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'proforma_invoice.created',
            resourceType: 'proforma_invoice',
            resourceId: pi.id,
            after: response,
          });
          await this.recordEvent(
            client,
            actor,
            inquiry,
            'proforma_invoice',
            pi.id,
            'proforma_invoice.created',
          );
          return response;
        },
      );
    } catch (error) {
      if ((error as PgErrorLike).constraint === 'uq_pi_selection_allocation') {
        throw new CommercialStateConflictException(
          'A selection is already allocated to another PI series',
          'SELECTION_ALREADY_ALLOCATED',
        );
      }
      throw error;
    }
  }

  async reviseProformaInvoice(actor: CommercialActor, piId: string, dto: ReviseProformaInvoiceDto) {
    const paymentTerms = dto.payment_terms.trim();
    if (!paymentTerms) throw new InvalidCommercialDataException('Payment terms are required');
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const base = await this.pi(client, actor, piId, true);
        await this.assertCurrentPiVersion(client, base);
        if (base.status === 'customer_confirmed') {
          throw new CommercialStateConflictException(
            'A customer-confirmed PI cannot be revised',
            'PI_ALREADY_CONFIRMED',
          );
        }
        const identity = await client.query<{ id: string }>(
          `SELECT uuid_generate_v4()::text AS id`,
        );
        const inserted = await client.query<PiRow>(
          `INSERT INTO proforma_invoices
             (id, tenant_id, series_id, inquiry_id, customer_id, pi_number, version,
              currency, payment_terms, total_amount, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${PI_COLUMNS.replaceAll('p.', '')}`,
          [
            identity.rows[0].id,
            actor.tenantId,
            base.series_id,
            base.inquiry_id,
            base.customer_id,
            base.pi_number,
            base.version + 1,
            base.currency,
            paymentTerms,
            base.total_amount,
            actor.userId,
          ],
        );
        const next = inserted.rows[0];
        await client.query(
          `INSERT INTO proforma_invoice_items
             (tenant_id, proforma_invoice_id, series_id, selection_id, line_no,
              description, specifications, quantity, unit, unit_price, line_total,
              selection_snapshot)
           SELECT tenant_id, $1, series_id, selection_id, line_no, description,
                  specifications, quantity, unit, unit_price, line_total, selection_snapshot
             FROM proforma_invoice_items
            WHERE proforma_invoice_id = $2
            ORDER BY line_no`,
          [next.id, base.id],
        );
        const response = await this.piResponse(client, next);
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'proforma_invoice.revised',
          resourceType: 'proforma_invoice',
          resourceId: next.id,
          before: { id: base.id, version: base.version, status: base.status },
          after: { id: next.id, version: next.version, status: next.status },
        });
        const inquiry = await this.inquiry(client, actor, base.inquiry_id);
        await this.recordEvent(
          client,
          actor,
          inquiry,
          'proforma_invoice',
          next.id,
          'proforma_invoice.revised',
        );
        return response;
      },
    );
  }

  async listProformaInvoices(actor: CommercialActor, inquiryId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.inquiry(client, actor, inquiryId);
        const rows = await client.query<PiRow>(
          `SELECT ${PI_COLUMNS}
             FROM proforma_invoices p
            WHERE p.inquiry_id = $1
            ORDER BY p.created_at DESC, p.id DESC`,
          [inquiryId],
        );
        const currentBySeries = new Map<string, number>();
        for (const row of rows.rows) {
          currentBySeries.set(
            row.series_id,
            Math.max(currentBySeries.get(row.series_id) ?? 0, row.version),
          );
        }
        return Promise.all(
          rows.rows.map(async (row) => ({
            ...(await this.piResponse(client, row)),
            is_current: currentBySeries.get(row.series_id) === row.version,
          })),
        );
      },
    );
  }

  async getProformaInvoice(actor: CommercialActor, piId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.pi(client, actor, piId);
        return {
          ...(await this.piResponse(client, row)),
          is_current: await this.isCurrentPiVersion(client, row),
        };
      },
    );
  }

  async issueProformaInvoice(actor: CommercialActor, piId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const before = await this.pi(client, actor, piId, true);
        await this.assertCurrentPiVersion(client, before);
        if (before.status !== 'draft') {
          throw new CommercialStateConflictException(
            'Only a current draft PI can be issued',
            'PI_NOT_ISSUABLE',
          );
        }
        const blocked = await client.query<{ selection_id: string }>(
          `SELECT item.selection_id
             FROM proforma_invoice_items item
             JOIN quote_selection_snapshots selection
               ON selection.id = item.selection_id AND selection.tenant_id = item.tenant_id
             LEFT JOIN quote_selection_margin_approvals approval
               ON approval.selection_id = selection.id AND approval.tenant_id = selection.tenant_id
            WHERE item.proforma_invoice_id = $1
              AND selection.margin_status = 'below_threshold'
              AND approval.id IS NULL
            ORDER BY item.line_no`,
          [before.id],
        );
        if (blocked.rows.length > 0) {
          throw new LowMarginApprovalRequiredException(blocked.rows.map((row) => row.selection_id));
        }
        const updated = await client.query<PiRow>(
          `UPDATE proforma_invoices
              SET status = 'issued', issued_by = $1, issued_at = now(), updated_at = now()
            WHERE id = $2
            RETURNING ${PI_COLUMNS.replaceAll('p.', '')}`,
          [actor.userId, before.id],
        );
        const response = await this.piResponse(client, updated.rows[0]);
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'proforma_invoice.issued',
          resourceType: 'proforma_invoice',
          resourceId: before.id,
          before: { status: before.status },
          after: { status: updated.rows[0].status, issued_at: updated.rows[0].issued_at },
        });
        const inquiry = await this.inquiry(client, actor, before.inquiry_id);
        await this.recordEvent(
          client,
          actor,
          inquiry,
          'proforma_invoice',
          before.id,
          'proforma_invoice.issued',
        );
        return response;
      },
    );
  }

  async confirmProformaInvoice(actor: CommercialActor, piId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const before = await this.pi(client, actor, piId, true);
        await this.assertCurrentPiVersion(client, before);
        if (before.status !== 'issued') {
          throw new CommercialStateConflictException(
            'Only a current issued PI can be customer-confirmed',
            'PI_NOT_CONFIRMABLE',
          );
        }
        const inquiry = await this.inquiry(client, actor, before.inquiry_id, true);
        const identity = await client.query<{ id: string; order_number: string }>(
          `SELECT generated.id,
                  'SO-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYYMMDD') || '-'
                    || upper(substr(replace(generated.id::text, '-', ''), 1, 8)) AS order_number
             FROM (SELECT uuid_generate_v4() AS id) generated`,
        );
        const orderId = identity.rows[0].id;
        await client.query(
          `INSERT INTO sales_orders
             (id, tenant_id, customer_id, owner_user_id, order_number, pi_number,
              currency, total_amount, status, inquiry_id, source_pi_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'customer_confirmed',$9,$10)`,
          [
            orderId,
            actor.tenantId,
            before.customer_id,
            inquiry.owner_user_id,
            identity.rows[0].order_number,
            before.pi_number,
            before.currency,
            before.total_amount,
            before.inquiry_id,
            before.id,
          ],
        );
        await client.query(
          `INSERT INTO sales_order_items
             (tenant_id, order_id, line_no, description, unit, quantity,
              unit_price, line_total)
           SELECT tenant_id, $1, line_no, description, unit, quantity,
                  unit_price, line_total
             FROM proforma_invoice_items
            WHERE proforma_invoice_id = $2
            ORDER BY line_no`,
          [orderId, before.id],
        );
        const updated = await client.query<PiRow>(
          `UPDATE proforma_invoices
              SET status = 'customer_confirmed', confirmed_by = $1,
                  confirmed_at = now(), sales_order_id = $2, updated_at = now()
            WHERE id = $3
            RETURNING ${PI_COLUMNS.replaceAll('p.', '')}`,
          [actor.userId, orderId, before.id],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'proforma_invoice.customer_confirmed',
          resourceType: 'proforma_invoice',
          resourceId: before.id,
          before: { status: before.status, sales_order_id: null },
          after: { status: 'customer_confirmed', sales_order_id: orderId },
        });
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'sales_order.created_from_pi',
          resourceType: 'sales_order',
          resourceId: orderId,
          after: {
            inquiry_id: before.inquiry_id,
            source_pi_id: before.id,
            currency: before.currency,
            total_amount: before.total_amount,
            status: 'customer_confirmed',
          },
        });
        await this.recordEvent(
          client,
          actor,
          inquiry,
          'proforma_invoice',
          before.id,
          'proforma_invoice.customer_confirmed',
        );
        await this.recordEvent(
          client,
          actor,
          inquiry,
          'sales_order',
          orderId,
          'sales_order.created_from_pi',
        );
        const order = await this.orderById(client, actor, orderId, true);
        const gate = await this.evaluateGateInTransaction(
          client,
          actor,
          order,
          await this.readSettings(client),
        );
        const finalOrder = await this.orderById(client, actor, orderId);
        return {
          proforma_invoice: await this.piResponse(client, updated.rows[0]),
          sales_order: this.orderResponse(finalOrder),
          procurement_gate: this.gateResponse(gate),
        };
      },
    );
  }

  async exportProformaInvoice(actor: CommercialActor, piId: string): Promise<ExportFile> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const pi = await this.pi(client, actor, piId);
        const items = await this.piItems(client, pi.id);
        const customer = await client.query<{
          company_name: string;
          contact_name: string | null;
          email: string | null;
          country: string | null;
        }>(
          `SELECT company_name, contact_name, email, country
             FROM customers WHERE id = $1 AND deleted_at IS NULL`,
          [pi.customer_id],
        );
        const user = await client.query<{ email: string }>(
          `SELECT email FROM users WHERE id = $1`,
          [actor.userId],
        );
        const exportedAt = new Date();
        const statusWatermark = pi.status === 'draft' ? 'DRAFT / 草稿' : 'CONFIDENTIAL / 机密';
        const itemRows = items
          .map(
            (item) =>
              `<tr><td>${item.line_no}</td><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.quantity)}</td><td>${escapeHtml(item.unit)}</td><td>${escapeHtml(item.unit_price)}</td><td>${escapeHtml(item.line_total)}</td></tr>`,
          )
          .join('');
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(pi.pi_number)} v${pi.version}</title><style>body{font-family:Arial,sans-serif;margin:40px;color:#172033}header{display:flex;justify-content:space-between}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:left}.total{text-align:right;font-weight:700}.watermark{position:fixed;right:18px;bottom:12px;color:#475569;border:1px solid #94a3b8;background:#f8fafccc;padding:6px;font-size:11px}</style></head><body><header><div><h1>PROFORMA INVOICE</h1><p>${escapeHtml(pi.pi_number)} · Version ${pi.version}</p></div><div><strong>${escapeHtml(statusWatermark)}</strong><p>${escapeHtml(pi.status)}</p></div></header><section><p>Customer: ${escapeHtml(customer.rows[0]?.company_name)}</p><p>Contact: ${escapeHtml(customer.rows[0]?.contact_name)}</p><p>Email: ${escapeHtml(customer.rows[0]?.email)}</p><p>Country: ${escapeHtml(customer.rows[0]?.country)}</p></section><table><thead><tr><th>#</th><th>Description</th><th>Quantity</th><th>Unit</th><th>Unit Price (${escapeHtml(pi.currency)})</th><th>Line Total</th></tr></thead><tbody>${itemRows}</tbody></table><p class="total">Total: ${escapeHtml(pi.currency)} ${escapeHtml(pi.total_amount)}</p><h3>Payment Terms</h3><p>${escapeHtml(pi.payment_terms)}</p><div class="watermark">${escapeHtml(statusWatermark)} · ${escapeHtml(user.rows[0]?.email)} · tenant ${escapeHtml(actor.tenantId)} · ${escapeHtml(exportedAt.toISOString())}</div></body></html>`;
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'proforma_invoice.exported',
          resourceType: 'proforma_invoice',
          resourceId: pi.id,
          metadata: {
            pi_number: pi.pi_number,
            version: pi.version,
            status: pi.status,
            item_count: items.length,
            exported_at: exportedAt.toISOString(),
          },
        });
        return {
          filename: `${pi.pi_number}-v${pi.version}.html`,
          mime: 'text/html; charset=utf-8',
          body: Buffer.from(html, 'utf8'),
        };
      },
    );
  }

  async recordReceipt(actor: CommercialActor, orderId: string, dto: RecordCustomerReceiptDto) {
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const order = await this.orderById(client, actor, orderId, true);
          if (dto.currency !== order.currency) {
            throw new InvalidCommercialDataException(
              'Receipt currency must match the frozen PI currency',
              'RECEIPT_CURRENCY_MISMATCH',
            );
          }
          const future = await client.query<{ future: boolean }>(
            `SELECT $1::date > CURRENT_DATE AS future`,
            [dto.received_at],
          );
          if (future.rows[0].future) {
            throw new InvalidCommercialDataException('received_at cannot be in the future');
          }
          const settings = await this.readSettings(client);
          if (settings.receipt_proof_required && !dto.proof_file_id) {
            throw new ReceiptProofRequiredException();
          }
          if (dto.proof_file_id) {
            const params: unknown[] = [dto.proof_file_id];
            let scope = '';
            if (this.restrictsToOwner(actor.dataScope)) {
              params.push(actor.userId);
              scope = ` AND uploaded_by = $${params.length}`;
            }
            const file = await client.query(
              `SELECT id FROM files WHERE id = $1 AND deleted_at IS NULL${scope}`,
              params,
            );
            if (file.rows.length === 0) {
              throw new CommercialResourceNotFoundException('Receipt proof file not found');
            }
          }
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO customer_receipts
               (tenant_id, proforma_invoice_id, sales_order_id, amount, currency,
                received_at, method, external_reference, proof_file_id, recorded_by, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id`,
            [
              actor.tenantId,
              order.proforma_invoice_id,
              order.id,
              dto.amount,
              dto.currency,
              dto.received_at,
              dto.method,
              dto.external_reference.trim(),
              dto.proof_file_id ?? null,
              actor.userId,
              dto.note?.trim() || null,
            ],
          );
          const receipt = await this.receipt(client, actor, inserted.rows[0].id);
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'customer_receipt.recorded',
            resourceType: 'customer_receipt',
            resourceId: receipt.id,
            after: this.receiptResponse(receipt),
          });
          await this.events.recordInTransaction(client, {
            tenantId: actor.tenantId,
            chainType: 'sales_order',
            chainId: order.id,
            credentialType: 'customer_receipt',
            credentialId: receipt.id,
            eventType: 'customer_receipt.recorded',
            actorType: 'tenant_user',
            actorId: actor.userId,
            scopeUserId: order.owner_user_id,
            visibilityPermission: 'customer_receipts:view',
          });
          const gate = await this.evaluateGateInTransaction(client, actor, order, settings);
          return {
            receipt: this.receiptResponse(receipt),
            procurement_gate: this.gateResponse(gate),
          };
        },
      );
    } catch (error) {
      if ((error as PgErrorLike).constraint === 'uq_customer_receipt_reference') {
        throw new DuplicateReceiptException();
      }
      throw error;
    }
  }

  async listReceipts(actor: CommercialActor, orderId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.orderById(client, actor, orderId);
        const rows = await client.query<ReceiptRow>(
          `SELECT ${RECEIPT_COLUMNS}
             FROM customer_receipts r
             LEFT JOIN customer_receipt_decisions d
               ON d.receipt_id = r.id AND d.tenant_id = r.tenant_id
            WHERE r.sales_order_id = $1
            ORDER BY r.received_at DESC, r.created_at DESC, r.id DESC`,
          [orderId],
        );
        return rows.rows.map((row) => this.receiptResponse(row));
      },
    );
  }

  async reviewReceipt(actor: CommercialActor, receiptId: string, dto: ReviewCustomerReceiptDto) {
    const reason = dto.reason?.trim() || null;
    if (dto.decision === 'rejected' && !reason) {
      throw new InvalidCommercialDataException(
        'A rejection reason is required; record a new receipt to recover',
        'RECEIPT_REJECTION_REASON_REQUIRED',
      );
    }
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const before = await this.receipt(client, actor, receiptId);
          if (before.decision) {
            throw new CommercialStateConflictException(
              'Receipt has already been reviewed; record a replacement receipt if needed',
              'RECEIPT_ALREADY_REVIEWED',
            );
          }
          if (before.recorded_by === actor.userId) {
            throw new CommercialStateConflictException(
              'The receipt recorder cannot review the same receipt',
              'RECEIPT_SELF_REVIEW_FORBIDDEN',
            );
          }
          const order = await this.orderById(client, actor, before.sales_order_id, true);
          const settings = await this.readSettings(client);
          if (
            dto.decision === 'confirmed' &&
            settings.receipt_proof_required &&
            !before.proof_file_id
          ) {
            throw new ReceiptProofRequiredException();
          }
          await client.query(
            `INSERT INTO customer_receipt_decisions
               (tenant_id, receipt_id, decision, decided_by, reason)
             VALUES ($1,$2,$3,$4,$5)`,
            [actor.tenantId, before.id, dto.decision, actor.userId, reason],
          );
          const after = await this.receipt(client, actor, receiptId);
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: `customer_receipt.${dto.decision}`,
            resourceType: 'customer_receipt',
            resourceId: receiptId,
            before: this.receiptResponse(before),
            after: this.receiptResponse(after),
            reason,
          });
          await this.events.recordInTransaction(client, {
            tenantId: actor.tenantId,
            chainType: 'sales_order',
            chainId: order.id,
            credentialType: 'customer_receipt',
            credentialId: receiptId,
            eventType: `customer_receipt.${dto.decision}`,
            actorType: 'tenant_user',
            actorId: actor.userId,
            scopeUserId: order.owner_user_id,
            visibilityPermission: 'customer_receipts:view',
          });
          const gate = await this.evaluateGateInTransaction(client, actor, order, settings);
          return {
            receipt: this.receiptResponse(after),
            procurement_gate: this.gateResponse(gate),
          };
        },
      );
    } catch (error) {
      if ((error as PgErrorLike).constraint === 'uq_customer_receipt_decision') {
        throw new CommercialStateConflictException(
          'Receipt has already been reviewed',
          'RECEIPT_ALREADY_REVIEWED',
        );
      }
      throw error;
    }
  }

  async getProcurementGate(actor: CommercialActor, orderId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.orderById(client, actor, orderId);
        const row = await client.query<GateRow>(
          `SELECT ${GATE_COLUMNS}
             FROM procurement_gate_evaluations
            WHERE sales_order_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 1`,
          [orderId],
        );
        if (row.rows.length === 0) {
          throw new CommercialResourceNotFoundException('Procurement gate has not been evaluated');
        }
        return this.gateResponse(row.rows[0]);
      },
    );
  }

  async evaluateProcurementGate(actor: CommercialActor, orderId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const order = await this.orderById(client, actor, orderId, true);
        const gate = await this.evaluateGateInTransaction(
          client,
          actor,
          order,
          await this.readSettings(client),
        );
        return this.gateResponse(gate);
      },
    );
  }

  private async selectionsForPi(
    client: PoolClient,
    inquiryId: string,
    selectionIds: string[],
  ): Promise<SelectionForPi[]> {
    const result = await client.query<SelectionForPi>(
      `SELECT s.id, s.inquiry_item_id, s.sales_currency,
              s.sales_unit_price::text AS sales_unit_price,
              s.gross_margin_bps, s.margin_status, s.snapshot_json,
              item.description, item.specifications,
              item.quantity::text AS quantity, item.unit,
              round(item.quantity * s.sales_unit_price, 2)::text AS line_total
         FROM quote_selection_snapshots s
         JOIN inquiry_items item
           ON item.id = s.inquiry_item_id AND item.tenant_id = s.tenant_id
        WHERE s.inquiry_id = $1
          AND s.id = ANY($2::uuid[])
          AND s.sales_currency IS NOT NULL
          AND s.sales_unit_price IS NOT NULL
        ORDER BY item.line_no, s.id`,
      [inquiryId, selectionIds],
    );
    return result.rows;
  }

  private async pi(
    client: PoolClient,
    actor: CommercialActor,
    piId: string,
    lock = false,
  ): Promise<PiRow> {
    const params: unknown[] = [piId];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND i.owner_user_id = $${params.length}`;
    }
    const result = await client.query<PiRow>(
      `SELECT ${PI_COLUMNS}
         FROM proforma_invoices p
         JOIN inquiries i ON i.id = p.inquiry_id AND i.tenant_id = p.tenant_id
        WHERE p.id = $1${scope}${lock ? ' FOR UPDATE OF p' : ''}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new CommercialResourceNotFoundException('Proforma invoice not found');
    }
    return result.rows[0];
  }

  private async piItems(client: PoolClient, piId: string): Promise<PiItemRow[]> {
    const result = await client.query<PiItemRow>(
      `SELECT ${PI_ITEM_COLUMNS}
         FROM proforma_invoice_items
        WHERE proforma_invoice_id = $1
        ORDER BY line_no`,
      [piId],
    );
    return result.rows;
  }

  private async piResponse(client: PoolClient, row: PiRow) {
    return {
      id: row.id,
      series_id: row.series_id,
      inquiry_id: row.inquiry_id,
      customer_id: row.customer_id,
      sales_order_id: row.sales_order_id,
      pi_number: row.pi_number,
      version: row.version,
      currency: row.currency,
      payment_terms: row.payment_terms,
      status: row.status,
      total_amount: row.total_amount,
      issued_at: row.issued_at,
      confirmed_at: row.confirmed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      items: await this.piItems(client, row.id),
    };
  }

  private async isCurrentPiVersion(client: PoolClient, pi: PiRow): Promise<boolean> {
    const result = await client.query<{ version: number }>(
      `SELECT max(version)::integer AS version
         FROM proforma_invoices
        WHERE series_id = $1`,
      [pi.series_id],
    );
    return result.rows[0].version === pi.version;
  }

  private async assertCurrentPiVersion(client: PoolClient, pi: PiRow): Promise<void> {
    if (!(await this.isCurrentPiVersion(client, pi))) {
      throw new CommercialStateConflictException(
        'Only the current PI version can be changed',
        'PI_VERSION_SUPERSEDED',
      );
    }
  }

  private async orderById(
    client: PoolClient,
    actor: CommercialActor,
    orderId: string,
    lock = false,
  ): Promise<OrderContext> {
    const params: unknown[] = [orderId];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND so.owner_user_id = $${params.length}`;
    }
    const result = await client.query<OrderContext>(
      `SELECT so.id, so.inquiry_id, p.id AS proforma_invoice_id, so.owner_user_id,
              so.total_amount::text AS total_amount, so.currency, so.status
         FROM sales_orders so
         JOIN proforma_invoices p ON p.id = so.source_pi_id AND p.tenant_id = so.tenant_id
        WHERE so.id = $1 AND so.deleted_at IS NULL${scope}${lock ? ' FOR UPDATE OF so' : ''}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new CommercialResourceNotFoundException('PI-backed sales order not found');
    }
    return result.rows[0];
  }

  private orderResponse(order: OrderContext) {
    return {
      id: order.id,
      inquiry_id: order.inquiry_id,
      source_pi_id: order.proforma_invoice_id,
      owner_user_id: order.owner_user_id,
      total_amount: order.total_amount,
      currency: order.currency,
      status: order.status,
    };
  }

  private async receipt(
    client: PoolClient,
    actor: CommercialActor,
    receiptId: string,
    lock = false,
  ): Promise<ReceiptRow> {
    const params: unknown[] = [receiptId];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND so.owner_user_id = $${params.length}`;
    }
    const result = await client.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS}
         FROM customer_receipts r
         JOIN sales_orders so ON so.id = r.sales_order_id AND so.tenant_id = r.tenant_id
         LEFT JOIN customer_receipt_decisions d
           ON d.receipt_id = r.id AND d.tenant_id = r.tenant_id
        WHERE r.id = $1${scope}${lock ? ' FOR UPDATE OF r' : ''}`,
      params,
    );
    if (result.rows.length === 0) {
      throw new CommercialResourceNotFoundException('Customer receipt not found');
    }
    return result.rows[0];
  }

  private receiptResponse(row: ReceiptRow) {
    return {
      id: row.id,
      proforma_invoice_id: row.proforma_invoice_id,
      sales_order_id: row.sales_order_id,
      amount: row.amount,
      currency: row.currency,
      received_at: row.received_at,
      method: row.method,
      external_reference: row.external_reference,
      proof_file_id: row.proof_file_id,
      recorded_by: row.recorded_by,
      note: row.note,
      status: row.decision ?? 'recorded',
      decided_by: row.decided_by,
      decision_reason: row.decision_reason,
      decided_at: row.decided_at,
      created_at: row.created_at,
      payment_provider_status: 'not_verified',
    };
  }

  private async evaluateGateInTransaction(
    client: PoolClient,
    actor: CommercialActor,
    order: OrderContext,
    settings: CommercialSettings,
  ): Promise<GateRow> {
    const sums = await client.query<{ confirmed_amount: string; missing_proof_count: number }>(
      `SELECT
         COALESCE(sum(r.amount) FILTER (
           WHERE d.decision = 'confirmed' AND ($2::boolean = false OR r.proof_file_id IS NOT NULL)
         ), 0)::text AS confirmed_amount,
         count(*) FILTER (
           WHERE d.decision = 'confirmed' AND $2::boolean = true AND r.proof_file_id IS NULL
         )::integer AS missing_proof_count
         FROM customer_receipts r
         LEFT JOIN customer_receipt_decisions d
           ON d.receipt_id = r.id AND d.tenant_id = r.tenant_id
        WHERE r.sales_order_id = $1`,
      [order.id, settings.receipt_proof_required],
    );
    const required = await client.query<{ amount: string }>(
      `SELECT round($1::numeric * $2::numeric / 10000, 2)::text AS amount`,
      [order.total_amount, settings.required_receipt_ratio_bps],
    );
    const comparison = await client.query<{ enough: boolean }>(
      `SELECT $1::numeric >= $2::numeric AS enough`,
      [sums.rows[0].confirmed_amount, required.rows[0].amount],
    );
    const blockingReasons: string[] = [];
    if (!comparison.rows[0].enough) blockingReasons.push('insufficient_confirmed_receipts');
    if (sums.rows[0].missing_proof_count > 0)
      blockingReasons.push('confirmed_receipt_missing_proof');
    const status = !settings.procurement_gate_enabled
      ? 'bypassed'
      : blockingReasons.length === 0
        ? 'open'
        : 'blocked';
    const inserted = await client.query<GateRow>(
      `INSERT INTO procurement_gate_evaluations
         (tenant_id, sales_order_id, proforma_invoice_id, status, order_amount,
          confirmed_amount, required_amount, currency, required_ratio_bps,
          proof_required, config_enabled, bypass_reason, blocking_reasons, evaluated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING ${GATE_COLUMNS}`,
      [
        actor.tenantId,
        order.id,
        order.proforma_invoice_id,
        status,
        order.total_amount,
        sums.rows[0].confirmed_amount,
        required.rows[0].amount,
        order.currency,
        settings.required_receipt_ratio_bps,
        settings.receipt_proof_required,
        settings.procurement_gate_enabled,
        settings.procurement_gate_enabled ? null : settings.bypass_reason,
        JSON.stringify(blockingReasons),
        actor.userId,
      ],
    );
    const gate = inserted.rows[0];
    if ((status === 'open' || status === 'bypassed') && order.status === 'customer_confirmed') {
      await client.query(
        `UPDATE sales_orders SET status = 'payment_gate_open', updated_at = now() WHERE id = $1`,
        [order.id],
      );
    } else if (status === 'blocked' && order.status === 'payment_gate_open') {
      await client.query(
        `UPDATE sales_orders SET status = 'customer_confirmed', updated_at = now() WHERE id = $1`,
        [order.id],
      );
    }
    await this.audit.logInTransaction(client, {
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action: 'procurement_gate.evaluated',
      resourceType: 'procurement_gate',
      resourceId: gate.id,
      after: this.gateResponse(gate),
      reason: gate.bypass_reason,
    });
    await this.events.recordInTransaction(client, {
      tenantId: actor.tenantId,
      chainType: 'sales_order',
      chainId: order.id,
      credentialType: 'procurement_gate',
      credentialId: gate.id,
      eventType: `procurement_gate.${status}`,
      actorType: 'tenant_user',
      actorId: actor.userId,
      scopeUserId: order.owner_user_id,
      visibilityPermission: 'procurement_gate:view',
    });
    return gate;
  }

  private gateResponse(row: GateRow) {
    return {
      id: row.id,
      sales_order_id: row.sales_order_id,
      proforma_invoice_id: row.proforma_invoice_id,
      status: row.status,
      order_amount: row.order_amount,
      confirmed_amount: row.confirmed_amount,
      required_amount: row.required_amount,
      currency: row.currency,
      required_ratio_bps: row.required_ratio_bps,
      proof_required: row.proof_required,
      config_enabled: row.config_enabled,
      bypass_reason: row.bypass_reason,
      blocking_reasons: row.blocking_reasons,
      evaluated_by: row.evaluated_by,
      evaluated_at: row.created_at,
    };
  }

  private async recordEvent(
    client: PoolClient,
    actor: CommercialActor,
    inquiry: InquiryContext,
    credentialType: string,
    credentialId: string,
    eventType: string,
  ): Promise<void> {
    await this.events.recordInTransaction(client, {
      tenantId: actor.tenantId,
      chainType: 'inquiry',
      chainId: inquiry.id,
      credentialType,
      credentialId,
      eventType,
      actorType: 'tenant_user',
      actorId: actor.userId,
      scopeUserId: inquiry.owner_user_id,
      visibilityPermission: 'inquiries:view',
    });
  }
}
