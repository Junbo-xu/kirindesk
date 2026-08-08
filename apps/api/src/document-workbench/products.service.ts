import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { APP_POOL } from '../database/database.module';
import { withTenantContext } from '../database/context';
import { RbacService } from '../rbac/rbac.service';
import {
  DocumentWorkbenchConflictException,
  DocumentWorkbenchNotFoundException,
  InvalidDocumentWorkbenchDataException,
} from './document-workbench.errors';
import {
  CreateProductDto,
  CreateProductFieldDto,
  ListProductsQuery,
  UpdateProductDto,
  UpdateProductFieldDto,
} from './dto/product.dto';

export interface DocumentWorkbenchActor {
  userId: string;
  tenantId: string;
  dataScope: string;
}

interface ProductRow {
  id: string;
  owner_user_id: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  hs_code: string | null;
  default_currency: string;
  default_unit_price: string;
  cost_unit_price: string | null;
  weight_kg: string | null;
  volume_cbm: string | null;
  thumbnail_file_id: string | null;
  custom_values: Record<string, unknown>;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ProductFieldRow {
  id: string;
  field_key: string;
  label: string;
  data_type: 'text' | 'number' | 'boolean' | 'date';
  active: boolean;
  sort_order: number;
  document_types: string[];
  created_at: Date;
  updated_at: Date;
}

const PRODUCT_COLUMNS = `id, owner_user_id, sku, name, description, unit, hs_code,
  default_currency, default_unit_price::text, cost_unit_price::text,
  weight_kg::text, volume_cbm::text, thumbnail_file_id, custom_values,
  active, created_at, updated_at`;

const SYSTEM_FIELDS = [
  ['sku', 'SKU', 'text'],
  ['name', 'Product name', 'text'],
  ['description', 'Description', 'text'],
  ['unit', 'Unit', 'text'],
  ['hs_code', 'HS code', 'text'],
  ['default_unit_price', 'Unit price', 'number'],
  ['weight_kg', 'Weight (kg)', 'number'],
  ['volume_cbm', 'Volume (CBM)', 'number'],
] as const;

@Injectable()
export class ProductsService {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
  ) {}

  private async canViewFinancials(actor: DocumentWorkbenchActor): Promise<boolean> {
    return (
      await this.rbac.checkPermission(actor.userId, actor.tenantId, 'document_financials:view')
    ).allowed;
  }

  private response(row: ProductRow, includeFinancials: boolean) {
    return {
      id: row.id,
      owner_user_id: row.owner_user_id,
      sku: row.sku,
      name: row.name,
      description: row.description,
      unit: row.unit,
      hs_code: row.hs_code,
      default_currency: row.default_currency,
      default_unit_price: row.default_unit_price,
      ...(includeFinancials ? { cost_unit_price: row.cost_unit_price } : {}),
      weight_kg: row.weight_kg,
      volume_cbm: row.volume_cbm,
      thumbnail_file_id: row.thumbnail_file_id,
      custom_values: row.custom_values,
      active: row.active,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private async validateCustomValues(
    client: PoolClient,
    customValues: Record<string, unknown>,
  ): Promise<void> {
    const fields = await client.query<Pick<ProductFieldRow, 'field_key' | 'data_type'>>(
      `SELECT field_key, data_type
         FROM product_custom_fields
        WHERE active = true`,
    );
    const definitions = new Map(fields.rows.map((field) => [field.field_key, field.data_type]));
    for (const [key, value] of Object.entries(customValues)) {
      const dataType = definitions.get(key);
      if (!dataType) {
        throw new InvalidDocumentWorkbenchDataException(`Unknown or inactive custom field: ${key}`);
      }
      const valid =
        value === null ||
        (dataType === 'text' && typeof value === 'string') ||
        (dataType === 'number' &&
          ((typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) ||
            (typeof value === 'number' && Number.isFinite(value)))) ||
        (dataType === 'boolean' && typeof value === 'boolean') ||
        (dataType === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
      if (!valid) {
        throw new InvalidDocumentWorkbenchDataException(`Invalid value for custom field: ${key}`);
      }
    }
  }

  private async row(client: PoolClient, id: string, lock = false): Promise<ProductRow> {
    const result = await client.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (result.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Product');
    return result.rows[0];
  }

  async create(actor: DocumentWorkbenchActor, dto: CreateProductDto) {
    if (dto.cost_unit_price !== undefined && !(await this.canViewFinancials(actor))) {
      throw new InvalidDocumentWorkbenchDataException('Cost price permission is required');
    }
    try {
      const row = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          await this.validateCustomValues(client, dto.custom_values ?? {});
          const result = await client.query<ProductRow>(
            `INSERT INTO products
               (tenant_id, owner_user_id, sku, name, description, unit, hs_code,
                default_currency, default_unit_price, cost_unit_price, weight_kg,
                volume_cbm, thumbnail_file_id, custom_values)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING ${PRODUCT_COLUMNS}`,
            [
              actor.tenantId,
              actor.userId,
              dto.sku,
              dto.name,
              dto.description?.trim() || null,
              dto.unit,
              dto.hs_code || null,
              dto.default_currency,
              dto.default_unit_price,
              dto.cost_unit_price ?? null,
              dto.weight_kg ?? null,
              dto.volume_cbm ?? null,
              dto.thumbnail_file_id ?? null,
              JSON.stringify(dto.custom_values ?? {}),
            ],
          );
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'product.created',
            resourceType: 'product',
            resourceId: result.rows[0].id,
            after: result.rows[0],
          });
          return result.rows[0];
        },
      );
      return this.response(row, await this.canViewFinancials(actor));
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'uq_products_tenant_sku') {
        throw new DocumentWorkbenchConflictException('Product SKU already exists', 'DUPLICATE_SKU');
      }
      throw error;
    }
  }

  async list(actor: DocumentWorkbenchActor, query: ListProductsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (query.active !== undefined) {
      params.push(query.active);
      conditions.push(`active = $${params.length}`);
    }
    if (query.q?.trim()) {
      params.push(`%${query.q.trim()}%`);
      conditions.push(`(sku ILIKE $${params.length} OR name ILIKE $${params.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const includeFinancials = await this.canViewFinancials(actor);
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const total = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM products ${where}`,
          params,
        );
        const rows = await client.query<ProductRow>(
          `SELECT ${PRODUCT_COLUMNS}
             FROM products ${where}
            ORDER BY active DESC, updated_at DESC, id
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, pageSize, (page - 1) * pageSize],
        );
        return {
          data: rows.rows.map((row) => this.response(row, includeFinancials)),
          page,
          pageSize,
          total: Number(total.rows[0].count),
        };
      },
    );
  }

  async get(actor: DocumentWorkbenchActor, id: string) {
    const row = await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      (client) => this.row(client, id),
    );
    return this.response(row, await this.canViewFinancials(actor));
  }

  async update(actor: DocumentWorkbenchActor, id: string, dto: UpdateProductDto) {
    if (dto.cost_unit_price !== undefined && !(await this.canViewFinancials(actor))) {
      throw new InvalidDocumentWorkbenchDataException('Cost price permission is required');
    }
    try {
      const row = await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const before = await this.row(client, id, true);
          if (dto.custom_values !== undefined) {
            await this.validateCustomValues(client, dto.custom_values);
          }
          const columns = [
            'sku',
            'name',
            'description',
            'unit',
            'hs_code',
            'default_currency',
            'default_unit_price',
            'cost_unit_price',
            'weight_kg',
            'volume_cbm',
            'thumbnail_file_id',
            'active',
          ] as const;
          const values: unknown[] = [];
          const sets: string[] = [];
          for (const column of columns) {
            if (dto[column] === undefined) continue;
            values.push(dto[column] === '' ? null : dto[column]);
            sets.push(`${column} = $${values.length}`);
          }
          if (dto.custom_values !== undefined) {
            values.push(JSON.stringify(dto.custom_values));
            sets.push(`custom_values = $${values.length}`);
          }
          if (sets.length === 0) {
            throw new InvalidDocumentWorkbenchDataException(
              'At least one product field is required',
            );
          }
          values.push(id);
          const result = await client.query<ProductRow>(
            `UPDATE products SET ${sets.join(', ')}, updated_at = now()
              WHERE id = $${values.length}
              RETURNING ${PRODUCT_COLUMNS}`,
            values,
          );
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'product.updated',
            resourceType: 'product',
            resourceId: id,
            before,
            after: result.rows[0],
          });
          return result.rows[0];
        },
      );
      return this.response(row, await this.canViewFinancials(actor));
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'uq_products_tenant_sku') {
        throw new DocumentWorkbenchConflictException('Product SKU already exists', 'DUPLICATE_SKU');
      }
      throw error;
    }
  }

  async listFields(actor: DocumentWorkbenchActor) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const custom = await client.query<ProductFieldRow>(
          `SELECT id, field_key, label, data_type, active, sort_order,
                  document_types, created_at, updated_at
             FROM product_custom_fields
            ORDER BY sort_order, created_at, id`,
        );
        return {
          system: SYSTEM_FIELDS.map(([fieldKey, label, dataType], index) => ({
            field_key: fieldKey,
            label,
            data_type: dataType,
            sort_order: index,
            active: true,
            document_types: ['quote', 'pi', 'sc', 'ci', 'pl'],
            system: true,
            deletable: false,
          })),
          custom: custom.rows.map((field) => ({ ...field, system: false, deletable: true })),
        };
      },
    );
  }

  async createField(actor: DocumentWorkbenchActor, dto: CreateProductFieldDto) {
    try {
      return await withTenantContext(
        this.pool,
        { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
        async (client) => {
          const result = await client.query<ProductFieldRow>(
            `INSERT INTO product_custom_fields
               (tenant_id, field_key, label, data_type, active, sort_order, document_types, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING id, field_key, label, data_type, active, sort_order,
                       document_types, created_at, updated_at`,
            [
              actor.tenantId,
              dto.field_key,
              dto.label,
              dto.data_type,
              dto.active ?? true,
              dto.sort_order ?? 0,
              dto.document_types ?? ['quote', 'pi', 'sc', 'ci', 'pl'],
              actor.userId,
            ],
          );
          await this.audit.logInTransaction(client, {
            tenantId: actor.tenantId,
            actorType: 'tenant_user',
            actorId: actor.userId,
            action: 'product_field.created',
            resourceType: 'product_custom_field',
            resourceId: result.rows[0].id,
            after: result.rows[0],
          });
          return result.rows[0];
        },
      );
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'uq_product_custom_fields_key') {
        throw new DocumentWorkbenchConflictException(
          'Custom field key already exists',
          'DUPLICATE_PRODUCT_FIELD',
        );
      }
      throw error;
    }
  }

  async updateField(actor: DocumentWorkbenchActor, id: string, dto: UpdateProductFieldDto) {
    return withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const before = await client.query<ProductFieldRow>(
          `SELECT id, field_key, label, data_type, active, sort_order,
                  document_types, created_at, updated_at
             FROM product_custom_fields WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (before.rows.length === 0) throw new DocumentWorkbenchNotFoundException('Product field');
        const columns = ['label', 'data_type', 'active', 'sort_order', 'document_types'] as const;
        const values: unknown[] = [];
        const sets: string[] = [];
        for (const column of columns) {
          if (dto[column] === undefined) continue;
          values.push(dto[column]);
          sets.push(`${column} = $${values.length}`);
        }
        if (sets.length === 0) {
          throw new InvalidDocumentWorkbenchDataException('At least one custom field is required');
        }
        values.push(id);
        const result = await client.query<ProductFieldRow>(
          `UPDATE product_custom_fields SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $${values.length}
            RETURNING id, field_key, label, data_type, active, sort_order,
                      document_types, created_at, updated_at`,
          values,
        );
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'product_field.updated',
          resourceType: 'product_custom_field',
          resourceId: id,
          before: before.rows[0],
          after: result.rows[0],
        });
        return result.rows[0];
      },
    );
  }

  async deleteField(actor: DocumentWorkbenchActor, id: string): Promise<void> {
    await withTenantContext(
      this.pool,
      { tenantId: actor.tenantId, userId: actor.userId, actorType: 'tenant_user' },
      async (client) => {
        const deleted = await client.query<ProductFieldRow>(
          `DELETE FROM product_custom_fields WHERE id = $1
           RETURNING id, field_key, label, data_type, active, sort_order,
                     document_types, created_at, updated_at`,
          [id],
        );
        if (deleted.rows.length === 0)
          throw new DocumentWorkbenchNotFoundException('Product field');
        await this.audit.logInTransaction(client, {
          tenantId: actor.tenantId,
          actorType: 'tenant_user',
          actorId: actor.userId,
          action: 'product_field.deleted',
          resourceType: 'product_custom_field',
          resourceId: id,
          before: deleted.rows[0],
        });
      },
    );
  }
}
