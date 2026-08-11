import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import type { InternalDocumentSnapshot } from '../document-workbench/document.types';
import { FilesService } from '../files/files.service';
import { STORAGE_PROVIDER, StorageProvider } from '../storage/storage-provider.interface';
import { QuotaService } from '../subscription/quota.service';
import {
  CustomsDeclarationConflictException,
  CustomsDeclarationNotFoundException,
  CustomsConsistencyIssue,
  CustomsSourceInconsistentException,
} from './customs-declarations.errors';
import {
  CustomsDeclarationData,
  CustomsDocumentType,
  CustomsPdfSnapshot,
} from './customs-declarations.types';
import {
  CreateCustomsDeclarationDto,
  CustomsIdempotencyDto,
  RefreshCustomsDeclarationDto,
} from './dto/customs-declaration.dto';
import { CUSTOMS_PDF_RENDERER, CustomsPdfRenderer } from './customs-pdf.renderer';

export interface CustomsDeclarationActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

interface LockedOrderSnapshot {
  id: string;
  owner_user_id: string;
  customer_id: string;
  order_number: string;
  currency: string;
  total_amount: string;
  status: string;
  updated_at: string;
  locked_at: string | null;
  items: Array<{
    id: string;
    product_id: string | null;
    line_no: number;
    description: string;
    product_code: string | null;
    unit: string | null;
    quantity: string;
    unit_price: string;
    line_total: string;
    product: {
      sku: string;
      name: string;
      hs_code: string | null;
      weight_kg: string | null;
      custom_values: Record<string, unknown>;
    } | null;
  }>;
}

interface SalesOrderRow {
  id: string;
  owner_user_id: string;
  order_number: string;
  status: string;
  fulfillment_locked_snapshot: LockedOrderSnapshot | null;
}

interface SourceExportRow {
  id: string;
  document_set_id: string;
  source_version: number;
  export_version: number;
  document_type: 'ci' | 'pl';
  snapshot_json: InternalDocumentSnapshot;
  file_id: string;
  is_draft: boolean;
  created_at: Date;
}

interface DeclarationSetRow {
  id: string;
  sales_order_id: string;
  owner_user_id: string;
  status: 'draft' | 'generated';
  draft_revision: number;
  latest_version: number;
  source_order_snapshot: LockedOrderSnapshot;
  source_ci_export_id: string;
  source_ci_snapshot: InternalDocumentSnapshot;
  source_pl_export_id: string;
  source_pl_snapshot: InternalDocumentSnapshot;
  customs_data: CustomsDeclarationData;
  source_fingerprint: string;
  created_by: string;
  refreshed_by: string | null;
  refreshed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface DeclarationVersionRow {
  id: string;
  declaration_set_id: string;
  version: number;
  source_ci_export_id: string;
  source_pl_export_id: string;
  customs_data: CustomsDeclarationData;
  consistency_result: { valid: true; missing: []; conflicts: [] };
  source_fingerprint: string;
  pre_entry_file_id: string;
  authorization_file_id: string;
  generated_by: string;
  generated_at: Date;
}

interface OperationRow {
  operation_type: 'create' | 'refresh' | 'generate' | 'export';
  request_hash: string;
  result_json: {
    declaration_set_id: string;
    version?: number;
    refreshed?: boolean;
    draft_revision?: number;
    preserved_version_count?: number;
  };
}

const SET_COLUMNS = `id, sales_order_id, owner_user_id, status, draft_revision,
  latest_version, source_order_snapshot, source_ci_export_id, source_ci_snapshot,
  source_pl_export_id, source_pl_snapshot, customs_data, source_fingerprint,
  created_by, refreshed_by, refreshed_at, created_at, updated_at`;

const VERSION_COLUMNS = `id, declaration_set_id, version, source_ci_export_id,
  source_pl_export_id, customs_data, consistency_result, source_fingerprint,
  pre_entry_file_id, authorization_file_id, generated_by, generated_at`;

const APPROVED_ORDER_STATES = new Set([
  'approved',
  'confirmed',
  'completed',
  'customer_confirmed',
  'payment_gate_open',
  'procurement',
  'fulfillment',
  'delivered',
  'finance_review',
  'settled',
]);

type DeclarationDetails = Omit<CreateCustomsDeclarationDto, 'idempotency_key'>;

@Injectable()
export class CustomsDeclarationsService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CUSTOMS_PDF_RENDERER) private readonly pdfRenderer: CustomsPdfRenderer,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  private restrictsToOwner(dataScope: string): boolean {
    return dataScope === 'own' || dataScope === 'assigned';
  }

  private canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.canonical(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right),
      );
      return `{${entries
        .map(([key, item]) => `${JSON.stringify(key)}:${this.canonical(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private hash(value: unknown): string {
    return createHash('sha256').update(this.canonical(value)).digest('hex');
  }

  private requestHash(
    operation: OperationRow['operation_type'],
    resourceId: string,
    body: unknown,
  ): string {
    return this.hash({ operation, resource_id: resourceId, body });
  }

  private decimalParts(value: string): { negative: boolean; digits: string; scale: number } | null {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) return null;
    const fraction = (match[3] ?? '').replace(/0+$/, '');
    const whole = match[2].replace(/^0+(?=\d)/, '');
    return {
      negative: match[1] === '-' && !/^0+$/.test(`${whole}${fraction}`),
      digits: `${whole}${fraction}`.replace(/^0+(?=\d)/, ''),
      scale: fraction.length,
    };
  }

  private compareDecimals(left: string, right: string): number | null {
    const a = this.decimalParts(left);
    const b = this.decimalParts(right);
    if (!a || !b) return null;
    if (a.negative !== b.negative) return a.negative ? -1 : 1;
    const scale = Math.max(a.scale, b.scale);
    const aValue = BigInt(a.digits) * 10n ** BigInt(scale - a.scale);
    const bValue = BigInt(b.digits) * 10n ** BigInt(scale - b.scale);
    const comparison = aValue === bValue ? 0 : aValue > bValue ? 1 : -1;
    return a.negative ? -comparison : comparison;
  }

  private details(dto: CreateCustomsDeclarationDto | RefreshCustomsDeclarationDto) {
    return {
      port: dto.port,
      trade_mode: dto.trade_mode,
      package_type: dto.package_type,
      gross_weight_kg: dto.gross_weight_kg,
      consignor_name: dto.consignor_name,
      consignor_uscc: dto.consignor_uscc,
      consignor_contact: dto.consignor_contact,
      consignor_phone: dto.consignor_phone,
      customs_broker_name: dto.customs_broker_name,
      customs_broker_uscc: dto.customs_broker_uscc,
      customs_broker_contact: dto.customs_broker_contact,
      customs_broker_phone: dto.customs_broker_phone,
      authorization_matters: dto.authorization_matters,
    } satisfies DeclarationDetails;
  }

  private async operation(
    client: PoolClient,
    idempotencyKey: string,
    operationType: OperationRow['operation_type'],
    requestHash: string,
  ): Promise<OperationRow | null> {
    const result = await client.query<OperationRow>(
      `SELECT operation_type, request_hash, result_json
         FROM customs_declaration_operations
        WHERE idempotency_key=$1`,
      [idempotencyKey],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row.operation_type !== operationType || row.request_hash !== requestHash) {
      throw new CustomsDeclarationConflictException(
        'Idempotency key was already used for another request',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    return row;
  }

  private async orderRow(
    client: PoolClient,
    actor: CustomsDeclarationActor,
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
    const result = await client.query<SalesOrderRow>(
      `SELECT id, owner_user_id, order_number, status, fulfillment_locked_snapshot
         FROM sales_orders
        WHERE id=$1 AND deleted_at IS NULL${scope}${lock ? ' FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0) throw new CustomsDeclarationNotFoundException();
    const row = result.rows[0];
    const missing: CustomsConsistencyIssue[] = [];
    if (!row.fulfillment_locked_snapshot) {
      missing.push({ code: 'ORDER_NOT_LOCKED', field: 'sales_order.fulfillment_locked_snapshot' });
    }
    if (!APPROVED_ORDER_STATES.has(row.status)) {
      missing.push({ code: 'ORDER_NOT_APPROVED', field: 'sales_order.status', actual: row.status });
    }
    if (missing.length > 0) throw new CustomsSourceInconsistentException(missing, []);
    return row;
  }

  private async setRow(
    client: PoolClient,
    actor: CustomsDeclarationActor,
    id: string,
    lock = false,
  ): Promise<DeclarationSetRow> {
    const params: unknown[] = [id];
    let scope = '';
    if (this.restrictsToOwner(actor.dataScope)) {
      params.push(actor.userId);
      scope = ` AND owner_user_id=$${params.length}`;
    } else if (actor.dataScope !== 'all') {
      scope = ' AND false';
    }
    const result = await client.query<DeclarationSetRow>(
      `SELECT ${SET_COLUMNS} FROM customs_declaration_sets
        WHERE id=$1${scope}${lock ? ' FOR UPDATE' : ''}`,
      params,
    );
    if (result.rows.length === 0) throw new CustomsDeclarationNotFoundException();
    return result.rows[0];
  }

  private async latestSources(client: PoolClient, salesOrderId: string) {
    const result = await client.query<SourceExportRow>(
      `SELECT DISTINCT ON (export.document_type)
              export.id, export.document_set_id, export.source_version,
              export.export_version, export.document_type, export.snapshot_json,
              export.file_id, export.is_draft, export.created_at
         FROM trade_document_exports export
         JOIN trade_document_sets document
           ON document.id=export.document_set_id AND document.tenant_id=export.tenant_id
        WHERE document.sales_order_id=$1
          AND document.status='locked'
          AND export.document_type IN ('ci','pl')
          AND export.is_draft=false
        ORDER BY export.document_type, export.export_version DESC, export.created_at DESC`,
      [salesOrderId],
    );
    const ci = result.rows.find((row) => row.document_type === 'ci');
    const pl = result.rows.find((row) => row.document_type === 'pl');
    const missing: CustomsConsistencyIssue[] = [];
    if (!ci) missing.push({ code: 'LOCKED_CI_EXPORT_REQUIRED', field: 'commercial_invoice' });
    if (!pl) missing.push({ code: 'LOCKED_PL_EXPORT_REQUIRED', field: 'packing_list' });
    if (missing.length > 0) throw new CustomsSourceInconsistentException(missing, []);
    const conflicts: CustomsConsistencyIssue[] = [];
    if (ci!.document_set_id !== pl!.document_set_id) {
      conflicts.push({ code: 'DOCUMENT_SET_MISMATCH', field: 'document_set_id' });
    }
    if (ci!.source_version !== pl!.source_version) {
      conflicts.push({
        code: 'DOCUMENT_VERSION_MISMATCH',
        field: 'source_version',
        expected: String(ci!.source_version),
        actual: String(pl!.source_version),
      });
    }
    if (conflicts.length > 0) throw new CustomsSourceInconsistentException([], conflicts);
    return { ci: ci!, pl: pl! };
  }

  private buildData(
    order: LockedOrderSnapshot,
    ci: InternalDocumentSnapshot,
    pl: InternalDocumentSnapshot,
    details: DeclarationDetails,
  ): CustomsDeclarationData {
    const missing: CustomsConsistencyIssue[] = [];
    const conflicts: CustomsConsistencyIssue[] = [];
    const conflict = (
      code: string,
      field: string,
      expected: unknown,
      actual: unknown,
      lineNo?: number,
    ) =>
      conflicts.push({
        code,
        field,
        expected: String(expected),
        actual: String(actual),
        ...(lineNo === undefined ? {} : { line_no: lineNo }),
      });

    if (ci.sales_order_id !== order.id)
      conflict('CI_ORDER_MISMATCH', 'ci.sales_order_id', order.id, ci.sales_order_id);
    if (pl.sales_order_id !== order.id)
      conflict('PL_ORDER_MISMATCH', 'pl.sales_order_id', order.id, pl.sales_order_id);
    if (ci.status !== 'locked') conflict('CI_NOT_LOCKED', 'ci.status', 'locked', ci.status);
    if (pl.status !== 'locked') conflict('PL_NOT_LOCKED', 'pl.status', 'locked', pl.status);
    if (ci.pricing_currency !== order.currency)
      conflict('CI_CURRENCY_MISMATCH', 'ci.pricing_currency', order.currency, ci.pricing_currency);
    if (pl.pricing_currency !== order.currency)
      conflict('PL_CURRENCY_MISMATCH', 'pl.pricing_currency', order.currency, pl.pricing_currency);
    if (this.compareDecimals(order.total_amount, ci.totals.grand_total) !== 0)
      conflict(
        'CI_TOTAL_MISMATCH',
        'ci.totals.grand_total',
        order.total_amount,
        ci.totals.grand_total,
      );
    if (this.compareDecimals(ci.totals.grand_total, pl.totals.grand_total) !== 0)
      conflict(
        'PL_TOTAL_MISMATCH',
        'pl.totals.grand_total',
        ci.totals.grand_total,
        pl.totals.grand_total,
      );
    if (ci.lines.length !== order.items.length)
      conflict('CI_LINE_COUNT_MISMATCH', 'ci.lines', order.items.length, ci.lines.length);
    if (pl.lines.length !== order.items.length)
      conflict('PL_LINE_COUNT_MISMATCH', 'pl.lines', order.items.length, pl.lines.length);
    if (pl.packages.length === 0)
      missing.push({ code: 'PL_PACKAGES_REQUIRED', field: 'pl.packages' });
    if (this.compareDecimals(pl.totals.total_weight_kg, '0') !== 1)
      missing.push({ code: 'PL_NET_WEIGHT_REQUIRED', field: 'pl.totals.total_weight_kg' });
    if (this.compareDecimals(details.gross_weight_kg, pl.totals.total_weight_kg) === -1) {
      conflict(
        'GROSS_WEIGHT_BELOW_NET_WEIGHT',
        'gross_weight_kg',
        pl.totals.total_weight_kg,
        details.gross_weight_kg,
      );
    }

    const lines = order.items.map((item) => {
      const ciLine = ci.lines.find((line) => line.line_no === item.line_no);
      const plLine = pl.lines.find((line) => line.line_no === item.line_no);
      if (!ciLine)
        missing.push({ code: 'CI_LINE_REQUIRED', field: 'ci.lines', line_no: item.line_no });
      if (!plLine)
        missing.push({ code: 'PL_LINE_REQUIRED', field: 'pl.lines', line_no: item.line_no });
      const hsCode = item.product?.hs_code?.trim() ?? '';
      const declarationElements = item.product?.custom_values?.declaration_elements;
      if (!hsCode)
        missing.push({ code: 'HS_CODE_REQUIRED', field: 'product.hs_code', line_no: item.line_no });
      if (typeof declarationElements !== 'string' || !declarationElements.trim()) {
        missing.push({
          code: 'DECLARATION_ELEMENTS_REQUIRED',
          field: 'product.custom_values.declaration_elements',
          line_no: item.line_no,
        });
      }
      if (ciLine) {
        if ((ciLine.product_id ?? null) !== item.product_id)
          conflict(
            'CI_PRODUCT_MISMATCH',
            'ci.lines.product_id',
            item.product_id,
            ciLine.product_id,
            item.line_no,
          );
        if (this.compareDecimals(item.quantity, ciLine.quantity) !== 0)
          conflict(
            'CI_QUANTITY_MISMATCH',
            'ci.lines.quantity',
            item.quantity,
            ciLine.quantity,
            item.line_no,
          );
        if (this.compareDecimals(item.unit_price, ciLine.unit_price) !== 0)
          conflict(
            'CI_UNIT_PRICE_MISMATCH',
            'ci.lines.unit_price',
            item.unit_price,
            ciLine.unit_price,
            item.line_no,
          );
        if (this.compareDecimals(item.line_total, ciLine.line_total) !== 0)
          conflict(
            'CI_LINE_TOTAL_MISMATCH',
            'ci.lines.line_total',
            item.line_total,
            ciLine.line_total,
            item.line_no,
          );
        if ((item.unit ?? '') !== ciLine.unit)
          conflict('CI_UNIT_MISMATCH', 'ci.lines.unit', item.unit ?? '', ciLine.unit, item.line_no);
      }
      if (plLine) {
        if ((plLine.product_id ?? null) !== item.product_id)
          conflict(
            'PL_PRODUCT_MISMATCH',
            'pl.lines.product_id',
            item.product_id,
            plLine.product_id,
            item.line_no,
          );
        if (this.compareDecimals(item.quantity, plLine.quantity) !== 0)
          conflict(
            'PL_QUANTITY_MISMATCH',
            'pl.lines.quantity',
            item.quantity,
            plLine.quantity,
            item.line_no,
          );
        if (!plLine.total_weight_kg || this.compareDecimals(plLine.total_weight_kg, '0') !== 1) {
          missing.push({
            code: 'PL_LINE_NET_WEIGHT_REQUIRED',
            field: 'pl.lines.total_weight_kg',
            line_no: item.line_no,
          });
        }
      }
      const packageNo =
        plLine?.package_no ??
        pl.packages.find((sourcePackage) => sourcePackage.line_nos.includes(item.line_no))
          ?.package_no ??
        '';
      if (!packageNo)
        missing.push({
          code: 'PL_PACKAGE_REQUIRED',
          field: 'pl.lines.package_no',
          line_no: item.line_no,
        });
      return {
        line_no: item.line_no,
        sales_order_item_id: item.id,
        product_code: item.product?.sku ?? item.product_code ?? `LINE-${item.line_no}`,
        description: item.description,
        hs_code: hsCode,
        declaration_elements:
          typeof declarationElements === 'string' ? declarationElements.trim() : '',
        quantity: ciLine?.quantity ?? item.quantity,
        unit: ciLine?.unit ?? item.unit ?? '',
        unit_price: ciLine?.unit_price ?? item.unit_price,
        line_total: ciLine?.line_total ?? item.line_total,
        currency: ci.pricing_currency,
        package_no: packageNo,
        net_weight_kg: plLine?.total_weight_kg ?? '',
      };
    });

    if (missing.length > 0 || conflicts.length > 0) {
      throw new CustomsSourceInconsistentException(missing, conflicts);
    }
    return {
      declaration_number: `CUS-${order.order_number}`.slice(0, 80),
      sales_order_id: order.id,
      order_number: order.order_number,
      port: details.port,
      trade_mode: details.trade_mode,
      package_type: details.package_type,
      package_count: pl.packages.length,
      gross_weight_kg: details.gross_weight_kg,
      net_weight_kg: pl.totals.total_weight_kg,
      currency: ci.pricing_currency,
      total_amount: ci.totals.grand_total,
      consignor: {
        name: details.consignor_name,
        uscc: details.consignor_uscc,
        contact: details.consignor_contact,
        phone: details.consignor_phone,
      },
      customs_broker: {
        name: details.customs_broker_name,
        uscc: details.customs_broker_uscc,
        contact: details.customs_broker_contact,
        phone: details.customs_broker_phone,
      },
      authorization_matters: [...details.authorization_matters],
      lines,
    };
  }

  private fingerprint(
    order: LockedOrderSnapshot,
    ci: SourceExportRow | Pick<DeclarationSetRow, 'source_ci_export_id' | 'source_ci_snapshot'>,
    pl: SourceExportRow | Pick<DeclarationSetRow, 'source_pl_export_id' | 'source_pl_snapshot'>,
    data: CustomsDeclarationData,
  ): string {
    const ciId = 'snapshot_json' in ci ? ci.id : ci.source_ci_export_id;
    const ciSnapshot = 'snapshot_json' in ci ? ci.snapshot_json : ci.source_ci_snapshot;
    const plId = 'snapshot_json' in pl ? pl.id : pl.source_pl_export_id;
    const plSnapshot = 'snapshot_json' in pl ? pl.snapshot_json : pl.source_pl_snapshot;
    return this.hash({
      order,
      ci_export_id: ciId,
      ci_snapshot: ciSnapshot,
      pl_export_id: plId,
      pl_snapshot: plSnapshot,
      customs_data: data,
    });
  }

  private assertFingerprint(row: DeclarationSetRow): void {
    const actual = this.fingerprint(row.source_order_snapshot, row, row, row.customs_data);
    if (actual !== row.source_fingerprint) {
      throw new CustomsDeclarationConflictException(
        'Archived customs source fingerprint does not match',
        'CUSTOMS_SOURCE_FINGERPRINT_MISMATCH',
      );
    }
  }

  private versionResponse(row: DeclarationVersionRow) {
    return {
      id: row.id,
      declaration_set_id: row.declaration_set_id,
      version: row.version,
      source_ci_export_id: row.source_ci_export_id,
      source_pl_export_id: row.source_pl_export_id,
      source_fingerprint: row.source_fingerprint,
      pre_entry_file_id: row.pre_entry_file_id,
      authorization_file_id: row.authorization_file_id,
      generated_by: row.generated_by,
      generated_at: row.generated_at,
      customs_data: row.customs_data,
      consistency: row.consistency_result,
    };
  }

  private async versionRow(
    client: PoolClient,
    declarationSetId: string,
    version: number,
  ): Promise<DeclarationVersionRow> {
    const result = await client.query<DeclarationVersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM customs_declaration_versions
        WHERE declaration_set_id=$1 AND version=$2`,
      [declarationSetId, version],
    );
    if (result.rows.length === 0) throw new CustomsDeclarationNotFoundException();
    return result.rows[0];
  }

  private async declarationResponse(client: PoolClient, row: DeclarationSetRow) {
    const [exports, versions] = await Promise.all([
      client.query<
        Pick<
          SourceExportRow,
          'id' | 'source_version' | 'export_version' | 'document_type' | 'file_id'
        >
      >(
        `SELECT id, source_version, export_version, document_type, file_id
           FROM trade_document_exports
          WHERE id=ANY($1::uuid[])`,
        [[row.source_ci_export_id, row.source_pl_export_id]],
      ),
      client.query<DeclarationVersionRow>(
        `SELECT ${VERSION_COLUMNS} FROM customs_declaration_versions
          WHERE declaration_set_id=$1 ORDER BY version DESC`,
        [row.id],
      ),
    ]);
    const source = (type: 'ci' | 'pl') => {
      const found = exports.rows.find((item) => item.document_type === type);
      if (!found) throw new CustomsDeclarationNotFoundException();
      return {
        export_id: found.id,
        source_version: found.source_version,
        export_version: found.export_version,
        file_id: found.file_id,
      };
    };
    return {
      id: row.id,
      sales_order_id: row.sales_order_id,
      owner_user_id: row.owner_user_id,
      status: row.status,
      draft_revision: row.draft_revision,
      latest_version: row.latest_version,
      source: {
        order_locked_at: row.source_order_snapshot.locked_at,
        ci: source('ci'),
        pl: source('pl'),
        fingerprint: row.source_fingerprint,
      },
      customs_data: row.customs_data,
      versions: versions.rows.map((version) => this.versionResponse(version)),
      created_by: row.created_by,
      refreshed_by: row.refreshed_by,
      refreshed_at: row.refreshed_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async getBySalesOrder(actor: CustomsDeclarationActor, salesOrderId: string) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [salesOrderId];
        let scope = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scope = ` AND owner_user_id=$${params.length}`;
        } else if (actor.dataScope !== 'all') {
          scope = ' AND false';
        }
        const result = await client.query<DeclarationSetRow>(
          `SELECT ${SET_COLUMNS} FROM customs_declaration_sets
            WHERE sales_order_id=$1${scope}`,
          params,
        );
        if (result.rows.length === 0) throw new CustomsDeclarationNotFoundException();
        return this.declarationResponse(client, result.rows[0]);
      },
    );
  }

  async list(actor: CustomsDeclarationActor) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const params: unknown[] = [];
        let scope = '';
        if (this.restrictsToOwner(actor.dataScope)) {
          params.push(actor.userId);
          scope = ` WHERE owner_user_id=$${params.length}`;
        } else if (actor.dataScope !== 'all') {
          scope = ' WHERE false';
        }
        const result = await client.query<DeclarationSetRow>(
          `SELECT ${SET_COLUMNS} FROM customs_declaration_sets${scope}
            ORDER BY updated_at DESC, id DESC`,
          params,
        );
        const data = [];
        for (const row of result.rows) {
          data.push(await this.declarationResponse(client, row));
        }
        return { data };
      },
    );
  }

  async createVersionDownloadToken(
    actor: CustomsDeclarationActor,
    declarationSetId: string,
    version: number,
    documentType: CustomsDocumentType,
  ) {
    const fileId = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        await this.setRow(client, actor, declarationSetId);
        const archived = await this.versionRow(client, declarationSetId, version);
        return documentType === 'pre_entry'
          ? archived.pre_entry_file_id
          : archived.authorization_file_id;
      },
    );
    const purpose = documentType === 'pre_entry' ? 'customs-pre-entry' : 'customs-authorization';
    return this.files.createDomainDownloadToken(actor, fileId, purpose);
  }

  async create(
    actor: CustomsDeclarationActor,
    salesOrderId: string,
    dto: CreateCustomsDeclarationDto,
  ) {
    const details = this.details(dto);
    const requestHash = this.requestHash('create', salesOrderId, details);
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const prior = await this.operation(client, dto.idempotency_key, 'create', requestHash);
          if (prior) {
            const row = await this.setRow(client, actor, prior.result_json.declaration_set_id);
            return { declaration: await this.declarationResponse(client, row), idempotent: true };
          }
          const order = await this.orderRow(client, actor, salesOrderId, true);
          const committedPrior = await this.operation(
            client,
            dto.idempotency_key,
            'create',
            requestHash,
          );
          if (committedPrior) {
            const committed = await this.setRow(
              client,
              actor,
              committedPrior.result_json.declaration_set_id,
            );
            return {
              declaration: await this.declarationResponse(client, committed),
              idempotent: true,
            };
          }
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM customs_declaration_sets WHERE sales_order_id=$1`,
            [salesOrderId],
          );
          if (existing.rows.length > 0) {
            throw new CustomsDeclarationConflictException(
              'A customs declaration already exists for this sales order; use refresh',
              'CUSTOMS_DECLARATION_EXISTS',
            );
          }
          const sources = await this.latestSources(client, salesOrderId);
          const orderSnapshot = order.fulfillment_locked_snapshot!;
          const data = this.buildData(
            orderSnapshot,
            sources.ci.snapshot_json,
            sources.pl.snapshot_json,
            details,
          );
          const fingerprint = this.fingerprint(orderSnapshot, sources.ci, sources.pl, data);
          const inserted = await client.query<DeclarationSetRow>(
            `INSERT INTO customs_declaration_sets
               (tenant_id, sales_order_id, owner_user_id, source_order_snapshot,
                source_ci_export_id, source_ci_snapshot, source_pl_export_id,
                source_pl_snapshot, customs_data, source_fingerprint, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING ${SET_COLUMNS}`,
            [
              actor.tenantId,
              salesOrderId,
              order.owner_user_id,
              JSON.stringify(orderSnapshot),
              sources.ci.id,
              JSON.stringify(sources.ci.snapshot_json),
              sources.pl.id,
              JSON.stringify(sources.pl.snapshot_json),
              JSON.stringify(data),
              fingerprint,
              actor.userId,
            ],
          );
          const row = inserted.rows[0];
          await client.query(
            `INSERT INTO customs_declaration_operations
               (tenant_id, sales_order_id, declaration_set_id, operation_type,
                idempotency_key, request_hash, result_json, created_by)
             VALUES ($1,$2,$3,'create',$4,$5,$6,$7)`,
            [
              actor.tenantId,
              salesOrderId,
              row.id,
              dto.idempotency_key,
              requestHash,
              JSON.stringify({ declaration_set_id: row.id }),
              actor.userId,
            ],
          );
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'customs_declaration.created',
            resourceType: 'customs_declaration_set',
            resourceId: row.id,
            after: {
              sales_order_id: salesOrderId,
              ci_export_id: sources.ci.id,
              pl_export_id: sources.pl.id,
              source_fingerprint: fingerprint,
            },
          });
          return { declaration: await this.declarationResponse(client, row), idempotent: false };
        },
      );
    } catch (error) {
      if (
        (error as { constraint?: string }).constraint === 'uq_customs_declaration_operations_key'
      ) {
        return withTenantContext(
          this.pool,
          { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
          async (client) => {
            const prior = await this.operation(client, dto.idempotency_key, 'create', requestHash);
            if (!prior) throw error;
            const row = await this.setRow(client, actor, prior.result_json.declaration_set_id);
            return { declaration: await this.declarationResponse(client, row), idempotent: true };
          },
        );
      }
      throw error;
    }
  }

  async refresh(
    actor: CustomsDeclarationActor,
    declarationSetId: string,
    dto: RefreshCustomsDeclarationDto,
  ) {
    const details = this.details(dto);
    const requestHash = this.requestHash('refresh', declarationSetId, details);
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.setRow(client, actor, declarationSetId, true);
        const prior = await this.operation(client, dto.idempotency_key, 'refresh', requestHash);
        if (prior) {
          const current = await this.setRow(client, actor, declarationSetId);
          return {
            declaration: await this.declarationResponse(client, current),
            idempotent: true,
            refreshed: prior.result_json.refreshed ?? false,
            preserved_version_count: prior.result_json.preserved_version_count ?? 0,
          };
        }
        const order = await this.orderRow(client, actor, row.sales_order_id, true);
        const sources = await this.latestSources(client, row.sales_order_id);
        const orderSnapshot = order.fulfillment_locked_snapshot!;
        const data = this.buildData(
          orderSnapshot,
          sources.ci.snapshot_json,
          sources.pl.snapshot_json,
          details,
        );
        const fingerprint = this.fingerprint(orderSnapshot, sources.ci, sources.pl, data);
        const refreshed = fingerprint !== row.source_fingerprint;
        const nextRevision = refreshed ? row.draft_revision + 1 : row.draft_revision;
        let current = row;
        if (refreshed) {
          const updated = await client.query<DeclarationSetRow>(
            `UPDATE customs_declaration_sets
                SET status='draft', draft_revision=$1, source_order_snapshot=$2,
                    source_ci_export_id=$3, source_ci_snapshot=$4,
                    source_pl_export_id=$5, source_pl_snapshot=$6, customs_data=$7,
                    source_fingerprint=$8, refreshed_by=$9, refreshed_at=now(), updated_at=now()
              WHERE id=$10
              RETURNING ${SET_COLUMNS}`,
            [
              nextRevision,
              JSON.stringify(orderSnapshot),
              sources.ci.id,
              JSON.stringify(sources.ci.snapshot_json),
              sources.pl.id,
              JSON.stringify(sources.pl.snapshot_json),
              JSON.stringify(data),
              fingerprint,
              actor.userId,
              row.id,
            ],
          );
          current = updated.rows[0];
        }
        await client.query(
          `INSERT INTO customs_declaration_operations
             (tenant_id, sales_order_id, declaration_set_id, operation_type,
              idempotency_key, request_hash, result_json, created_by)
           VALUES ($1,$2,$3,'refresh',$4,$5,$6,$7)`,
          [
            actor.tenantId,
            row.sales_order_id,
            row.id,
            dto.idempotency_key,
            requestHash,
            JSON.stringify({
              declaration_set_id: row.id,
              refreshed,
              draft_revision: nextRevision,
              preserved_version_count: row.latest_version,
            }),
            actor.userId,
          ],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'customs_declaration.refreshed',
          resourceType: 'customs_declaration_set',
          resourceId: row.id,
          before: {
            draft_revision: row.draft_revision,
            source_fingerprint: row.source_fingerprint,
          },
          after: {
            draft_revision: nextRevision,
            source_fingerprint: fingerprint,
            ci_export_id: sources.ci.id,
            pl_export_id: sources.pl.id,
          },
          metadata: { refreshed, preserved_version_count: row.latest_version },
        });
        return {
          declaration: await this.declarationResponse(client, current),
          idempotent: false,
          refreshed,
          preserved_version_count: row.latest_version,
        };
      },
    );
  }

  async generate(
    actor: CustomsDeclarationActor,
    declarationSetId: string,
    dto: CustomsIdempotencyDto,
  ) {
    const requestHash = this.requestHash('generate', declarationSetId, {});
    const prepared = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.setRow(client, actor, declarationSetId);
        const prior = await this.operation(client, dto.idempotency_key, 'generate', requestHash);
        if (prior?.result_json.version) {
          return {
            prior: this.versionResponse(
              await this.versionRow(client, declarationSetId, prior.result_json.version),
            ),
          };
        }
        this.assertFingerprint(row);
        return { row, tentativeVersion: row.latest_version + 1 };
      },
    );
    if ('prior' in prepared) return { version: prepared.prior, idempotent: true };

    const pdfSnapshot: CustomsPdfSnapshot = {
      version: prepared.tentativeVersion,
      generated_at: new Date().toISOString(),
      data: prepared.row.customs_data,
    };
    const preEntryPdf = await this.pdfRenderer.render(pdfSnapshot, 'pre_entry');
    const authorizationPdf = await this.pdfRenderer.render(pdfSnapshot, 'authorization');
    for (const pdf of [preEntryPdf, authorizationPdf]) {
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new Error('PDF renderer returned an invalid document');
      }
    }

    const preEntryStorageKey = `${actor.tenantId}/${randomUUID()}`;
    const authorizationStorageKey = `${actor.tenantId}/${randomUUID()}`;
    const storedKeys: string[] = [];
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const row = await this.setRow(client, actor, declarationSetId, true);
          const prior = await this.operation(client, dto.idempotency_key, 'generate', requestHash);
          if (prior?.result_json.version) {
            return {
              version: this.versionResponse(
                await this.versionRow(client, declarationSetId, prior.result_json.version),
              ),
              idempotent: true,
            };
          }
          this.assertFingerprint(row);
          if (
            row.latest_version + 1 !== prepared.tentativeVersion ||
            row.source_fingerprint !== prepared.row.source_fingerprint
          ) {
            throw new CustomsDeclarationConflictException(
              'Customs declaration changed while PDFs were being rendered',
              'CUSTOMS_SOURCE_CHANGED',
            );
          }
          const version = prepared.tentativeVersion;
          await this.quota.consumeInTransaction(
            client,
            actor.tenantId,
            'storage',
            preEntryPdf.length + authorizationPdf.length,
          );
          await this.storage.put(preEntryStorageKey, preEntryPdf, 'application/pdf');
          storedKeys.push(preEntryStorageKey);
          await this.storage.put(authorizationStorageKey, authorizationPdf, 'application/pdf');
          storedKeys.push(authorizationStorageKey);
          const insertFile = async (
            originalName: string,
            storageKey: string,
            pdf: Buffer,
            purpose: string,
          ) => {
            const result = await client.query<{ id: string }>(
              `INSERT INTO files
                 (tenant_id, uploaded_by, original_name, storage_key, mime_type,
                  size_bytes, sha256, purpose)
               VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7)
               RETURNING id`,
              [
                actor.tenantId,
                actor.userId,
                originalName,
                storageKey,
                pdf.length,
                createHash('sha256').update(pdf).digest('hex'),
                purpose,
              ],
            );
            return result.rows[0].id;
          };
          const filePrefix = `${row.customs_data.declaration_number}-v${version}`;
          const preEntryFileId = await insertFile(
            `${filePrefix}-pre-entry.pdf`,
            preEntryStorageKey,
            preEntryPdf,
            'customs-pre-entry',
          );
          const authorizationFileId = await insertFile(
            `${filePrefix}-authorization.pdf`,
            authorizationStorageKey,
            authorizationPdf,
            'customs-authorization',
          );
          const inserted = await client.query<DeclarationVersionRow>(
            `INSERT INTO customs_declaration_versions
               (tenant_id, declaration_set_id, version, source_order_snapshot,
                source_ci_export_id, source_ci_snapshot, source_pl_export_id,
                source_pl_snapshot, customs_data, consistency_result, source_fingerprint,
                pre_entry_file_id, authorization_file_id, generated_by, generated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             RETURNING ${VERSION_COLUMNS}`,
            [
              actor.tenantId,
              row.id,
              version,
              JSON.stringify(row.source_order_snapshot),
              row.source_ci_export_id,
              JSON.stringify(row.source_ci_snapshot),
              row.source_pl_export_id,
              JSON.stringify(row.source_pl_snapshot),
              JSON.stringify(row.customs_data),
              JSON.stringify({ valid: true, missing: [], conflicts: [] }),
              row.source_fingerprint,
              preEntryFileId,
              authorizationFileId,
              actor.userId,
              pdfSnapshot.generated_at,
            ],
          );
          await client.query(
            `UPDATE customs_declaration_sets
                SET status='generated', latest_version=$1, updated_at=now()
              WHERE id=$2`,
            [version, row.id],
          );
          await client.query(
            `INSERT INTO customs_declaration_operations
               (tenant_id, sales_order_id, declaration_set_id, operation_type,
                idempotency_key, request_hash, result_json, created_by)
             VALUES ($1,$2,$3,'generate',$4,$5,$6,$7)`,
            [
              actor.tenantId,
              row.sales_order_id,
              row.id,
              dto.idempotency_key,
              requestHash,
              JSON.stringify({ declaration_set_id: row.id, version }),
              actor.userId,
            ],
          );
          for (const [fileId, documentType] of [
            [preEntryFileId, 'pre_entry'],
            [authorizationFileId, 'authorization'],
          ] as const) {
            await this.audit.logInTransaction(client, {
              tenantId: actor.tenantId,
              actorType: 'tenant_user',
              actorId: actor.userId,
              action: 'file.generated',
              resourceType: 'file',
              resourceId: fileId,
              after: { purpose: `customs-${documentType}`, declaration_set_id: row.id, version },
            });
          }
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'customs_declaration.generated',
            resourceType: 'customs_declaration_version',
            resourceId: inserted.rows[0].id,
            after: {
              declaration_set_id: row.id,
              version,
              source_fingerprint: row.source_fingerprint,
              pre_entry_file_id: preEntryFileId,
              authorization_file_id: authorizationFileId,
            },
          });
          return { version: this.versionResponse(inserted.rows[0]), idempotent: false };
        },
      );
    } catch (error) {
      await Promise.all(storedKeys.map((key) => this.storage.delete(key).catch(() => undefined)));
      throw error;
    }
  }

  async exportVersion(
    actor: CustomsDeclarationActor,
    declarationSetId: string,
    version: number,
    dto: CustomsIdempotencyDto,
  ) {
    const requestHash = this.requestHash('export', declarationSetId, { version });
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const row = await this.setRow(client, actor, declarationSetId, true);
        const prior = await this.operation(client, dto.idempotency_key, 'export', requestHash);
        if (prior?.result_json.version) {
          return {
            version: this.versionResponse(
              await this.versionRow(client, declarationSetId, prior.result_json.version),
            ),
            idempotent: true,
          };
        }
        const archived = await this.versionRow(client, declarationSetId, version);
        await client.query(
          `INSERT INTO customs_declaration_operations
             (tenant_id, sales_order_id, declaration_set_id, operation_type,
              idempotency_key, request_hash, result_json, created_by)
           VALUES ($1,$2,$3,'export',$4,$5,$6,$7)`,
          [
            actor.tenantId,
            row.sales_order_id,
            row.id,
            dto.idempotency_key,
            requestHash,
            JSON.stringify({ declaration_set_id: row.id, version }),
            actor.userId,
          ],
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'customs_declaration.exported',
          resourceType: 'customs_declaration_version',
          resourceId: archived.id,
          after: {
            declaration_set_id: row.id,
            version,
            pre_entry_file_id: archived.pre_entry_file_id,
            authorization_file_id: archived.authorization_file_id,
          },
        });
        return { version: this.versionResponse(archived), idempotent: false };
      },
    );
  }
}
