import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { FilesService } from '../files/files.service';
import { RbacService } from '../rbac/rbac.service';
import { STORAGE_PROVIDER, StorageProvider } from '../storage/storage-provider.interface';
import { QuotaService } from '../subscription/quota.service';
import {
  DocumentWorkbenchConflictException,
  DocumentWorkbenchNotFoundException,
  InvalidDocumentWorkbenchDataException,
  ProcurementPrerequisiteMissingItem,
  ProcurementPrerequisitesException,
} from './document-workbench.errors';
import { computeDocumentMoney } from './document-money';
import { buildDocumentPackages } from './document-packing';
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
  ConvertDocumentSetToSalesOrderDto,
  CreateDocumentSetDto,
  CreateShareLinkDto,
  GenerateSalesOrderPurchaseOrdersDto,
  ListDocumentSetsQuery,
  LockSalesOrderForFulfillmentDto,
  SyncSalesOrderDocumentsDto,
  UpdateDocumentSetDto,
} from './dto/document-set.dto';
import { DocumentWorkbenchActor } from './products.service';
import { OrderItemRow, toOrderItemResponse } from '../sales-orders/dto/order-item.dto';
import { assertSalesOrderCustomerInScope } from '../sales-orders/sales-order-customer-scope';
import { SalesOrderRow, toSalesOrderResponse } from '../sales-orders/sales-orders.response';
import { computeLineTotal, sumMoney } from '../common/order-money';

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
  source_sales_order_snapshot: SalesOrderFulfillmentSnapshot | null;
  source_sales_order_updated_at: Date | null;
  source_sales_order_locked: boolean | null;
  source_sales_order_sync_key: string | null;
  source_sales_order_synced_by: string | null;
  source_sales_order_synced_at: Date | null;
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

interface SalesOrderFulfillmentItemSnapshot {
  id: string;
  product_id: string | null;
  line_no: number;
  description: string;
  product_code: string | null;
  unit: string | null;
  quantity: string;
  unit_price: string;
  line_total: string;
  notes: string | null;
  product: {
    sku: string;
    name: string;
    description: string | null;
    hs_code: string | null;
    cost_unit_price: string | null;
    weight_kg: string | null;
    volume_cbm: string | null;
    thumbnail_file_id: string | null;
    custom_values: Record<string, unknown>;
  } | null;
}

interface SalesOrderFulfillmentSnapshot {
  id: string;
  owner_user_id: string;
  customer_id: string;
  order_number: string;
  currency: string;
  total_amount: string;
  status: string;
  updated_at: string;
  locked_at: string | null;
  customer: {
    id: string;
    company_name: string;
    contact_name: string | null;
    email: string | null;
    phone: string | null;
    country: string | null;
  };
  items: SalesOrderFulfillmentItemSnapshot[];
}

interface ProcurementProductRow {
  sales_order_item_id: string;
  line_no: number;
  product_id: string | null;
  product_code: string | null;
  description: string;
  unit: string | null;
  quantity: string;
  supplier_id: string | null;
  supplier_company_name: string | null;
  purchase_currency: string | null;
  purchase_unit_price: string | null;
  product_sku: string | null;
  product_name: string | null;
}

interface DirectPurchaseOrderRow {
  id: string;
  supplier_id: string;
  owner_user_id: string;
  order_number: string;
  currency: string;
  total_amount: string;
  status: string;
  source_sales_order_generation_id: string;
  created_at: Date;
  updated_at: Date;
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
  source_sales_order_snapshot, source_sales_order_updated_at, source_sales_order_locked,
  source_sales_order_sync_key, source_sales_order_synced_by, source_sales_order_synced_at,
  created_at, updated_at`;

const LINE_COLUMNS = `id, line_no, product_id, sku, name, description, quantity::text,
  unit, unit_price::text, line_total::text, cost_unit_price::text, cost_total::text,
  weight_kg::text, volume_cbm::text, package_no, thumbnail_file_id, custom_values`;

const SUPPORTED_SALES_ORDER_CURRENCIES = new Set(['RMB', 'USD', 'HKD', 'EUR']);

@Injectable()
export class DocumentSetsService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(DOCUMENT_PDF_RENDERER) private readonly pdfRenderer: DocumentPdfRenderer,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly files: FilesService,
    private readonly quota: QuotaService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private scopeAllowsOwner(dataScope: string, actor: DocumentWorkbenchActor, ownerId: string) {
    return dataScope === 'all' || (this.restrictsToOwner(dataScope) && ownerId === actor.userId);
  }

  private intersectScope(left: string, right: string): string {
    if (left === 'none' || right === 'none') return 'none';
    if (left === 'all') return right;
    if (right === 'all') return left;
    return 'own';
  }

  private async financialScope(actor: DocumentWorkbenchActor): Promise<string> {
    const permission = await this.rbac.checkPermission(
      actor.userId,
      actor.tenantId,
      'document_financials:view',
    );
    return permission.allowed ? permission.dataScope : 'none';
  }

  private async fileScope(
    actor: DocumentWorkbenchActor,
    permissions: Array<'files:view' | 'files:download'>,
  ): Promise<string> {
    const grants = await Promise.all(
      permissions.map((permission) =>
        this.rbac.checkPermission(actor.userId, actor.tenantId, permission),
      ),
    );
    if (grants.some((grant) => !grant.allowed)) return 'none';
    if (grants.every((grant) => grant.dataScope === 'all')) return 'all';
    if (
      grants.every((grant) => grant.dataScope === 'all' || this.restrictsToOwner(grant.dataScope))
    ) {
      return 'own';
    }
    return 'none';
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
      const dataScope = await this.fileScope(actor, ['files:view']);
      const files = await this.files.findManyInScope(
        client,
        { userId: actor.userId, tenantId: actor.tenantId, dataScope },
        fileIds,
      );
      if (
        files.length !== new Set(fileIds).size ||
        files.some((file) => !file.mime_type.startsWith('image/'))
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
    } else if (actor.dataScope !== 'all') {
      scope = ' AND false';
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
    const snapshotLines = lines.map((line, index) => ({
      id: line.id,
      product_id: line.product_id,
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
    }));
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
      lines: snapshotLines,
      packages: buildDocumentPackages(snapshotLines, row.packing_mode),
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
    if (includeFinancials) return snapshot;
    const publicSnapshot = toPublicDocumentSnapshot(snapshot);
    return {
      ...publicSnapshot,
      sales_order_id: snapshot.sales_order_id,
      lines: publicSnapshot.lines.map((line, index) => ({
        ...line,
        product_id: snapshot.lines[index].product_id ?? null,
      })),
    };
  }

  private auditProjection(snapshot: InternalDocumentSnapshot) {
    return {
      ...toPublicDocumentSnapshot(snapshot),
      sales_order_id: snapshot.sales_order_id,
    };
  }

  private linkedSnapshot(snapshot: InternalDocumentSnapshot, salesOrderId: string | null) {
    return snapshot.sales_order_id === salesOrderId
      ? snapshot
      : { ...snapshot, sales_order_id: salesOrderId };
  }

  private async salesOrderResponse(client: PoolClient, id: string) {
    const order = await client.query<SalesOrderRow>(
      `SELECT * FROM sales_orders WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    if (order.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Sales order');
    const items = await client.query<OrderItemRow>(
      `SELECT * FROM sales_order_items
        WHERE order_id=$1 AND deleted_at IS NULL
        ORDER BY line_no`,
      [id],
    );
    return {
      row: order.rows[0],
      response: {
        ...toSalesOrderResponse(order.rows[0]),
        items: items.rows.map(toOrderItemResponse),
      },
    };
  }

  private async orderActor(actor: DocumentWorkbenchActor): Promise<DocumentWorkbenchActor> {
    const permission = await this.rbac.checkPermission(actor.userId, actor.tenantId, 'orders:view');
    if (!permission.allowed) throw new ForbiddenException('Permission denied');
    return {
      ...actor,
      dataScope: this.intersectScope(actor.dataScope, permission.dataScope),
    };
  }

  private async fulfillmentOrderRow(
    client: PoolClient,
    actor: DocumentWorkbenchActor,
    id: string,
    lock = false,
  ): Promise<SalesOrderRow> {
    const params: unknown[] = [id];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND owner_user_id=$${params.length}`;
    } else if (actor.dataScope !== 'all') {
      scope = ' AND false';
    }
    const order = await client.query<SalesOrderRow>(
      `SELECT * FROM sales_orders
        WHERE id=$1 AND deleted_at IS NULL${scope}${lock ? ' FOR UPDATE' : ''}`,
      params,
    );
    if (order.rows.length === 0) {
      throw new DocumentWorkbenchNotFoundException('Sales order');
    }
    return order.rows[0];
  }

  private sameTimestamp(left: Date, right: string): boolean {
    const parsed = new Date(right);
    return !Number.isNaN(parsed.valueOf()) && left.toISOString() === parsed.toISOString();
  }

  private async buildLiveOrderSnapshot(
    client: PoolClient,
    row: SalesOrderRow,
    lockedAt: Date | null,
  ): Promise<SalesOrderFulfillmentSnapshot> {
    const customer = await client.query<SalesOrderFulfillmentSnapshot['customer']>(
      `SELECT id, company_name, contact_name, email, phone, country
         FROM customers
        WHERE id=$1 AND deleted_at IS NULL`,
      [row.customer_id],
    );
    if (customer.rows.length === 0) {
      throw new DocumentWorkbenchNotFoundException('Customer');
    }
    const items = await client.query<{
      id: string;
      product_id: string | null;
      line_no: number;
      description: string;
      product_code: string | null;
      unit: string | null;
      quantity: string;
      unit_price: string;
      line_total: string;
      notes: string | null;
      product_sku: string | null;
      product_name: string | null;
      product_description: string | null;
      hs_code: string | null;
      cost_unit_price: string | null;
      weight_kg: string | null;
      volume_cbm: string | null;
      thumbnail_file_id: string | null;
      custom_values: Record<string, unknown> | null;
    }>(
      `SELECT item.id, item.product_id, item.line_no, item.description,
              item.product_code, item.unit, item.quantity::text,
              item.unit_price::text, item.line_total::text, item.notes,
              product.sku AS product_sku, product.name AS product_name,
              product.description AS product_description,
              product.hs_code,
              product.cost_unit_price::text, product.weight_kg::text,
              product.volume_cbm::text, product.thumbnail_file_id,
              product.custom_values
         FROM sales_order_items item
         LEFT JOIN products product
           ON product.id=item.product_id AND product.active=true
        WHERE item.order_id=$1 AND item.deleted_at IS NULL
        ORDER BY item.line_no`,
      [row.id],
    );
    if (items.rows.length === 0) {
      throw new InvalidDocumentWorkbenchDataException(
        'A sales order must have at least one line before fulfillment locking or conversion',
        'SALES_ORDER_ITEMS_REQUIRED',
      );
    }
    return {
      id: row.id,
      owner_user_id: row.owner_user_id,
      customer_id: row.customer_id,
      order_number: row.order_number,
      currency: row.currency,
      total_amount: row.total_amount,
      status: row.status,
      updated_at: row.updated_at.toISOString(),
      locked_at: lockedAt?.toISOString() ?? null,
      customer: customer.rows[0],
      items: items.rows.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        line_no: item.line_no,
        description: item.description,
        product_code: item.product_code,
        unit: item.unit,
        quantity: item.quantity,
        unit_price: item.unit_price,
        line_total: item.line_total,
        notes: item.notes,
        product: item.product_sku
          ? {
              sku: item.product_sku,
              name: item.product_name!,
              description: item.product_description,
              hs_code: item.hs_code,
              cost_unit_price: item.cost_unit_price,
              weight_kg: item.weight_kg,
              volume_cbm: item.volume_cbm,
              thumbnail_file_id: item.thumbnail_file_id,
              custom_values: item.custom_values ?? {},
            }
          : null,
      })),
    };
  }

  private sourceDocumentInput(
    snapshot: SalesOrderFulfillmentSnapshot,
    documentNumber: string,
  ): CreateDocumentSetDto {
    return {
      customer_id: snapshot.customer_id,
      sales_order_id: snapshot.id,
      quote_number: documentNumber,
      pricing_mode: snapshot.items.some((item) => item.product?.cost_unit_price != null)
        ? 'cost_profit'
        : 'final_price',
      language: 'en',
      incoterm: 'FOB',
      pricing_currency: snapshot.currency,
      settlement_currency: snapshot.currency,
      exchange_rate: '1',
      discount_type: 'none',
      discount_value: '0',
      freight_amount: '0',
      insurance_amount: '0',
      tax_amount: '0',
      internal_expenses: '0',
      allocation_method: 'value',
      packing_mode: 'normal',
      theme_color: '#155EEF',
      visible_fields: { thumbnail: true, terms: true, bank_info: true, signature: true },
      lines: snapshot.items.map((item) => ({
        product_id: item.product_id ?? undefined,
        sku: (item.product?.sku ?? item.product_code ?? `LINE-${item.line_no}`).slice(0, 100),
        name: item.product?.name ?? item.description,
        description: item.product?.description ?? item.notes ?? undefined,
        quantity: item.quantity,
        unit: item.unit ?? 'pcs',
        unit_price: item.unit_price,
        cost_unit_price: item.product?.cost_unit_price ?? undefined,
        weight_kg: item.product?.weight_kg ?? undefined,
        volume_cbm: item.product?.volume_cbm ?? undefined,
        thumbnail_file_id: item.product?.thumbnail_file_id ?? undefined,
        custom_values: item.product?.custom_values ?? {},
      })),
    };
  }

  private async documentSyncResponse(
    client: PoolClient,
    actor: DocumentWorkbenchActor,
    row: DocumentSetRow,
    options: {
      idempotent: boolean;
      refreshed: boolean;
      preservedExports: number;
      resultVersion?: number;
      snapshot?: InternalDocumentSnapshot;
      sourceUpdatedAt?: Date;
      sourceLocked?: boolean;
    },
  ) {
    const financialScope = await this.financialScope(actor);
    const internalSnapshot =
      options.snapshot ??
      (row.status === 'locked' && row.locked_snapshot
        ? this.linkedSnapshot(row.locked_snapshot, row.sales_order_id)
        : await this.snapshot(client, row));
    return {
      document: this.present(
        internalSnapshot,
        this.scopeAllowsOwner(financialScope, actor, row.owner_user_id),
      ),
      document_types: ['pi', 'sc', 'ci', 'pl'] as const,
      source_order: {
        sales_order_id: row.sales_order_id,
        updated_at: options.sourceUpdatedAt ?? row.source_sales_order_updated_at,
        locked: options.sourceLocked ?? row.source_sales_order_locked,
      },
      result_document_version: options.resultVersion ?? row.version,
      idempotent: options.idempotent,
      refreshed: options.refreshed,
      preserved_export_count: options.preservedExports,
    };
  }

  async lockSalesOrderForFulfillment(
    actor: DocumentWorkbenchActor,
    id: string,
    dto: LockSalesOrderForFulfillmentDto,
  ) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.fulfillmentOrderRow(client, actor, id, true);
        if (row.fulfillment_locked_snapshot) {
          const existing = await this.salesOrderResponse(client, row.id);
          return { sales_order: existing.response, idempotent: true };
        }
        if (!this.sameTimestamp(row.updated_at, dto.expected_updated_at)) {
          throw new DocumentWorkbenchConflictException(
            'Sales order changed before it could be locked',
            'SALES_ORDER_VERSION_CONFLICT',
          );
        }
        const lockedAt = new Date();
        const snapshot = await this.buildLiveOrderSnapshot(client, row, lockedAt);
        const updated = await client.query<SalesOrderRow>(
          `UPDATE sales_orders
              SET fulfillment_locked_snapshot=$1, fulfillment_locked_by=$2,
                  fulfillment_locked_at=$3, updated_at=now()
            WHERE id=$4 AND fulfillment_locked_snapshot IS NULL
            RETURNING *`,
          [JSON.stringify(snapshot), actor.userId, lockedAt, row.id],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'sales_order.fulfillment_locked',
          resourceType: 'sales_order',
          resourceId: row.id,
          after: {
            order_number: row.order_number,
            item_count: snapshot.items.length,
            locked_at: lockedAt,
          },
        });
        const items = await client.query<OrderItemRow>(
          `SELECT * FROM sales_order_items
            WHERE order_id=$1 AND deleted_at IS NULL ORDER BY line_no`,
          [row.id],
        );
        return {
          sales_order: {
            ...toSalesOrderResponse(updated.rows[0]),
            items: items.rows.map(toOrderItemResponse),
          },
          idempotent: false,
        };
      },
    );
  }

  async syncSalesOrderDocuments(
    actor: DocumentWorkbenchActor,
    id: string,
    dto: SyncSalesOrderDocumentsDto,
  ) {
    const scopedActor = await this.orderActor(actor);
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const row = await this.fulfillmentOrderRow(client, scopedActor, id, true);
          const priorSync = await client.query<{
            sales_order_id: string;
            document_set_id: string;
            source_order_updated_at: Date;
            source_order_locked: boolean;
            result_document_version: number;
            result_document_snapshot: InternalDocumentSnapshot;
            result_refreshed: boolean;
            result_preserved_export_count: number;
          }>(
            `SELECT sales_order_id, document_set_id, source_order_updated_at,
                    source_order_locked, result_document_version,
                    result_document_snapshot, result_refreshed,
                    result_preserved_export_count
               FROM sales_order_document_syncs
              WHERE idempotency_key=$1`,
            [dto.idempotency_key],
          );
          if (priorSync.rows.length > 0) {
            if (priorSync.rows[0].sales_order_id !== row.id) {
              throw new DocumentWorkbenchConflictException(
                'Idempotency key was already used for another sales order',
                'IDEMPOTENCY_KEY_REUSED',
              );
            }
            const existing = await this.setRow(
              client,
              { ...actor, dataScope: 'all' },
              priorSync.rows[0].document_set_id,
            );
            return this.documentSyncResponse(client, actor, existing, {
              idempotent: true,
              refreshed: priorSync.rows[0].result_refreshed,
              preservedExports: priorSync.rows[0].result_preserved_export_count,
              resultVersion: priorSync.rows[0].result_document_version,
              snapshot: priorSync.rows[0].result_document_snapshot,
              sourceUpdatedAt: priorSync.rows[0].source_order_updated_at,
              sourceLocked: priorSync.rows[0].source_order_locked,
            });
          }
          if (!this.sameTimestamp(row.updated_at, dto.expected_updated_at)) {
            throw new DocumentWorkbenchConflictException(
              'Sales order changed before documents could be synchronized',
              'SALES_ORDER_VERSION_CONFLICT',
            );
          }
          const sourceSnapshot = row.fulfillment_locked_snapshot
            ? (row.fulfillment_locked_snapshot as unknown as SalesOrderFulfillmentSnapshot)
            : await this.buildLiveOrderSnapshot(client, row, null);
          const sourceUpdatedAt = new Date(sourceSnapshot.updated_at);
          const sourceLocked = row.fulfillment_locked_snapshot !== null;
          const existing = await client.query<DocumentSetRow>(
            `SELECT ${SET_COLUMNS} FROM trade_document_sets
              WHERE sales_order_id=$1 AND source_sales_order_snapshot IS NOT NULL
              FOR UPDATE`,
            [row.id],
          );
          let document: DocumentSetRow;
          let refreshed = false;
          let preservedExports = 0;
          if (existing.rows.length === 0) {
            const documentNumber = `DOC-${row.order_number.slice(0, 45)}-${row.id.slice(0, 8)}`;
            const input = this.sourceDocumentInput(sourceSnapshot, documentNumber);
            const inserted = await client.query<DocumentSetRow>(
              `INSERT INTO trade_document_sets
                 (tenant_id, owner_user_id, customer_id, sales_order_id, quote_number,
                  pricing_mode, language, incoterm, pricing_currency, settlement_currency,
                  exchange_rate, discount_type, discount_value, freight_amount,
                  insurance_amount, tax_amount, internal_expenses, allocation_method,
                  packing_mode, theme_color, visible_fields, source_sales_order_snapshot,
                  source_sales_order_updated_at, source_sales_order_locked,
                  source_sales_order_sync_key, source_sales_order_synced_by,
                  source_sales_order_synced_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                       $18,$19,$20,$21,$22,$23,$24,$25,$26,now())
               RETURNING ${SET_COLUMNS}`,
              [
                actor.tenantId,
                row.owner_user_id,
                row.customer_id,
                row.id,
                documentNumber,
                input.pricing_mode,
                input.language,
                input.incoterm,
                input.pricing_currency,
                input.settlement_currency,
                input.exchange_rate,
                input.discount_type,
                input.discount_value,
                input.freight_amount,
                input.insurance_amount,
                input.tax_amount,
                input.internal_expenses,
                input.allocation_method,
                input.packing_mode,
                input.theme_color,
                JSON.stringify(input.visible_fields),
                JSON.stringify(sourceSnapshot),
                sourceUpdatedAt,
                sourceLocked,
                dto.idempotency_key,
                actor.userId,
              ],
            );
            document = inserted.rows[0];
            await this.insertLines(client, actor, document.id, input);
            document = await this.setRow(client, { ...actor, dataScope: 'all' }, document.id);
          } else {
            document = existing.rows[0];
            const exports = await client.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count FROM trade_document_exports
                WHERE document_set_id=$1`,
              [document.id],
            );
            preservedExports = Number(exports.rows[0].count);
            const unchanged =
              document.source_sales_order_updated_at?.toISOString() ===
                sourceUpdatedAt.toISOString() &&
              document.source_sales_order_locked === sourceLocked;
            if (!unchanged) {
              if (document.status === 'locked') {
                throw new DocumentWorkbenchConflictException(
                  'Locked order documents cannot be refreshed',
                  'ORDER_DOCUMENT_SET_LOCKED',
                );
              }
              const before = await this.snapshot(client, document);
              const input = this.sourceDocumentInput(sourceSnapshot, document.quote_number);
              const updated = await client.query<DocumentSetRow>(
                `UPDATE trade_document_sets
                    SET customer_id=$1, pricing_mode=$2, pricing_currency=$3,
                        settlement_currency=$3, exchange_rate=1, discount_type='none',
                        discount_value=0, freight_amount=0, insurance_amount=0,
                        tax_amount=0, internal_expenses=0, source_sales_order_snapshot=$4,
                        source_sales_order_updated_at=$5, source_sales_order_locked=$6,
                        source_sales_order_sync_key=$7, source_sales_order_synced_by=$8,
                        source_sales_order_synced_at=now(), version=version+1, updated_at=now()
                  WHERE id=$9
                  RETURNING ${SET_COLUMNS}`,
                [
                  row.customer_id,
                  input.pricing_mode,
                  input.pricing_currency,
                  JSON.stringify(sourceSnapshot),
                  sourceUpdatedAt,
                  sourceLocked,
                  dto.idempotency_key,
                  actor.userId,
                  document.id,
                ],
              );
              await client.query(`DELETE FROM trade_document_lines WHERE document_set_id=$1`, [
                document.id,
              ]);
              await this.insertLines(client, actor, document.id, input);
              document = updated.rows[0];
              const after = await this.snapshot(client, document);
              await this.audit.logInTransaction(client, {
                tenantId: actor.tenantId,
                actorType: 'tenant_user',
                actorId: actor.userId,
                action: 'trade_document.refreshed_from_sales_order',
                resourceType: 'trade_document_set',
                resourceId: document.id,
                before: this.auditProjection(before),
                after: this.auditProjection(after),
                metadata: { preserved_export_count: preservedExports },
              });
              refreshed = true;
            }
          }
          const resultSnapshot =
            document.status === 'locked' && document.locked_snapshot
              ? this.linkedSnapshot(document.locked_snapshot, document.sales_order_id)
              : await this.snapshot(client, document);
          await client.query(
            `INSERT INTO sales_order_document_syncs
               (tenant_id, sales_order_id, document_set_id, idempotency_key,
                source_order_updated_at, source_order_locked, result_document_version,
                result_document_snapshot, result_refreshed,
                result_preserved_export_count, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              actor.tenantId,
              row.id,
              document.id,
              dto.idempotency_key,
              sourceUpdatedAt,
              sourceLocked,
              document.version,
              JSON.stringify(resultSnapshot),
              refreshed,
              preservedExports,
              actor.userId,
            ],
          );
          if (!refreshed) {
            await this.audit.logInTransaction(client, {
              tenantId: actor.tenantId,
              actorType: 'tenant_user',
              actorId: actor.userId,
              action: 'trade_document.generated_from_sales_order',
              resourceType: 'trade_document_set',
              resourceId: document.id,
              after: this.auditProjection(resultSnapshot),
              metadata: { result_document_version: document.version },
            });
          }
          return this.documentSyncResponse(client, actor, document, {
            idempotent: false,
            refreshed,
            preservedExports,
            snapshot: resultSnapshot,
          });
        },
      );
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'uq_sales_order_document_sync_key') {
        throw new DocumentWorkbenchConflictException(
          'Idempotency key was already used for another sales order',
          'IDEMPOTENCY_KEY_REUSED',
        );
      }
      throw error;
    }
  }

  private async generatedPurchaseOrderResponse(client: PoolClient, generationId: string) {
    const orders = await client.query<DirectPurchaseOrderRow>(
      `SELECT id, supplier_id, owner_user_id, order_number, currency,
              total_amount::text, status, source_sales_order_generation_id,
              created_at, updated_at
         FROM purchase_orders
        WHERE source_sales_order_generation_id=$1 AND deleted_at IS NULL
        ORDER BY order_number, id`,
      [generationId],
    );
    return Promise.all(
      orders.rows.map(async (order) => {
        const items = await client.query<{
          id: string;
          product_id: string | null;
          source_sales_order_item_id: string;
          line_no: number;
          description: string;
          product_code: string | null;
          unit: string | null;
          quantity: string;
          unit_price: string;
          line_total: string;
        }>(
          `SELECT id, product_id, source_sales_order_item_id, line_no, description,
                  product_code, unit, quantity::text, unit_price::text, line_total::text
             FROM purchase_order_items
            WHERE order_id=$1 AND deleted_at IS NULL ORDER BY line_no`,
          [order.id],
        );
        return { ...order, items: items.rows };
      }),
    );
  }

  async generatePurchaseOrders(
    actor: DocumentWorkbenchActor,
    id: string,
    dto: GenerateSalesOrderPurchaseOrdersDto,
  ) {
    const scopedActor = await this.orderActor(actor);
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const row = await this.fulfillmentOrderRow(client, scopedActor, id, true);
          const priorKey = await client.query<{ id: string; sales_order_id: string }>(
            `SELECT id, sales_order_id FROM sales_order_purchase_generations
              WHERE idempotency_key=$1`,
            [dto.idempotency_key],
          );
          if (priorKey.rows.length > 0) {
            if (priorKey.rows[0].sales_order_id !== row.id) {
              throw new DocumentWorkbenchConflictException(
                'Idempotency key was already used for another sales order',
                'IDEMPOTENCY_KEY_REUSED',
              );
            }
            return {
              generation_id: priorKey.rows[0].id,
              purchase_orders: await this.generatedPurchaseOrderResponse(
                client,
                priorKey.rows[0].id,
              ),
              idempotent: true,
            };
          }
          if (!row.fulfillment_locked_snapshot) {
            throw new DocumentWorkbenchConflictException(
              'Lock the sales order before generating purchase orders',
              'SALES_ORDER_NOT_LOCKED',
            );
          }
          const priorOrder = await client.query<{ id: string }>(
            `SELECT id FROM sales_order_purchase_generations WHERE sales_order_id=$1`,
            [row.id],
          );
          if (priorOrder.rows.length > 0) {
            throw new DocumentWorkbenchConflictException(
              'Purchase orders were already generated with a different idempotency key',
              'PURCHASE_ORDERS_ALREADY_GENERATED',
            );
          }
          const mappings = await client.query<ProcurementProductRow>(
            `SELECT item.id AS sales_order_item_id, item.line_no, item.product_id,
                    item.product_code, item.description, item.unit, item.quantity::text,
                    product.supplier_id, supplier.company_name AS supplier_company_name,
                    product.purchase_currency, product.purchase_unit_price::text,
                    product.sku AS product_sku, product.name AS product_name
               FROM sales_order_items item
               LEFT JOIN products product
                 ON product.id=item.product_id AND product.active=true
               LEFT JOIN suppliers supplier
                 ON supplier.id=product.supplier_id AND supplier.deleted_at IS NULL
              WHERE item.order_id=$1 AND item.deleted_at IS NULL
              ORDER BY item.line_no`,
            [row.id],
          );
          const missing: ProcurementPrerequisiteMissingItem[] = mappings.rows.flatMap((item) => {
            const fields: string[] = [];
            if (!item.product_id || !item.product_sku) fields.push('product_id');
            if (!item.supplier_id || !item.supplier_company_name) fields.push('supplier_id');
            if (!item.purchase_currency) fields.push('purchase_currency');
            if (!item.purchase_unit_price) fields.push('purchase_unit_price');
            return fields.length === 0
              ? []
              : [
                  {
                    sales_order_item_id: item.sales_order_item_id,
                    line_no: item.line_no,
                    product_id: item.product_id,
                    product_code: item.product_code,
                    missing_fields: fields,
                  },
                ];
          });
          if (missing.length > 0) throw new ProcurementPrerequisitesException(missing);
          const sourceSnapshot =
            row.fulfillment_locked_snapshot as unknown as SalesOrderFulfillmentSnapshot | null;
          const generationSnapshot = {
            order: sourceSnapshot,
            procurement_lines: mappings.rows.map((item) => ({
              sales_order_item_id: item.sales_order_item_id,
              product_id: item.product_id,
              supplier_id: item.supplier_id,
              supplier_company_name: item.supplier_company_name,
              purchase_currency: item.purchase_currency,
              purchase_unit_price: item.purchase_unit_price,
              quantity: item.quantity,
            })),
          };
          const generation = await client.query<{ id: string }>(
            `INSERT INTO sales_order_purchase_generations
               (tenant_id, sales_order_id, idempotency_key, source_order_snapshot, created_by)
             VALUES ($1,$2,$3,$4,$5)
             RETURNING id`,
            [
              actor.tenantId,
              row.id,
              dto.idempotency_key,
              JSON.stringify(generationSnapshot),
              actor.userId,
            ],
          );
          const groups = new Map<string, ProcurementProductRow[]>();
          for (const item of mappings.rows) {
            const key = `${item.supplier_id}:${item.purchase_currency}`;
            groups.set(key, [...(groups.get(key) ?? []), item]);
          }
          for (const group of groups.values()) {
            const purchaseOrderId = randomUUID();
            const orderNumber = `PO-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${purchaseOrderId.slice(0, 8).toUpperCase()}`;
            const lineTotals = group.map((item) =>
              computeLineTotal(item.quantity, item.purchase_unit_price!),
            );
            const total = sumMoney(lineTotals);
            await client.query(
              `INSERT INTO purchase_orders
                 (id, tenant_id, supplier_id, owner_user_id, order_number, currency,
                  total_amount, status, notes, expected_total_amount,
                  source_sales_order_generation_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$7,$9)`,
              [
                purchaseOrderId,
                actor.tenantId,
                group[0].supplier_id,
                actor.userId,
                orderNumber,
                group[0].purchase_currency,
                total,
                `Generated from sales order ${row.order_number}`,
                generation.rows[0].id,
              ],
            );
            await client.query(
              `INSERT INTO sales_order_purchase_orders
                 (tenant_id, sales_order_id, purchase_order_id,
                  source_sales_order_generation_id)
               VALUES ($1,$2,$3,$4)`,
              [actor.tenantId, row.id, purchaseOrderId, generation.rows[0].id],
            );
            for (const [index, item] of group.entries()) {
              const lineTotal = lineTotals[index];
              const itemSnapshot = {
                sales_order_item_id: item.sales_order_item_id,
                product_id: item.product_id,
                supplier_id: item.supplier_id,
                supplier_company_name: item.supplier_company_name,
                purchase_currency: item.purchase_currency,
                purchase_unit_price: item.purchase_unit_price,
                quantity: item.quantity,
              };
              await client.query(
                `INSERT INTO purchase_order_items
                   (tenant_id, order_id, product_id, source_sales_order_item_id,
                    source_sales_order_item_snapshot, line_no, description,
                    product_code, unit, quantity, unit_price, line_total,
                    expected_unit_price, expected_line_total, pricing_snapshot)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$11,$12,$5)`,
                [
                  actor.tenantId,
                  purchaseOrderId,
                  item.product_id,
                  item.sales_order_item_id,
                  JSON.stringify(itemSnapshot),
                  index + 1,
                  item.product_name ?? item.description,
                  item.product_sku ?? item.product_code,
                  item.unit,
                  item.quantity,
                  item.purchase_unit_price,
                  lineTotal,
                ],
              );
            }
            await this.audit.logInTransaction(client, {
              tenantId: actor.tenantId,
              actorType: 'tenant_user',
              actorId: actor.userId,
              action: 'purchase_order.generated_from_sales_order',
              resourceType: 'purchase_order',
              resourceId: purchaseOrderId,
              after: {
                sales_order_id: row.id,
                generation_id: generation.rows[0].id,
                item_count: group.length,
                status: 'draft',
              },
            });
          }
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'sales_order.purchase_orders_generated',
            resourceType: 'sales_order',
            resourceId: row.id,
            after: {
              generation_id: generation.rows[0].id,
              purchase_order_count: groups.size,
              item_count: mappings.rows.length,
            },
          });
          return {
            generation_id: generation.rows[0].id,
            purchase_orders: await this.generatedPurchaseOrderResponse(
              client,
              generation.rows[0].id,
            ),
            idempotent: false,
          };
        },
      );
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === 'uq_sales_order_purchase_generation_key') {
        throw new DocumentWorkbenchConflictException(
          'Idempotency key was already used for another sales order',
          'IDEMPOTENCY_KEY_REUSED',
        );
      }
      if (constraint === 'uq_sales_order_purchase_generation_order') {
        throw new DocumentWorkbenchConflictException(
          'Purchase orders were already generated for this sales order',
          'PURCHASE_ORDERS_ALREADY_GENERATED',
        );
      }
      throw error;
    }
  }

  async convertToSalesOrder(
    actor: DocumentWorkbenchActor,
    id: string,
    dto: ConvertDocumentSetToSalesOrderDto,
  ) {
    const documentPermission = await this.rbac.checkPermission(
      actor.userId,
      actor.tenantId,
      'document_sets:view',
    );
    const sourceScope = documentPermission.allowed
      ? this.intersectScope(actor.dataScope, documentPermission.dataScope)
      : 'none';
    if (sourceScope === 'none') throw new ForbiddenException('Permission denied');
    const scopedActor = { ...actor, dataScope: sourceScope };

    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const row = await this.setRow(client, scopedActor, id, true);
          if (!row.customer_id) {
            throw new InvalidDocumentWorkbenchDataException(
              'A customer is required before creating a sales order',
              'QUOTE_CUSTOMER_REQUIRED',
            );
          }
          await assertSalesOrderCustomerInScope(client, actor, row.customer_id);
          if (row.sales_order_id) {
            const existing = await this.salesOrderResponse(client, row.sales_order_id);
            if (
              existing.row.source_document_set_id !== row.id ||
              existing.row.source_quote_idempotency_key !== dto.idempotency_key ||
              existing.row.order_number !== dto.order_number
            ) {
              throw new DocumentWorkbenchConflictException(
                'Document set is already linked to a different sales order conversion',
                'DOCUMENT_SET_ALREADY_CONVERTED',
              );
            }
            return {
              sales_order: existing.response,
              source_quote: {
                document_set_id: row.id,
                quote_number: existing.row.source_quote_number,
                version: existing.row.source_quote_version,
              },
              idempotent: true,
            };
          }
          if (row.version !== dto.expected_version) {
            throw new DocumentWorkbenchConflictException(
              'Document version changed',
              'DOCUMENT_VERSION_CONFLICT',
            );
          }
          if (!SUPPORTED_SALES_ORDER_CURRENCIES.has(row.pricing_currency)) {
            throw new InvalidDocumentWorkbenchDataException(
              `Sales orders do not support currency ${row.pricing_currency}`,
              'ORDER_CURRENCY_UNSUPPORTED',
            );
          }
          const keyOwner = await client.query<{ source_document_set_id: string }>(
            `SELECT source_document_set_id
               FROM sales_orders
              WHERE source_quote_idempotency_key=$1 AND deleted_at IS NULL`,
            [dto.idempotency_key],
          );
          if (keyOwner.rows.length > 0 && keyOwner.rows[0].source_document_set_id !== row.id) {
            throw new DocumentWorkbenchConflictException(
              'Idempotency key was already used for another quote',
              'IDEMPOTENCY_KEY_REUSED',
            );
          }

          const sourceSnapshot =
            row.status === 'locked' && row.locked_snapshot
              ? row.locked_snapshot
              : await this.snapshot(client, row);
          const tenantCurrency = await client.query<{ currency: string | null }>(
            `SELECT value_json #>> '{}' AS currency
               FROM tenant_settings
              WHERE key='base_currency'
              LIMIT 1`,
          );
          const baseCurrency = tenantCurrency.rows[0]?.currency ?? 'RMB';
          const sameCurrency = baseCurrency === sourceSnapshot.pricing_currency;
          const convertedAt = new Date();
          const insertedOrder = await client.query<SalesOrderRow>(
            `INSERT INTO sales_orders
               (tenant_id, customer_id, owner_user_id, order_number, pi_number, pi_file_id,
                currency, total_amount, status, notes, fx_rate, fx_rate_source,
                fx_captured_at, total_amount_base, source_document_set_id,
                source_quote_number, source_quote_version, source_quote_snapshot,
                source_quote_idempotency_key, source_quote_converted_by,
                source_quote_converted_at)
             VALUES ($1,$2,$3,$4,NULL,NULL,$5,$6,'draft',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             RETURNING *`,
            [
              actor.tenantId,
              row.customer_id,
              actor.userId,
              dto.order_number,
              sourceSnapshot.pricing_currency,
              sourceSnapshot.totals.grand_total,
              `Created from quote ${sourceSnapshot.quote_number} v${sourceSnapshot.source_version}`,
              sameCurrency ? '1' : null,
              sameCurrency ? 'system' : null,
              sameCurrency ? convertedAt : null,
              sameCurrency ? sourceSnapshot.totals.grand_total : null,
              row.id,
              sourceSnapshot.quote_number,
              sourceSnapshot.source_version,
              JSON.stringify(sourceSnapshot),
              dto.idempotency_key,
              actor.userId,
              convertedAt,
            ],
          );
          const order = insertedOrder.rows[0];
          const itemRows: OrderItemRow[] = [];
          for (const [index, line] of sourceSnapshot.lines.entries()) {
            const insertedItem = await client.query<OrderItemRow>(
              `INSERT INTO sales_order_items
                 (tenant_id, order_id, product_id, source_document_line_id,
                  source_line_snapshot, line_no, description, product_code, unit,
                  quantity, unit_price, line_total, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
               RETURNING *`,
              [
                actor.tenantId,
                order.id,
                line.product_id ?? null,
                line.id,
                JSON.stringify(line),
                index + 1,
                line.name,
                line.sku.slice(0, 64),
                line.unit.slice(0, 16),
                line.quantity,
                line.unit_price,
                line.line_total,
                line.description?.slice(0, 1000) ?? null,
              ],
            );
            itemRows.push(insertedItem.rows[0]);
          }
          await client.query(
            `UPDATE trade_document_sets
                SET sales_order_id=$1, updated_at=now()
              WHERE id=$2`,
            [order.id, row.id],
          );
          const response = {
            ...toSalesOrderResponse(order),
            items: itemRows.map(toOrderItemResponse),
          };
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'sales_order.created_from_quote',
            resourceType: 'sales_order',
            resourceId: order.id,
            after: response,
            metadata: {
              source_document_set_id: row.id,
              source_quote_version: sourceSnapshot.source_version,
            },
          });
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'trade_document.converted_to_sales_order',
            resourceType: 'trade_document_set',
            resourceId: row.id,
            after: this.auditProjection(this.linkedSnapshot(sourceSnapshot, order.id)),
            metadata: { sales_order_id: order.id },
          });
          return {
            sales_order: response,
            source_quote: {
              document_set_id: row.id,
              quote_number: sourceSnapshot.quote_number,
              version: sourceSnapshot.source_version,
            },
            idempotent: false,
          };
        },
      );
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === 'uq_sales_orders_tenant_order_number') {
        throw new DocumentWorkbenchConflictException(
          'Order number already exists',
          'DUPLICATE_ORDER_NUMBER',
        );
      }
      if (constraint === 'uq_sales_orders_source_quote_idempotency') {
        throw new DocumentWorkbenchConflictException(
          'Idempotency key was already used for another quote',
          'IDEMPOTENCY_KEY_REUSED',
        );
      }
      throw error;
    }
  }

  private async insertLines(
    client: PoolClient,
    actor: DocumentWorkbenchActor,
    documentSetId: string,
    dto: CreateDocumentSetDto | UpdateDocumentSetDto,
    preserveLineIds = false,
  ): Promise<void> {
    const money = this.money(dto);
    for (const [index, line] of dto.lines.entries()) {
      await client.query(
        `INSERT INTO trade_document_lines
           (id, tenant_id, document_set_id, product_id, line_no, sku, name, description,
            quantity, unit, unit_price, line_total, cost_unit_price, cost_total,
            weight_kg, volume_cbm, package_no, thumbnail_file_id, custom_values)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          preserveLineIds && line.id ? line.id : randomUUID(),
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

  private prepareUpdateInput(
    dto: UpdateDocumentSetDto,
    beforeRow: DocumentSetRow,
    beforeLines: DocumentLineRow[],
    includeFinancials: boolean,
  ): UpdateDocumentSetDto {
    const beforeById = new Map(beforeLines.map((line) => [line.id, line]));
    const requestedIds = dto.lines.flatMap((line) => (line.id ? [line.id] : []));
    if (new Set(requestedIds).size !== requestedIds.length) {
      throw new InvalidDocumentWorkbenchDataException('Document line ids must be unique');
    }
    if (requestedIds.some((lineId) => !beforeById.has(lineId))) {
      throw new InvalidDocumentWorkbenchDataException(
        'Document line ids must belong to the document set',
      );
    }
    if (includeFinancials) return dto;

    const requestedIdSet = new Set(requestedIds);
    if (beforeLines.some((line) => line.cost_unit_price !== null && !requestedIdSet.has(line.id))) {
      throw new InvalidDocumentWorkbenchDataException(
        'Financial permission is required to replace or remove costed document lines',
        'DOCUMENT_FINANCIAL_PERMISSION_REQUIRED',
      );
    }

    return {
      ...dto,
      pricing_mode: beforeRow.pricing_mode,
      internal_expenses: beforeRow.internal_expenses,
      lines: dto.lines.map((line) => ({
        ...line,
        ...(line.id
          ? { cost_unit_price: beforeById.get(line.id)?.cost_unit_price ?? undefined }
          : { cost_unit_price: undefined }),
      })),
    };
  }

  async create(actor: DocumentWorkbenchActor, dto: CreateDocumentSetDto) {
    const financialScope = await this.financialScope(actor);
    const includeFinancials = this.scopeAllowsOwner(financialScope, actor, actor.userId);
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
            after: this.auditProjection(result),
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
    const financialScope = await this.financialScope(actor);
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [];
        const conditions: string[] = [];
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          conditions.push(`owner_user_id = $${params.length}`);
        } else if (actor.dataScope !== 'all') {
          conditions.push('false');
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
        for (const row of rows.rows) {
          data.push(
            this.present(
              await this.snapshot(client, row),
              this.scopeAllowsOwner(financialScope, actor, row.owner_user_id),
            ),
          );
        }
        return { data, page, pageSize, total: Number(count.rows[0].count) };
      },
    );
  }

  async get(actor: DocumentWorkbenchActor, id: string) {
    const financialScope = await this.financialScope(actor);
    const result = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.setRow(client, actor, id);
        const storedSnapshot =
          row.status === 'locked' && row.locked_snapshot
            ? row.locked_snapshot
            : await this.snapshot(client, row);
        return {
          snapshot: this.linkedSnapshot(storedSnapshot, row.sales_order_id),
          ownerId: row.owner_user_id,
        };
      },
    );
    return this.present(
      result.snapshot,
      this.scopeAllowsOwner(financialScope, actor, result.ownerId),
    );
  }

  async update(actor: DocumentWorkbenchActor, id: string, dto: UpdateDocumentSetDto) {
    const financialScope = await this.financialScope(actor);
    try {
      const result = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const beforeRow = await this.setRow(client, actor, id, true);
          const includeFinancials = this.scopeAllowsOwner(
            financialScope,
            actor,
            beforeRow.owner_user_id,
          );
          this.validateFinancialInput(dto, includeFinancials);
          if (beforeRow.status === 'locked') {
            throw new DocumentWorkbenchConflictException(
              'Locked document sets are immutable',
              'DOCUMENT_SET_LOCKED',
            );
          }
          if (beforeRow.sales_order_id && dto.sales_order_id !== beforeRow.sales_order_id) {
            throw new DocumentWorkbenchConflictException(
              'A converted quote must keep its sales order link',
              'SALES_ORDER_LINK_IMMUTABLE',
            );
          }
          if (beforeRow.version !== dto.expected_version) {
            throw new DocumentWorkbenchConflictException(
              'Document version changed',
              'DOCUMENT_VERSION_CONFLICT',
            );
          }
          await this.verifyReferences(client, actor, dto);
          const beforeLines = await this.lines(client, id);
          const updateInput = this.prepareUpdateInput(
            dto,
            beforeRow,
            beforeLines,
            includeFinancials,
          );
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
              updateInput.customer_id ?? null,
              updateInput.sales_order_id ?? null,
              updateInput.quote_number,
              updateInput.pricing_mode ?? 'final_price',
              updateInput.language ?? 'en',
              updateInput.incoterm ?? 'FOB',
              updateInput.pricing_currency,
              updateInput.settlement_currency,
              updateInput.exchange_rate,
              updateInput.discount_type ?? 'none',
              updateInput.discount_value ?? '0',
              updateInput.freight_amount ?? '0',
              updateInput.insurance_amount ?? '0',
              updateInput.tax_amount ?? '0',
              updateInput.internal_expenses ?? '0',
              updateInput.allocation_method ?? 'value',
              updateInput.packing_mode ?? 'normal',
              updateInput.theme_color ?? '#155EEF',
              JSON.stringify(updateInput.visible_fields ?? {}),
              updateInput.terms?.trim() || null,
              updateInput.bank_info?.trim() || null,
              updateInput.logo_file_id ?? null,
              updateInput.signature_file_id ?? null,
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
          await this.insertLines(client, actor, id, updateInput, true);
          const after = await this.snapshot(client, updated.rows[0]);
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'trade_document.updated',
            resourceType: 'trade_document_set',
            resourceId: id,
            before: this.auditProjection(before),
            after: this.auditProjection(after),
          });
          return { snapshot: after, ownerId: beforeRow.owner_user_id };
        },
      );
      return this.present(
        result.snapshot,
        this.scopeAllowsOwner(financialScope, actor, result.ownerId),
      );
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
    const financialScope = await this.financialScope(actor);
    const result = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.setRow(client, actor, id, true);
        if (row.status === 'locked') {
          if (!row.locked_snapshot)
            throw new DocumentWorkbenchConflictException('Locked snapshot is missing');
          return {
            snapshot: this.linkedSnapshot(row.locked_snapshot, row.sales_order_id),
            ownerId: row.owner_user_id,
          };
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
          after: this.auditProjection(snapshot),
        });
        return { snapshot, ownerId: row.owner_user_id };
      },
    );
    return this.present(
      result.snapshot,
      this.scopeAllowsOwner(financialScope, actor, result.ownerId),
    );
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
    const dataScope = await this.fileScope(actor, ['files:view', 'files:download']);
    const files = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        return this.files.findManyInScope(
          client,
          { userId: actor.userId, tenantId: actor.tenantId, dataScope },
          fileIds,
        );
      },
    );
    if (
      files.length !== new Set(fileIds).size ||
      files.some((file) => !file.mime_type.startsWith('image/'))
    ) {
      throw new DocumentWorkbenchNotFoundException('Document asset');
    }
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
