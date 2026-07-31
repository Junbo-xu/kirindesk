import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { AuditService } from '../audit/audit.service';
import { CreateSelectionDto } from './dto/create-selection.dto';
import { UpsertQuotationDto } from './dto/upsert-quotation.dto';
import {
  InquiryNotFoundException,
  InquiryStateConflictException,
  InvalidInquiryDataException,
  QuotationAuditSequenceException,
  QuotationNotFoundException,
  QuotationVersionConflictException,
  QuoteTaskNotFoundException,
} from './inquiries.errors';
import {
  InquiryItemRow,
  ProcurementQuotationResponse,
  QuotationLineRow,
  QuotationRow,
  SalesQuotationResponse,
  toProcurementQuotationResponse,
  toSalesQuotationResponse,
} from './inquiries.response';
import type { RequestActor } from './inquiries.service';

const QUOTATION_COLUMNS = `id, inquiry_id, supplier_id, entered_by, version,
  currency, valid_until::text AS valid_until, source_text, created_at, updated_at`;
const LINE_COLUMNS = `id, inquiry_id, quotation_id, inquiry_item_id, variant_key,
  variant_value, quantity::text AS quantity, unit_price::text AS unit_price,
  minimum_quantity::text AS minimum_quantity, lead_time_days, terms, created_at`;

interface SelectionRow {
  id: string;
  inquiry_id: string;
  inquiry_item_id: string;
  quotation_id: string;
  quotation_line_id: string;
  quotation_version: number;
  snapshot_json: Record<string, unknown>;
  created_at: Date;
}

interface QuoteTaskContext {
  inquiry_id: string;
  sanitization_status: string;
}

interface SupplierIdentity {
  id: string;
  company_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
}

interface PgErrorLike {
  code?: string;
}

function isZeroDecimal(value: string): boolean {
  return /^0+(?:\.0+)?$/.test(value);
}

@Injectable()
export class QuotationsService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private async lines(client: PoolClient, quotationId: string): Promise<QuotationLineRow[]> {
    const result = await client.query<QuotationLineRow>(
      `SELECT ${LINE_COLUMNS}
         FROM supplier_quotation_lines
        WHERE quotation_id = $1
        ORDER BY inquiry_item_id ASC, variant_key ASC, variant_value ASC, id ASC`,
      [quotationId],
    );
    return result.rows;
  }

  private async task(client: PoolClient, taskId: string, lock = false): Promise<QuoteTaskContext> {
    const result = await client.query<QuoteTaskContext>(
      `SELECT inquiry_id, sanitization_status
         FROM quote_tasks
        WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [taskId],
    );
    if (result.rows.length === 0) throw new QuoteTaskNotFoundException();
    return result.rows[0];
  }

  private snapshot(row: QuotationRow, lines: QuotationLineRow[]): Record<string, unknown> {
    return {
      id: row.id,
      inquiry_id: row.inquiry_id,
      supplier_id: row.supplier_id,
      entered_by: row.entered_by,
      version: row.version,
      currency: row.currency,
      valid_until: row.valid_until,
      source_text: row.source_text,
      lines: lines.map((line) => ({
        id: line.id,
        inquiry_item_id: line.inquiry_item_id,
        variant_key: line.variant_key,
        variant_value: line.variant_value,
        quantity: line.quantity,
        unit_price: line.unit_price,
        minimum_quantity: line.minimum_quantity,
        lead_time_days: line.lead_time_days,
        terms: line.terms,
      })),
    };
  }

  private validateLineInput(dto: UpsertQuotationDto): void {
    if (
      dto.lines.some(
        (line) =>
          isZeroDecimal(line.quantity) ||
          (line.minimum_quantity !== undefined && isZeroDecimal(line.minimum_quantity)),
      )
    ) {
      throw new InvalidInquiryDataException('Quotation quantities must be greater than zero');
    }
    const keys = new Set<string>();
    for (const line of dto.lines) {
      const key = [
        line.inquiry_item_id,
        line.variant_key?.trim() ?? '',
        line.variant_value?.trim() ?? '',
      ].join('\u0000');
      if (keys.has(key)) {
        throw new InvalidInquiryDataException('Quotation contains a duplicate atomic line');
      }
      keys.add(key);
    }
  }

  private assertSalesSafeContent(dto: UpsertQuotationDto, supplier: SupplierIdentity): void {
    const text = dto.lines
      .flatMap((line) => [line.variant_key, line.variant_value, line.terms])
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    const digits = text.replace(/\D/g, '');
    const plainTokens = [supplier.company_name, supplier.contact_name, supplier.email]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length >= 3);
    const phone = supplier.phone?.replace(/\D/g, '') ?? '';
    if (
      plainTokens.some((token) => text.includes(token)) ||
      (phone.length >= 7 && digits.includes(phone))
    ) {
      throw new InvalidInquiryDataException(
        'Quotation contains supplier identity in sales-visible fields',
      );
    }
  }

  async upsert(
    actor: RequestActor,
    taskId: string,
    dto: UpsertQuotationDto,
  ): Promise<ProcurementQuotationResponse> {
    this.validateLineInput(dto);
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const task = await this.task(client, taskId, true);
          if (!['ready', 'manually_corrected'].includes(task.sanitization_status)) {
            throw new InquiryStateConflictException('Quote task is not ready for quotations');
          }

          const expired = await client.query<{ expired: boolean }>(
            `SELECT $1::date < CURRENT_DATE AS expired`,
            [dto.valid_until],
          );
          if (expired.rows[0].expired) {
            throw new InvalidInquiryDataException('Quotation validity date is in the past');
          }

          const supplierParams: unknown[] = [dto.supplier_id];
          let supplierScope = '';
          if (this.restrictsToOwner(actor.dataScope)) {
            supplierParams.push(actor.userId);
            supplierScope = ` AND owner_user_id = $${supplierParams.length}`;
          }
          const supplier = await client.query<SupplierIdentity>(
            `SELECT id, company_name, contact_name, email, phone FROM suppliers
              WHERE id = $1 AND deleted_at IS NULL AND status = 'active'${supplierScope}`,
            supplierParams,
          );
          if (supplier.rows.length === 0) throw new QuotationNotFoundException();
          this.assertSalesSafeContent(dto, supplier.rows[0]);

          const distinctItemIds = [...new Set(dto.lines.map((line) => line.inquiry_item_id))];
          const validItems = await client.query<{ id: string }>(
            `SELECT id FROM inquiry_items
              WHERE inquiry_id = $1 AND id = ANY($2::uuid[])`,
            [task.inquiry_id, distinctItemIds],
          );
          if (validItems.rows.length !== distinctItemIds.length) {
            throw new InvalidInquiryDataException(
              'Quotation line references an invalid inquiry item',
            );
          }

          const existing = await client.query<QuotationRow>(
            `SELECT ${QUOTATION_COLUMNS}
               FROM supplier_quotations
              WHERE inquiry_id = $1 AND supplier_id = $2
              FOR UPDATE`,
            [task.inquiry_id, dto.supplier_id],
          );
          const current = existing.rows[0];
          if (
            (!current && dto.expected_version !== 0) ||
            (current && current.version !== dto.expected_version)
          ) {
            throw new QuotationVersionConflictException();
          }

          const beforeLines = current ? await this.lines(client, current.id) : [];
          const before = current ? this.snapshot(current, beforeLines) : null;
          let quotation: QuotationRow;
          if (current) {
            const updated = await client.query<QuotationRow>(
              `UPDATE supplier_quotations
                  SET version = version + 1,
                      entered_by = $2,
                      currency = $3,
                      valid_until = $4,
                      source_text = $5,
                      updated_at = now()
                WHERE id = $1 AND version = $6
              RETURNING ${QUOTATION_COLUMNS}`,
              [
                current.id,
                actor.userId,
                dto.currency,
                dto.valid_until,
                dto.source_text ?? null,
                dto.expected_version,
              ],
            );
            if (updated.rows.length !== 1) throw new QuotationVersionConflictException();
            quotation = updated.rows[0];
            await client.query(`DELETE FROM supplier_quotation_lines WHERE quotation_id = $1`, [
              quotation.id,
            ]);
          } else {
            const inserted = await client.query<QuotationRow>(
              `INSERT INTO supplier_quotations
                 (tenant_id, inquiry_id, supplier_id, entered_by, currency, valid_until, source_text)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING ${QUOTATION_COLUMNS}`,
              [
                actor.tenantId,
                task.inquiry_id,
                dto.supplier_id,
                actor.userId,
                dto.currency,
                dto.valid_until,
                dto.source_text ?? null,
              ],
            );
            quotation = inserted.rows[0];
          }

          for (const line of dto.lines) {
            await client.query(
              `INSERT INTO supplier_quotation_lines
                 (tenant_id, inquiry_id, quotation_id, inquiry_item_id,
                  variant_key, variant_value, quantity, unit_price,
                  minimum_quantity, lead_time_days, terms)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                actor.tenantId,
                task.inquiry_id,
                quotation.id,
                line.inquiry_item_id,
                line.variant_key?.trim() ?? '',
                line.variant_value?.trim() ?? '',
                line.quantity,
                line.unit_price,
                line.minimum_quantity ?? null,
                line.lead_time_days ?? null,
                line.terms?.trim() || null,
              ],
            );
          }

          const currentLines = await this.lines(client, quotation.id);
          const after = this.snapshot(quotation, currentLines);
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: current ? 'supplier_quotation.replaced' : 'supplier_quotation.created',
            resourceType: 'supplier_quotation',
            resourceId: quotation.id,
            before,
            after,
          });
          await client.query(
            `UPDATE inquiries SET status = 'quoted', updated_at = now()
              WHERE id = $1 AND status IN ('submitted', 'quoting', 'quoted')`,
            [task.inquiry_id],
          );
          return toProcurementQuotationResponse(quotation, currentLines);
        },
      );
    } catch (error) {
      if ((error as PgErrorLike)?.code === '23505') {
        throw new QuotationVersionConflictException();
      }
      throw error;
    }
  }

  async listForTask(actor: RequestActor, taskId: string): Promise<ProcurementQuotationResponse[]> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const task = await this.task(client, taskId);
        const result = await client.query<QuotationRow>(
          `SELECT ${QUOTATION_COLUMNS}
             FROM supplier_quotations
            WHERE inquiry_id = $1
            ORDER BY updated_at DESC, id ASC`,
          [task.inquiry_id],
        );
        return Promise.all(
          result.rows.map(async (row) =>
            toProcurementQuotationResponse(row, await this.lines(client, row.id)),
          ),
        );
      },
    );
  }

  async listForSalesInquiry(
    actor: RequestActor,
    inquiryId: string,
  ): Promise<SalesQuotationResponse[]> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [inquiryId];
        let scope = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scope = ` AND owner_user_id = $${params.length}`;
        }
        const inquiry = await client.query(
          `SELECT id FROM inquiries WHERE id = $1${scope}`,
          params,
        );
        if (inquiry.rows.length === 0) throw new InquiryNotFoundException();
        const result = await client.query<QuotationRow>(
          `SELECT ${QUOTATION_COLUMNS}
             FROM supplier_quotations
            WHERE inquiry_id = $1
            ORDER BY updated_at DESC, id ASC`,
          [inquiryId],
        );
        return Promise.all(
          result.rows.map(async (row) =>
            toSalesQuotationResponse(row, await this.lines(client, row.id)),
          ),
        );
      },
    );
  }

  private publicSelection(row: SelectionRow): Record<string, unknown> {
    const snapshot = row.snapshot_json as {
      currency?: unknown;
      valid_until?: unknown;
      line?: Record<string, unknown>;
      inquiry_item?: Record<string, unknown>;
    };
    const line = snapshot.line ?? {};
    const inquiryItem = snapshot.inquiry_item ?? {};
    return {
      id: row.id,
      inquiry_id: row.inquiry_id,
      inquiry_item_id: row.inquiry_item_id,
      quotation_id: row.quotation_id,
      quotation_line_id: row.quotation_line_id,
      quotation_version: row.quotation_version,
      snapshot: {
        currency: snapshot.currency,
        valid_until: snapshot.valid_until,
        line: {
          id: line.id,
          inquiry_item_id: line.inquiry_item_id,
          variant_key: line.variant_key,
          variant_value: line.variant_value,
          quantity: line.quantity,
          unit_price: line.unit_price,
          minimum_quantity: line.minimum_quantity,
          lead_time_days: line.lead_time_days,
        },
        inquiry_item: {
          id: inquiryItem.id,
          inquiry_id: inquiryItem.inquiry_id,
          line_no: inquiryItem.line_no,
          description: inquiryItem.description,
          specifications: inquiryItem.specifications,
          quantity: inquiryItem.quantity,
          unit: inquiryItem.unit,
        },
      },
      created_at: row.created_at,
    };
  }

  async createSelection(
    actor: RequestActor,
    inquiryId: string,
    dto: CreateSelectionDto,
  ): Promise<Record<string, unknown>> {
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const params: unknown[] = [inquiryId];
          let scope = '';
          if (this.restrictsToOwner(actor.dataScope)) {
            params.push(actor.userId);
            scope = ` AND owner_user_id = $${params.length}`;
          }
          const inquiry = await client.query(
            `SELECT id, status FROM inquiries WHERE id = $1${scope} FOR UPDATE`,
            params,
          );
          if (inquiry.rows.length === 0) throw new InquiryNotFoundException();
          if (!['quoted', 'selected'].includes(inquiry.rows[0].status as string)) {
            throw new InquiryStateConflictException('Inquiry has no selectable quotation');
          }

          const selected = await client.query<{
            quotation_id: string;
            quotation_version: number;
            supplier_id: string;
            entered_by: string;
            currency: string;
            valid_until: string;
            source_text: string | null;
            line: QuotationLineRow;
            inquiry_item: InquiryItemRow;
          }>(
            `SELECT q.id AS quotation_id, q.version AS quotation_version,
                    q.supplier_id, q.entered_by, q.currency,
                    q.valid_until::text AS valid_until, q.source_text,
                    jsonb_build_object(
                      'id', l.id,
                      'inquiry_id', l.inquiry_id,
                      'quotation_id', l.quotation_id,
                      'inquiry_item_id', l.inquiry_item_id,
                      'variant_key', l.variant_key,
                      'variant_value', l.variant_value,
                      'quantity', l.quantity::text,
                      'unit_price', l.unit_price::text,
                      'minimum_quantity', l.minimum_quantity::text,
                      'lead_time_days', l.lead_time_days,
                      'terms', l.terms
                    ) AS line,
                    jsonb_build_object(
                      'id', ii.id,
                      'inquiry_id', ii.inquiry_id,
                      'line_no', ii.line_no,
                      'description', ii.description,
                      'specifications', ii.specifications,
                      'quantity', ii.quantity::text,
                      'unit', ii.unit
                    ) AS inquiry_item
               FROM supplier_quotation_lines l
               JOIN supplier_quotations q
                 ON q.id = l.quotation_id AND q.tenant_id = l.tenant_id
               JOIN inquiry_items ii
                 ON ii.id = l.inquiry_item_id AND ii.tenant_id = l.tenant_id
              WHERE l.id = $1 AND l.inquiry_id = $2
              FOR UPDATE OF q, l`,
            [dto.quotation_line_id, inquiryId],
          );
          if (selected.rows.length === 0) throw new QuotationNotFoundException();
          const source = selected.rows[0];
          if (source.quotation_version !== dto.expected_quotation_version) {
            throw new QuotationVersionConflictException();
          }
          const expiration = await client.query<{ expired: boolean }>(
            `SELECT $1::date < CURRENT_DATE AS expired`,
            [source.valid_until],
          );
          if (expiration.rows[0].expired) {
            throw new InquiryStateConflictException('Quotation has expired');
          }
          const snapshot = {
            quotation_id: source.quotation_id,
            quotation_version: source.quotation_version,
            supplier_id: source.supplier_id,
            entered_by: source.entered_by,
            currency: source.currency,
            valid_until: source.valid_until,
            source_text: source.source_text,
            line: source.line,
            inquiry_item: source.inquiry_item,
          };
          const inserted = await client.query<SelectionRow>(
            `INSERT INTO quote_selection_snapshots
               (tenant_id, inquiry_id, inquiry_item_id, quotation_id,
                quotation_line_id, quotation_version, selected_by, snapshot_json)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, inquiry_id, inquiry_item_id, quotation_id,
                       quotation_line_id, quotation_version, snapshot_json, created_at`,
            [
              actor.tenantId,
              inquiryId,
              source.line.inquiry_item_id,
              source.quotation_id,
              dto.quotation_line_id,
              source.quotation_version,
              actor.userId,
              JSON.stringify(snapshot),
            ],
          );
          const response = this.publicSelection(inserted.rows[0]);
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'quote_selection.created',
            resourceType: 'quote_selection',
            resourceId: inserted.rows[0].id,
            after: {
              inquiry_id: inquiryId,
              inquiry_item_id: source.line.inquiry_item_id,
              quotation_id: source.quotation_id,
              quotation_version: source.quotation_version,
            },
          });
          const counts = await client.query<{ item_count: string; selection_count: string }>(
            `SELECT
               (SELECT COUNT(*)::text FROM inquiry_items WHERE inquiry_id = $1) AS item_count,
               (SELECT COUNT(*)::text FROM quote_selection_snapshots WHERE inquiry_id = $1)
                 AS selection_count`,
            [inquiryId],
          );
          if (counts.rows[0].item_count === counts.rows[0].selection_count) {
            await client.query(
              `UPDATE inquiries SET status = 'selected', updated_at = now() WHERE id = $1`,
              [inquiryId],
            );
          }
          return response;
        },
      );
    } catch (error) {
      if ((error as PgErrorLike)?.code === '23505') {
        throw new InquiryStateConflictException('Inquiry item already has a selection');
      }
      throw error;
    }
  }

  async listSelections(actor: RequestActor, inquiryId: string): Promise<Record<string, unknown>[]> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [inquiryId];
        let scope = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scope = ` AND owner_user_id = $${params.length}`;
        }
        const inquiry = await client.query(
          `SELECT id FROM inquiries WHERE id = $1${scope}`,
          params,
        );
        if (inquiry.rows.length === 0) throw new InquiryNotFoundException();
        const rows = await client.query<SelectionRow>(
          `SELECT id, inquiry_id, inquiry_item_id, quotation_id,
                  quotation_line_id, quotation_version, snapshot_json, created_at
             FROM quote_selection_snapshots
            WHERE inquiry_id = $1
            ORDER BY created_at ASC, id ASC`,
          [inquiryId],
        );
        return rows.rows.map((row) => this.publicSelection(row));
      },
    );
  }

  async overwriteSequence(
    actor: RequestActor,
    quotationId: string,
  ): Promise<Record<string, unknown>> {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const quotation = await client.query(`SELECT id FROM supplier_quotations WHERE id = $1`, [
          quotationId,
        ]);
        if (quotation.rows.length === 0) throw new QuotationNotFoundException();
        const events = await client.query<{
          id: string;
          action: string;
          actor_id: string;
          before_json: Record<string, unknown> | null;
          after_json: Record<string, unknown>;
          created_at: Date;
        }>(
          `SELECT id::text AS id, action, actor_id, before_json, after_json, created_at
             FROM audit_logs
            WHERE resource_type = 'supplier_quotation'
              AND resource_id = $1
              AND action IN ('supplier_quotation.created', 'supplier_quotation.replaced')
            ORDER BY id ASC`,
          [quotationId],
        );
        if (events.rows.length === 0) throw new QuotationAuditSequenceException();
        for (const [index, event] of events.rows.entries()) {
          const expected = index + 1;
          if (event.after_json?.version !== expected) throw new QuotationAuditSequenceException();
          if (index === 0) {
            if (event.before_json !== null) throw new QuotationAuditSequenceException();
          } else if (event.before_json?.version !== expected - 1) {
            throw new QuotationAuditSequenceException();
          }
        }
        return {
          quotation_id: quotationId,
          complete: true,
          current_version: events.rows.length,
          sequence: events.rows.map((event) => ({
            event_id: event.id,
            action: event.action,
            actor_id: event.actor_id,
            before: event.before_json,
            after: event.after_json,
            created_at: event.created_at,
          })),
        };
      },
    );
  }
}
