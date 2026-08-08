import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { RbacService } from '../rbac/rbac.service';
import { STORAGE_PROVIDER, StorageProvider } from '../storage/storage-provider.interface';
import { QuotaService } from '../subscription/quota.service';
import {
  DocumentWorkbenchConflictException,
  DocumentWorkbenchNotFoundException,
  InvalidDocumentWorkbenchDataException,
} from './document-workbench.errors';
import { computeDocumentMoney } from './document-money';
import { DOCUMENT_PDF_RENDERER, DocumentPdfRenderer } from './document-pdf.renderer';
import {
  DOCUMENT_TYPES,
  DocumentRenderAssets,
  DocumentType,
  InternalDocumentSnapshot,
  PublicDocumentSnapshot,
  toPublicDocumentSnapshot,
} from './document.types';
import {
  CreateDocumentSetDto,
  CreateShareLinkDto,
  ListDocumentSetsQuery,
  UpdateDocumentSetDto,
} from './dto/document-set.dto';
import { DocumentWorkbenchActor } from './products.service';

interface DocumentSetRow {
  id: string;
  owner_user_id: string;
  customer_id: string | null;
  sales_order_id: string | null;
  quote_number: string;
  pricing_mode: 'final_price' | 'cost_profit';
  status: 'draft' | 'locked';
  language: 'zh' | 'en' | 'ru' | 'es' | 'de' | 'ar';
  incoterm: 'FOB' | 'CIF' | 'EXW';
  pricing_currency: string;
  settlement_currency: string;
  exchange_rate: string;
  discount_type: 'none' | 'percent' | 'amount';
  discount_value: string;
  freight_amount: string;
  insurance_amount: string;
  tax_amount: string;
  internal_expenses: string;
  allocation_method: 'equal' | 'value' | 'weight' | 'volume';
  packing_mode: 'normal' | 'combined';
  template_key: 'fixed_default';
  theme_color: string;
  visible_fields: Record<string, boolean>;
  terms: string | null;
  bank_info: string | null;
  logo_file_id: string | null;
  signature_file_id: string | null;
  version: number;
  locked_snapshot: InternalDocumentSnapshot | null;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DocumentLineRow {
  id: string;
  line_no: number;
  product_id: string | null;
  sku: string;
  name: string;
  description: string | null;
  quantity: string;
  unit: string;
  unit_price: string;
  line_total: string;
  cost_unit_price: string | null;
  cost_total: string | null;
  weight_kg: string | null;
  volume_cbm: string | null;
  package_no: string | null;
  thumbnail_file_id: string | null;
  custom_values: Record<string, unknown>;
}

interface ExportRow {
  id: string;
  document_set_id: string;
  source_version: number;
  export_version: number;
  document_type: DocumentType;
  snapshot_json: InternalDocumentSnapshot;
  file_id: string;
  is_draft: boolean;
  created_by: string;
  created_at: Date;
}

interface PublicLinkRow {
  id: string;
  tenant_id: string;
  export_id: string;
  revoked_at: Date | null;
  confirmed_at: Date | null;
  snapshot_json: InternalDocumentSnapshot;
  document_type: DocumentType;
  original_name: string;
  storage_key: string;
  mime_type: string;
  size_bytes: string;
}

export interface PublicDocumentDownload {
  stream: Readable;
  fileName: string;
  mimeType: string;
  sizeBytes: string;
}

const SET_COLUMNS = `id, owner_user_id, customer_id, sales_order_id, quote_number,
  pricing_mode, status, language, incoterm, pricing_currency, settlement_currency,
  exchange_rate::text, discount_type, discount_value::text, freight_amount::text,
  insurance_amount::text, tax_amount::text, internal_expenses::text, allocation_method,
  packing_mode, template_key, theme_color, visible_fields, terms, bank_info,
  logo_file_id, signature_file_id, version, locked_snapshot, locked_by, locked_at,
  created_at, updated_at`;

const LINE_COLUMNS = `id, line_no, product_id, sku, name, description, quantity::text,
  unit, unit_price::text, line_total::text, cost_unit_price::text, cost_total::text,
  weight_kg::text, volume_cbm::text, package_no, thumbnail_file_id, custom_values`;

@Injectable()
export class DocumentSetsService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(DOCUMENT_PDF_RENDERER) private readonly pdfRenderer: DocumentPdfRenderer,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly quota: QuotaService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private async canViewFinancials(actor: DocumentWorkbenchActor): Promise<boolean> {
    return (
      await this.rbac.checkPermission(actor.userId, actor.tenantId, 'document_financials:view')
    ).allowed;
  }

  private validateFinancialInput(
    dto: CreateDocumentSetDto | UpdateDocumentSetDto,
    includeFinancials: boolean,
  ): void {
    if (dto.discount_type === 'percent') {
      const [whole] = (dto.discount_value ?? '0').split('.');
      if (BigInt(whole) > 100n || Number(dto.discount_value ?? '0') > 100) {
        throw new InvalidDocumentWorkbenchDataException('Percentage discount cannot exceed 100');
      }
    }
    const hasInternalData =
      dto.pricing_mode === 'cost_profit' ||
      dto.lines.some((line) => line.cost_unit_price !== undefined) ||
      (dto.internal_expenses !== undefined && !/^0+(\.0+)?$/.test(dto.internal_expenses));
    if (hasInternalData && !includeFinancials) {
      throw new InvalidDocumentWorkbenchDataException(
        'Document financial permission is required',
        'DOCUMENT_FINANCIAL_PERMISSION_REQUIRED',
      );
    }
  }

  private money(dto: CreateDocumentSetDto | UpdateDocumentSetDto) {
    return computeDocumentMoney({
      lines: dto.lines,
      discount_type: dto.discount_type ?? 'none',
      discount_value: dto.discount_value ?? '0',
      freight_amount: dto.freight_amount ?? '0',
      insurance_amount: dto.insurance_amount ?? '0',
      tax_amount: dto.tax_amount ?? '0',
      internal_expenses: dto.internal_expenses ?? '0',
      exchange_rate: dto.exchange_rate,
      allocation_method: dto.allocation_method ?? 'value',
    });
  }

  private async verifyReferences(
    client: PoolClient,
    actor: DocumentWorkbenchActor,
    dto: CreateDocumentSetDto | UpdateDocumentSetDto,
  ): Promise<void> {
    if (dto.customer_id) {
      const params: unknown[] = [dto.customer_id];
      let scope = '';
      if (this.restrictsToOwner(actor.dataScope)) {
        params.push(actor.userId);
        scope = ` AND owner_user_id = $${params.length}`;
      }
      const customer = await client.query(
        `SELECT id FROM customers WHERE id = $1 AND deleted_at IS NULL${scope}`,
        params,
      );
      if (customer.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Customer');
    }
    if (dto.sales_order_id) {
      const params: unknown[] = [dto.sales_order_id];
      let scope = '';
      if (this.restrictsToOwner(actor.dataScope)) {
        params.push(actor.userId);
        scope = ` AND owner_user_id = $${params.length}`;
      }
      const order = await client.query(
        `SELECT id FROM sales_orders WHERE id = $1 AND deleted_at IS NULL${scope}`,
        params,
      );
      if (order.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Sales order');
    }
    const fileIds = [
      dto.logo_file_id,
      dto.signature_file_id,
      ...dto.lines.map((line) => line.thumbnail_file_id),
    ].filter((id): id is string => Boolean(id));
    if (fileIds.length > 0) {
      const files = await client.query<{ id: string; mime_type: string }>(
        `SELECT id, mime_type FROM files WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [fileIds],
      );
      if (
        files.rows.length !== new Set(fileIds).size ||
        files.rows.some((file) => !file.mime_type.startsWith('image/'))
      ) {
        throw new InvalidDocumentWorkbenchDataException(
          'Document images must reference visible image files',
        );
      }
    }
    const productIds = dto.lines
      .map((line) => line.product_id)
      .filter((id): id is string => Boolean(id));
    if (productIds.length > 0) {
      const products = await client.query<{ id: string }>(
        `SELECT id FROM products WHERE id = ANY($1::uuid[]) AND active = true`,
        [productIds],
      );
      if (products.rows.length !== new Set(productIds).size) {
        throw new DocumentWorkbenchNotFoundException('Product');
      }
    }
  }

  private async setRow(
    client: PoolClient,
    actor: DocumentWorkbenchActor,
    id: string,
    lock = false,
  ): Promise<DocumentSetRow> {
    const params: unknown[] = [id];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND owner_user_id = $${params.length}`;
    }
    const result = await client.query<DocumentSetRow>(
      `SELECT ${SET_COLUMNS} FROM trade_document_sets
        WHERE id = $1${scope}${lock ? ' FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Document set');
    return result.rows[0];
  }

  private async lines(client: PoolClient, documentSetId: string): Promise<DocumentLineRow[]> {
    const result = await client.query<DocumentLineRow>(
      `SELECT ${LINE_COLUMNS} FROM trade_document_lines
        WHERE document_set_id = $1 ORDER BY line_no`,
      [documentSetId],
    );
    return result.rows;
  }

  private async snapshot(
    client: PoolClient,
    row: DocumentSetRow,
    generatedAt = new Date(),
  ): Promise<InternalDocumentSnapshot> {
    const lines = await this.lines(client, row.id);
    const customer = row.customer_id
      ? await client.query<{
          id: string;
          company_name: string;
          contact_name: string | null;
          email: string | null;
          phone: string | null;
          country: string | null;
        }>(
          `SELECT id, company_name, contact_name, email, phone, country
             FROM customers WHERE id = $1 AND deleted_at IS NULL`,
          [row.customer_id],
        )
      : { rows: [] };
    const fields = await client.query<{
      field_key: string;
      label: string;
      document_types: string[];
    }>(
      `SELECT field_key, label, document_types
         FROM product_custom_fields
        WHERE active = true
        ORDER BY sort_order, created_at, id`,
    );
    const totals = computeDocumentMoney({
      lines: lines.map((line) => ({
        quantity: line.quantity,
        unit_price: line.unit_price,
        ...(line.cost_unit_price === null ? {} : { cost_unit_price: line.cost_unit_price }),
        ...(line.weight_kg === null ? {} : { weight_kg: line.weight_kg }),
        ...(line.volume_cbm === null ? {} : { volume_cbm: line.volume_cbm }),
      })),
      discount_type: row.discount_type,
      discount_value: row.discount_value,
      freight_amount: row.freight_amount,
      insurance_amount: row.insurance_amount,
      tax_amount: row.tax_amount,
      internal_expenses: row.internal_expenses,
      exchange_rate: row.exchange_rate,
      allocation_method: row.allocation_method,
    });
    return {
      document_set_id: row.id,
      sales_order_id: row.sales_order_id,
      source_version: row.version,
      quote_number: row.quote_number,
      pricing_mode: row.pricing_mode,
      status: row.status,
      language: row.language,
      incoterm: row.incoterm,
      pricing_currency: row.pricing_currency,
      settlement_currency: row.settlement_currency,
      exchange_rate: row.exchange_rate,
      discount_type: row.discount_type,
      discount_value: row.discount_value,
      allocation_method: row.allocation_method,
      packing_mode: row.packing_mode,
      template_key: row.template_key,
      theme_color: row.theme_color,
      visible_fields: row.visible_fields,
      terms: row.terms,
      bank_info: row.bank_info,
      logo_file_id: row.logo_file_id,
      signature_file_id: row.signature_file_id,
      customer: customer.rows[0] ?? null,
      lines: lines.map((line, index) => ({
        id: line.id,
        line_no: line.line_no,
        sku: line.sku,
        name: line.name,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
        line_total: totals.lines[index].line_total,
        cost_unit_price: line.cost_unit_price,
        cost_total: totals.lines[index].cost_total,
        allocated_charges: totals.lines[index].allocated_charges,
        weight_kg: line.weight_kg,
        volume_cbm: line.volume_cbm,
        total_weight_kg: totals.lines[index].total_weight_kg,
        total_volume_cbm: totals.lines[index].total_volume_cbm,
        package_no: line.package_no,
        thumbnail_file_id: line.thumbnail_file_id,
        custom_fields: fields.rows
          .filter((field) =>
            Object.prototype.hasOwnProperty.call(line.custom_values, field.field_key),
          )
          .map((field) => ({
            field_key: field.field_key,
            label: field.label,
            value: line.custom_values[field.field_key],
            document_types: field.document_types,
          })),
      })),
      totals: {
        subtotal: totals.subtotal,
        discount_amount: totals.discount_amount,
        freight_amount: totals.freight_amount,
        insurance_amount: totals.insurance_amount,
        tax_amount: totals.tax_amount,
        grand_total: totals.grand_total,
        settlement_total: totals.settlement_total,
        total_weight_kg: totals.total_weight_kg,
        total_volume_cbm: totals.total_volume_cbm,
      },
      internal_expenses: row.internal_expenses,
      internal_totals: {
        cost_total: totals.cost_total,
        internal_expenses: totals.internal_expenses,
        gross_profit: totals.gross_profit,
        gross_margin_bps: totals.gross_margin_bps,
      },
      generated_at: generatedAt.toISOString(),
    };
  }

  private present(snapshot: InternalDocumentSnapshot, includeFinancials: boolean) {
    return includeFinancials
      ? snapshot
      : { ...toPublicDocumentSnapshot(snapshot), sales_order_id: snapshot.sales_order_id };
  }

  private async insertLines(
    client: PoolClient,
    actor: DocumentWorkbenchActor,
    documentSetId: string,
    dto: CreateDocumentSetDto | UpdateDocumentSetDto,
  ): Promise<void> {
    const money = this.money(dto);
    for (const [index, line] of dto.lines.entries()) {
      await client.query(
        `INSERT INTO trade_document_lines
           (tenant_id, document_set_id, product_id, line_no, sku, name, description,
            quantity, unit, unit_price, line_total, cost_unit_price, cost_total,
            weight_kg, volume_cbm, package_no, thumbnail_file_id, custom_values)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          actor.tenantId,
          documentSetId,
          line.product_id ?? null,
          index + 1,
          line.sku,
          line.name,
          line.description?.trim() || null,
          line.quantity,
          line.unit,
          line.unit_price,
          money.lines[index].line_total,
          line.cost_unit_price ?? null,
          money.lines[index].cost_total,
          line.weight_kg ?? null,
          line.volume_cbm ?? null,
          line.package_no?.trim() || null,
          line.thumbnail_file_id ?? null,
          JSON.stringify(line.custom_values ?? {}),
        ],
      );
    }
  }

  async create(actor: DocumentWorkbenchActor, dto: CreateDocumentSetDto) {
    const includeFinancials = await this.canViewFinancials(actor);
    this.validateFinancialInput(dto, includeFinancials);
    try {
      const snapshot = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          await this.verifyReferences(client, actor, dto);
          const inserted = await client.query<DocumentSetRow>(
            `INSERT INTO trade_document_sets
               (tenant_id, owner_user_id, customer_id, sales_order_id, quote_number,
                pricing_mode, language, incoterm, pricing_currency, settlement_currency,
                exchange_rate, discount_type, discount_value, freight_amount,
                insurance_amount, tax_amount, internal_expenses, allocation_method,
                packing_mode, theme_color, visible_fields, terms, bank_info,
                logo_file_id, signature_file_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
             RETURNING ${SET_COLUMNS}`,
            [
              actor.tenantId,
              actor.userId,
              dto.customer_id ?? null,
              dto.sales_order_id ?? null,
              dto.quote_number,
              dto.pricing_mode ?? 'final_price',
              dto.language ?? 'en',
              dto.incoterm ?? 'FOB',
              dto.pricing_currency,
              dto.settlement_currency,
              dto.exchange_rate,
              dto.discount_type ?? 'none',
              dto.discount_value ?? '0',
              dto.freight_amount ?? '0',
              dto.insurance_amount ?? '0',
              dto.tax_amount ?? '0',
              dto.internal_expenses ?? '0',
              dto.allocation_method ?? 'value',
              dto.packing_mode ?? 'normal',
              dto.theme_color ?? '#155EEF',
              JSON.stringify(dto.visible_fields ?? {}),
              dto.terms?.trim() || null,
              dto.bank_info?.trim() || null,
              dto.logo_file_id ?? null,
              dto.signature_file_id ?? null,
            ],
          );
          await this.insertLines(client, actor, inserted.rows[0].id, dto);
          const result = await this.snapshot(client, inserted.rows[0]);
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'trade_document.created',
            resourceType: 'trade_document_set',
            resourceId: inserted.rows[0].id,
            after: result,
          });
          return result;
        },
      );
      return this.present(snapshot, includeFinancials);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'uq_trade_document_sets_number') {
        throw new DocumentWorkbenchConflictException(
          'Quote number already exists',
          'DUPLICATE_QUOTE_NUMBER',
        );
      }
      throw error;
    }
  }

  async list(actor: DocumentWorkbenchActor, query: ListDocumentSetsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const includeFinancials = await this.canViewFinancials(actor);
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [];
        const conditions: string[] = [];
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          conditions.push(`owner_user_id = $${params.length}`);
        }
        if (query.status) {
          params.push(query.status);
          conditions.push(`status = $${params.length}`);
        }
        if (query.q?.trim()) {
          params.push(`%${query.q.trim()}%`);
          conditions.push(`quote_number ILIKE $${params.length}`);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const count = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM trade_document_sets ${where}`,
          params,
        );
        const rows = await client.query<DocumentSetRow>(
          `SELECT ${SET_COLUMNS} FROM trade_document_sets ${where}
            ORDER BY updated_at DESC, id
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, (page - 1) * pageSize],
        );
        const data = [];
        for (const row of rows.rows)
          data.push(this.present(await this.snapshot(client, row), includeFinancials));
        return { data, page, pageSize, total: Number(count.rows[0].count) };
      },
    );
  }

  async get(actor: DocumentWorkbenchActor, id: string) {
    const includeFinancials = await this.canViewFinancials(actor);
    const snapshot = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.setRow(client, actor, id);
        return row.status === 'locked' && row.locked_snapshot
          ? row.locked_snapshot
          : this.snapshot(client, row);
      },
    );
    return this.present(snapshot, includeFinancials);
  }

  async update(actor: DocumentWorkbenchActor, id: string, dto: UpdateDocumentSetDto) {
    const includeFinancials = await this.canViewFinancials(actor);
    this.validateFinancialInput(dto, includeFinancials);
    try {
      const snapshot = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const beforeRow = await this.setRow(client, actor, id, true);
          if (beforeRow.status === 'locked') {
            throw new DocumentWorkbenchConflictException(
              'Locked document sets are immutable',
              'DOCUMENT_SET_LOCKED',
            );
          }
          if (beforeRow.version !== dto.expected_version) {
            throw new DocumentWorkbenchConflictException(
              'Document version changed',
              'DOCUMENT_VERSION_CONFLICT',
            );
          }
          await this.verifyReferences(client, actor, dto);
          const before = await this.snapshot(client, beforeRow);
          const updated = await client.query<DocumentSetRow>(
            `UPDATE trade_document_sets SET
               customer_id=$1, sales_order_id=$2, quote_number=$3, pricing_mode=$4,
               language=$5, incoterm=$6, pricing_currency=$7, settlement_currency=$8,
               exchange_rate=$9, discount_type=$10, discount_value=$11,
               freight_amount=$12, insurance_amount=$13, tax_amount=$14,
               internal_expenses=$15, allocation_method=$16, packing_mode=$17,
               theme_color=$18, visible_fields=$19, terms=$20, bank_info=$21,
               logo_file_id=$22, signature_file_id=$23, version=version+1, updated_at=now()
             WHERE id=$24 AND version=$25
             RETURNING ${SET_COLUMNS}`,
            [
              dto.customer_id ?? null,
              dto.sales_order_id ?? null,
              dto.quote_number,
              dto.pricing_mode ?? 'final_price',
              dto.language ?? 'en',
              dto.incoterm ?? 'FOB',
              dto.pricing_currency,
              dto.settlement_currency,
              dto.exchange_rate,
              dto.discount_type ?? 'none',
              dto.discount_value ?? '0',
              dto.freight_amount ?? '0',
              dto.insurance_amount ?? '0',
              dto.tax_amount ?? '0',
              dto.internal_expenses ?? '0',
              dto.allocation_method ?? 'value',
              dto.packing_mode ?? 'normal',
              dto.theme_color ?? '#155EEF',
              JSON.stringify(dto.visible_fields ?? {}),
              dto.terms?.trim() || null,
              dto.bank_info?.trim() || null,
              dto.logo_file_id ?? null,
              dto.signature_file_id ?? null,
              id,
              dto.expected_version,
            ],
          );
          if (updated.rows.length === 0) {
            throw new DocumentWorkbenchConflictException(
              'Document version changed',
              'DOCUMENT_VERSION_CONFLICT',
            );
          }
          await client.query(`DELETE FROM trade_document_lines WHERE document_set_id = $1`, [id]);
          await this.insertLines(client, actor, id, dto);
          const after = await this.snapshot(client, updated.rows[0]);
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'trade_document.updated',
            resourceType: 'trade_document_set',
            resourceId: id,
            before,
            after,
          });
          return after;
        },
      );
      return this.present(snapshot, includeFinancials);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'uq_trade_document_sets_number') {
        throw new DocumentWorkbenchConflictException(
          'Quote number already exists',
          'DUPLICATE_QUOTE_NUMBER',
        );
      }
      throw error;
    }
  }

  async lock(actor: DocumentWorkbenchActor, id: string) {
    const includeFinancials = await this.canViewFinancials(actor);
    const result = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.setRow(client, actor, id, true);
        if (row.status === 'locked') {
          if (!row.locked_snapshot)
            throw new DocumentWorkbenchConflictException('Locked snapshot is missing');
          return row.locked_snapshot;
        }
        const lockedAt = new Date();
        const snapshot = await this.snapshot(client, { ...row, status: 'locked' }, lockedAt);
        await client.query(
          `UPDATE trade_document_sets
              SET status='locked', locked_snapshot=$1, locked_by=$2, locked_at=$3, updated_at=now()
            WHERE id=$4`,
          [JSON.stringify(snapshot), actor.userId, lockedAt, id],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'trade_document.locked',
          resourceType: 'trade_document_set',
          resourceId: id,
          after: snapshot,
        });
        return snapshot;
      },
    );
    return this.present(result, includeFinancials);
  }

  private assertDocumentType(documentType: string): asserts documentType is DocumentType {
    if (!DOCUMENT_TYPES.includes(documentType as DocumentType)) {
      throw new InvalidDocumentWorkbenchDataException('Unsupported document type');
    }
  }

  private async streamBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  private async renderAssets(
    actor: DocumentWorkbenchActor,
    snapshot: PublicDocumentSnapshot,
  ): Promise<DocumentRenderAssets> {
    const fileIds = [
      snapshot.logo_file_id,
      snapshot.signature_file_id,
      ...snapshot.lines.map((line) => line.thumbnail_file_id),
    ].filter((id): id is string => Boolean(id));
    if (fileIds.length === 0) return { thumbnails: {} };
    const files = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const result = await client.query<{ id: string; storage_key: string; mime_type: string }>(
          `SELECT id, storage_key, mime_type FROM files
            WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND mime_type LIKE 'image/%'`,
          [fileIds],
        );
        return result.rows;
      },
    );
    const data = new Map<string, string>();
    for (const file of files) {
      const buffer = await this.streamBuffer(await this.storage.get(file.storage_key));
      data.set(file.id, `data:${file.mime_type};base64,${buffer.toString('base64')}`);
    }
    return {
      logo: snapshot.logo_file_id ? data.get(snapshot.logo_file_id) : undefined,
      signature: snapshot.signature_file_id ? data.get(snapshot.signature_file_id) : undefined,
      thumbnails: Object.fromEntries(
        snapshot.lines
          .map((line) => line.thumbnail_file_id)
          .filter((id): id is string => Boolean(id))
          .flatMap((id) => (data.has(id) ? [[id, data.get(id)!]] : [])),
      ),
    };
  }

  async export(actor: DocumentWorkbenchActor, id: string, rawDocumentType: string) {
    this.assertDocumentType(rawDocumentType);
    const internalSnapshot = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.setRow(client, actor, id);
        return row.status === 'locked' && row.locked_snapshot
          ? row.locked_snapshot
          : this.snapshot(client, row);
      },
    );
    const publicSnapshot = toPublicDocumentSnapshot(internalSnapshot);
    const pdf = await this.pdfRenderer.render(
      publicSnapshot,
      rawDocumentType,
      await this.renderAssets(actor, publicSnapshot),
    );
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('PDF renderer returned an invalid document');
    }
    const storageKey = `${actor.tenantId}/${randomUUID()}`;
    let stored = false;
    try {
      const result = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          await this.setRow(client, actor, id, true);
          const next = await client.query<{ export_version: number }>(
            `SELECT COALESCE(MAX(export_version), 0) + 1 AS export_version
               FROM trade_document_exports
              WHERE document_set_id = $1 AND document_type = $2`,
            [id, rawDocumentType],
          );
          const exportVersion = Number(next.rows[0].export_version);
          const fileName = `${internalSnapshot.quote_number}-${rawDocumentType}-v${internalSnapshot.source_version}-e${exportVersion}.pdf`;
          await this.quota.consumeInTransaction(client, actor.tenantId, 'storage', pdf.length);
          await this.storage.put(storageKey, pdf, 'application/pdf');
          stored = true;
          const file = await client.query<{ id: string }>(
            `INSERT INTO files
               (tenant_id, uploaded_by, original_name, storage_key, mime_type,
                size_bytes, sha256, purpose)
             VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,'trade-document')
             RETURNING id`,
            [
              actor.tenantId,
              actor.userId,
              fileName,
              storageKey,
              pdf.length,
              createHash('sha256').update(pdf).digest('hex'),
            ],
          );
          const exported = await client.query<ExportRow>(
            `INSERT INTO trade_document_exports
               (tenant_id, document_set_id, source_version, export_version,
                document_type, snapshot_json, file_id, is_draft, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING id, document_set_id, source_version, export_version,
                       document_type, snapshot_json, file_id, is_draft, created_by, created_at`,
            [
              actor.tenantId,
              id,
              internalSnapshot.source_version,
              exportVersion,
              rawDocumentType,
              JSON.stringify(internalSnapshot),
              file.rows[0].id,
              internalSnapshot.status === 'draft',
              actor.userId,
            ],
          );
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'trade_document.exported',
            resourceType: 'trade_document_export',
            resourceId: exported.rows[0].id,
            after: {
              document_set_id: id,
              document_type: rawDocumentType,
              source_version: internalSnapshot.source_version,
              export_version: exportVersion,
              file_id: file.rows[0].id,
              is_draft: internalSnapshot.status === 'draft',
            },
          });
          return exported.rows[0];
        },
      );
      return this.exportResponse(result);
    } catch (error) {
      if (stored) await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }

  private exportResponse(row: ExportRow) {
    return {
      id: row.id,
      document_set_id: row.document_set_id,
      source_version: row.source_version,
      export_version: row.export_version,
      document_type: row.document_type,
      file_id: row.file_id,
      is_draft: row.is_draft,
      created_by: row.created_by,
      created_at: row.created_at,
    };
  }

  async listExports(actor: DocumentWorkbenchActor, id: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.setRow(client, actor, id);
        const rows = await client.query<ExportRow>(
          `SELECT id, document_set_id, source_version, export_version, document_type,
                  snapshot_json, file_id, is_draft, created_by, created_at
             FROM trade_document_exports
            WHERE document_set_id = $1
            ORDER BY created_at DESC, id DESC`,
          [id],
        );
        return rows.rows.map((row) => this.exportResponse(row));
      },
    );
  }

  async createLink(actor: DocumentWorkbenchActor, dto: CreateShareLinkDto) {
    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const link = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const exported = await client.query<ExportRow & { owner_user_id: string }>(
          `SELECT e.id, e.document_set_id, e.source_version, e.export_version,
                  e.document_type, e.snapshot_json, e.file_id, e.is_draft,
                  e.created_by, e.created_at, d.owner_user_id
             FROM trade_document_exports e
             JOIN trade_document_sets d ON d.id = e.document_set_id AND d.tenant_id = e.tenant_id
            WHERE e.id = $1`,
          [dto.export_id],
        );
        if (
          exported.rows.length === 0 ||
          (this.restrictsToOwner(actor.dataScope) &&
            exported.rows[0].owner_user_id !== actor.userId)
        ) {
          throw new DocumentWorkbenchNotFoundException('Document export');
        }
        const result = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO trade_document_share_links
             (tenant_id, export_id, token_hash, created_by)
           VALUES ($1,$2,$3,$4)
           RETURNING id, created_at`,
          [actor.tenantId, dto.export_id, tokenHash, actor.userId],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'trade_document_link.created',
          resourceType: 'trade_document_share_link',
          resourceId: result.rows[0].id,
          after: { export_id: dto.export_id, expires_at: null },
        });
        return result.rows[0];
      },
    );
    return {
      id: link.id,
      export_id: dto.export_id,
      token,
      path: `/track/${token}`,
      expires_at: null,
      created_at: link.created_at,
    };
  }

  async listLinks(actor: DocumentWorkbenchActor, documentSetId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.setRow(client, actor, documentSetId);
        const rows = await client.query<{
          id: string;
          export_id: string;
          document_type: DocumentType;
          source_version: number;
          export_version: number;
          revoked_at: Date | null;
          confirmed_at: Date | null;
          created_at: Date;
          opened: string;
          downloaded: string;
          confirmed: string;
        }>(
          `SELECT l.id, l.export_id, e.document_type, e.source_version, e.export_version,
                  l.revoked_at, l.confirmed_at, l.created_at,
                  COUNT(event.id) FILTER (WHERE event.event_type='opened')::text AS opened,
                  COUNT(event.id) FILTER (WHERE event.event_type='downloaded')::text AS downloaded,
                  COUNT(event.id) FILTER (WHERE event.event_type='confirmed')::text AS confirmed
             FROM trade_document_share_links l
             JOIN trade_document_exports e ON e.id=l.export_id AND e.tenant_id=l.tenant_id
             LEFT JOIN trade_document_public_events event
               ON event.share_link_id=l.id AND event.tenant_id=l.tenant_id
            WHERE e.document_set_id=$1
            GROUP BY l.id, e.document_type, e.source_version, e.export_version
            ORDER BY l.created_at DESC, l.id DESC`,
          [documentSetId],
        );
        return rows.rows.map((row) => ({
          ...row,
          events: {
            opened: Number(row.opened),
            downloaded: Number(row.downloaded),
            confirmed: Number(row.confirmed),
          },
        }));
      },
    );
  }

  async revokeLink(actor: DocumentWorkbenchActor, id: string): Promise<void> {
    await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [id];
        let scope = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scope = ` AND d.owner_user_id = $${params.length}`;
        }
        const before = await client.query<{ id: string; revoked_at: Date | null }>(
          `SELECT l.id, l.revoked_at
             FROM trade_document_share_links l
             JOIN trade_document_exports e ON e.id=l.export_id AND e.tenant_id=l.tenant_id
             JOIN trade_document_sets d ON d.id=e.document_set_id AND d.tenant_id=e.tenant_id
            WHERE l.id=$1${scope}
            FOR UPDATE OF l`,
          params,
        );
        if (before.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Document link');
        if (before.rows[0].revoked_at === null) {
          await client.query(
            `UPDATE trade_document_share_links
                SET revoked_by=$1, revoked_at=now()
              WHERE id=$2`,
            [actor.userId, id],
          );
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'trade_document_link.revoked',
            resourceType: 'trade_document_share_link',
            resourceId: id,
          });
        }
      },
    );
  }

  private async lookupPublicLink(rawToken: string): Promise<{ tenantId: string; linkId: string }> {
    if (!/^[0-9a-f]{64}$/.test(rawToken)) throw new DocumentWorkbenchNotFoundException('Document');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ tenant_id: string; link_id: string }>(
        `SELECT tenant_id, link_id FROM app_lookup_trade_document_link($1)`,
        [tokenHash],
      );
      if (result.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Document');
      return { tenantId: result.rows[0].tenant_id, linkId: result.rows[0].link_id };
    } finally {
      client.release();
    }
  }

  private async publicLink(
    rawToken: string,
    eventType?: 'opened' | 'downloaded' | 'confirmed',
    ip?: string,
    userAgent?: string,
  ) {
    const lookup = await this.lookupPublicLink(rawToken);
    return withTenantContext(
      this.pool,
      { tenantId: lookup.tenantId, userId: null, actorType: 'system' },
      async (client) => {
        const result = await client.query<PublicLinkRow>(
          `SELECT l.id, l.tenant_id, l.export_id, l.revoked_at, l.confirmed_at,
                  e.snapshot_json, e.document_type, f.original_name, f.storage_key,
                  f.mime_type, f.size_bytes::text
             FROM trade_document_share_links l
             JOIN trade_document_exports e ON e.id=l.export_id AND e.tenant_id=l.tenant_id
             JOIN files f ON f.id=e.file_id AND f.tenant_id=e.tenant_id
            WHERE l.id=$1 AND l.revoked_at IS NULL AND f.deleted_at IS NULL
            FOR UPDATE OF l`,
          [lookup.linkId],
        );
        if (result.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Document');
        const firstConfirmation = eventType === 'confirmed' && result.rows[0].confirmed_at === null;
        if (firstConfirmation) {
          const confirmed = await client.query<{ confirmed_at: Date }>(
            `UPDATE trade_document_share_links SET confirmed_at=now()
              WHERE id=$1 RETURNING confirmed_at`,
            [lookup.linkId],
          );
          result.rows[0].confirmed_at = confirmed.rows[0].confirmed_at;
        }
        if (eventType && (eventType !== 'confirmed' || firstConfirmation)) {
          await client.query(
            `INSERT INTO trade_document_public_events
               (tenant_id, share_link_id, event_type, ip_hash, user_agent)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              lookup.tenantId,
              lookup.linkId,
              eventType,
              ip ? createHash('sha256').update(ip).digest('hex') : null,
              userAgent?.slice(0, 500) || null,
            ],
          );
        }
        return result.rows[0];
      },
    );
  }

  async openPublic(rawToken: string, ip?: string, userAgent?: string) {
    const link = await this.publicLink(rawToken, 'opened', ip, userAgent);
    return {
      document_type: link.document_type,
      document: toPublicDocumentSnapshot(link.snapshot_json),
      confirmed_at: link.confirmed_at,
      download_path: `/api/public/documents/${rawToken}/download`,
    };
  }

  async downloadPublic(
    rawToken: string,
    ip?: string,
    userAgent?: string,
  ): Promise<PublicDocumentDownload> {
    const link = await this.publicLink(rawToken, 'downloaded', ip, userAgent);
    return {
      stream: await this.storage.get(link.storage_key),
      fileName: link.original_name,
      mimeType: link.mime_type,
      sizeBytes: link.size_bytes,
    };
  }

  async confirmPublic(rawToken: string, ip?: string, userAgent?: string) {
    const link = await this.publicLink(rawToken, 'confirmed', ip, userAgent);
    return { confirmed: true, confirmed_at: link.confirmed_at };
  }
}
