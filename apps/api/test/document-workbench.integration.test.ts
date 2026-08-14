import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { closePool } from '@kirindesk/database';
import pg from 'pg';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import {
  DOCUMENT_PDF_RENDERER,
  DocumentPdfRenderer,
  PuppeteerDocumentPdfRenderer,
} from '../src/document-workbench/document-pdf.renderer';
import {
  DocumentRenderAssets,
  DocumentType,
  PublicDocumentSnapshot,
} from '../src/document-workbench/document.types';
import { STORAGE_PROVIDER } from '../src/storage/storage-provider.interface';
import { FakeStorageProvider } from './fake-storage';
import {
  TEST_PASSWORD,
  TEST_TENANT2_SLUG,
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_USER2_EMAIL,
  TEST_USER2_ID,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_USER4_ID,
  TEST_USER_EMAIL,
} from './fixtures';

const PDF = Buffer.from('%PDF-1.4\nKirinDesk integration document\n%%EOF');

class ContractPdfRenderer implements DocumentPdfRenderer {
  snapshots: PublicDocumentSnapshot[] = [];

  async render(
    snapshot: PublicDocumentSnapshot,
    _documentType: DocumentType,
    _assets: DocumentRenderAssets,
  ): Promise<Buffer> {
    this.snapshots.push(snapshot);
    return PDF;
  }
}

describe('foreign trade document workbench (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let storage: FakeStorageProvider;
  let renderer: ContractPdfRenderer;
  let adminToken: string;
  let salesToken: string;
  let viewerToken: string;
  let tenant2Token: string;
  let documentId: string;
  let exportId: string;
  let rawToken: string;
  let adminProductId: string;
  let adminImageId: string;
  let stageCOrderId: string;
  let stageCOrderItemId: string;
  let stageCProductId: string;
  let stageCDocumentSetId: string;
  let stageCDocumentVersion: number;

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function login(email: string, tenantSlug = TEST_TENANT_SLUG): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug });
    expect(response.status).toBe(200);
    return response.body.accessToken as string;
  }

  async function grantScopedViewer(): Promise<void> {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const roleId = '90900000-0000-4000-8000-000000000001';
      await client.query(
        `INSERT INTO roles (id, tenant_id, name, is_system)
         VALUES ($1, $2, 'Document viewer without financials', true)`,
        [roleId, TEST_TENANT_ID],
      );
      await client.query(`INSERT INTO user_roles (tenant_id, user_id, role_id) VALUES ($1,$2,$3)`, [
        TEST_TENANT_ID,
        TEST_USER4_ID,
        roleId,
      ]);
      await client.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
         SELECT $1, $2, permission.id, grant_spec.data_scope
           FROM (
             VALUES
               ('products:view', 'assigned'),
               ('products:manage', 'assigned'),
               ('document_sets:view', 'all'),
               ('document_sets:manage', 'all'),
               ('document_financials:view', 'assigned'),
               ('orders:view', 'all'),
               ('orders:approve', 'all'),
               ('procurement:approve', 'all'),
               ('audit_logs:view', 'all')
           ) AS grant_spec(code, data_scope)
           JOIN permissions permission ON permission.code = grant_spec.code`,
        [TEST_TENANT_ID, roleId],
      );
    } finally {
      await client.end();
    }
  }

  function documentPayload(unitPrice = '12.3400') {
    return {
      quote_number: 'QT-INTEGRATION-001',
      pricing_mode: 'cost_profit',
      language: 'en',
      incoterm: 'CIF',
      pricing_currency: 'USD',
      settlement_currency: 'EUR',
      exchange_rate: '0.9200000000',
      discount_type: 'percent',
      discount_value: '5.0000',
      freight_amount: '10.00',
      insurance_amount: '2.00',
      tax_amount: '0.00',
      internal_expenses: '3.00',
      allocation_method: 'weight',
      packing_mode: 'combined',
      theme_color: '#155EEF',
      visible_fields: { thumbnail: true, terms: true },
      terms: '30% deposit, balance before shipment',
      bank_info: 'Public bank account',
      lines: [
        {
          sku: 'BOTTLE-750',
          name: 'Steel bottle',
          quantity: '100.000',
          unit: 'pcs',
          unit_price: unitPrice,
          cost_unit_price: '7.8900',
          weight_kg: '0.4200',
          volume_cbm: '0.001500',
          package_no: 'PALLET-A',
          custom_values: { customer_code: 'CUSTOM-001' },
        },
      ],
    };
  }

  function publicDocumentPayload(quoteNumber: string) {
    return {
      quote_number: quoteNumber,
      pricing_mode: 'final_price',
      language: 'en',
      incoterm: 'FOB',
      pricing_currency: 'USD',
      settlement_currency: 'USD',
      exchange_rate: '1.0000000000',
      packing_mode: 'normal',
      lines: [
        {
          sku: 'PUBLIC-1',
          name: 'Public product',
          quantity: '1.000',
          unit: 'pcs',
          unit_price: '10.0000',
          weight_kg: '1.0000',
          volume_cbm: '0.100000',
          package_no: 'BOX-1',
        },
      ],
    };
  }

  function updatePayloadFromDocument(document: Record<string, any>) {
    return {
      customer_id: document.customer?.id,
      sales_order_id: document.sales_order_id ?? undefined,
      quote_number: document.quote_number,
      pricing_mode: document.pricing_mode ?? 'final_price',
      language: document.language,
      incoterm: document.incoterm,
      pricing_currency: document.pricing_currency,
      settlement_currency: document.settlement_currency,
      exchange_rate: document.exchange_rate,
      discount_type: document.discount_type,
      discount_value: document.discount_value,
      freight_amount: document.totals.freight_amount,
      insurance_amount: document.totals.insurance_amount,
      tax_amount: document.totals.tax_amount,
      internal_expenses: document.internal_expenses ?? '0',
      allocation_method: document.allocation_method,
      packing_mode: document.packing_mode,
      theme_color: document.theme_color,
      visible_fields: document.visible_fields,
      terms: document.terms ?? undefined,
      bank_info: document.bank_info ?? undefined,
      logo_file_id: document.logo_file_id ?? undefined,
      signature_file_id: document.signature_file_id ?? undefined,
      lines: document.lines.map((line: Record<string, any>) => ({
        id: line.id,
        product_id: line.product_id ?? undefined,
        sku: line.sku,
        name: line.name,
        description: line.description ?? undefined,
        quantity: line.quantity,
        unit: line.unit,
        unit_price: line.unit_price,
        cost_unit_price: line.cost_unit_price ?? undefined,
        weight_kg: line.weight_kg ?? undefined,
        volume_cbm: line.volume_cbm ?? undefined,
        package_no: line.package_no ?? undefined,
        thumbnail_file_id: line.thumbnail_file_id ?? undefined,
        custom_values: Object.fromEntries(
          line.custom_fields.map((field: Record<string, any>) => [field.field_key, field.value]),
        ),
      })),
      expected_version: document.source_version,
    };
  }

  beforeAll(async () => {
    storage = new FakeStorageProvider();
    renderer = new ContractPdfRenderer();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STORAGE_PROVIDER)
      .useValue(storage)
      .overrideProvider(DOCUMENT_PDF_RENDERER)
      .useValue(renderer)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);
    await grantScopedViewer();
    adminToken = await login(TEST_USER_EMAIL);
    salesToken = await login(TEST_USER2_EMAIL);
    viewerToken = await login(TEST_USER4_EMAIL);
    tenant2Token = await login(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  it('persists tenant product fields, ordering, document visibility, and values', async () => {
    const createdField = await request(app.getHttpServer())
      .post('/api/product-fields')
      .set(bearer(adminToken))
      .send({
        field_key: 'customer_code',
        label: 'Customer code',
        data_type: 'text',
        sort_order: 8,
        document_types: ['quote', 'pl'],
      });
    expect(createdField.status).toBe(201);

    const updatedField = await request(app.getHttpServer())
      .patch(`/api/product-fields/${createdField.body.id}`)
      .set(bearer(adminToken))
      .send({ sort_order: 2, document_types: ['ci', 'pl'] });
    expect(updatedField.status).toBe(200);
    expect(updatedField.body.sort_order).toBe(2);
    expect(updatedField.body.document_types).toEqual(['ci', 'pl']);

    const product = await request(app.getHttpServer())
      .post('/api/products')
      .set(bearer(adminToken))
      .send({
        sku: 'BOTTLE-750',
        name: 'Steel bottle',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '12.3400',
        cost_unit_price: '6.5000',
        custom_values: { customer_code: 'CUSTOM-001' },
      });
    expect(product.status).toBe(201);
    adminProductId = product.body.id;
    expect(product.body.cost_unit_price).toBe('6.5000');
    expect(product.body.custom_values).toEqual({ customer_code: 'CUSTOM-001' });
  });

  it('enforces own and assigned product scopes for list, get, and update', async () => {
    const salesDenied = await request(app.getHttpServer())
      .get(`/api/products/${adminProductId}`)
      .set(bearer(salesToken));
    expect(salesDenied.status).toBe(404);

    const salesProduct = await request(app.getHttpServer())
      .post('/api/products')
      .set(bearer(salesToken))
      .send({
        sku: 'SALES-OWN',
        name: 'Sales product',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '8.0000',
      });
    expect(salesProduct.status).toBe(201);
    const salesList = await request(app.getHttpServer())
      .get('/api/products?pageSize=100')
      .set(bearer(salesToken));
    expect(salesList.status).toBe(200);
    expect(salesList.body.data.map((product: { id: string }) => product.id)).toContain(
      salesProduct.body.id,
    );
    expect(salesList.body.data.map((product: { id: string }) => product.id)).not.toContain(
      adminProductId,
    );
    const salesUpdated = await request(app.getHttpServer())
      .patch(`/api/products/${salesProduct.body.id}`)
      .set(bearer(salesToken))
      .send({ name: 'Sales product updated' });
    expect(salesUpdated.status).toBe(200);

    const assignedDenied = await request(app.getHttpServer())
      .get(`/api/products/${adminProductId}`)
      .set(bearer(viewerToken));
    expect(assignedDenied.status).toBe(404);
    const assignedProduct = await request(app.getHttpServer())
      .post('/api/products')
      .set(bearer(viewerToken))
      .send({
        sku: 'ASSIGNED-OWN',
        name: 'Assigned product',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '9.0000',
        cost_unit_price: '4.0000',
      });
    expect(assignedProduct.status).toBe(201);
    expect(assignedProduct.body.cost_unit_price).toBe('4.0000');
    const assignedList = await request(app.getHttpServer())
      .get('/api/products?pageSize=100')
      .set(bearer(viewerToken));
    expect(assignedList.status).toBe(200);
    expect(assignedList.body.data.map((product: { id: string }) => product.id)).toContain(
      assignedProduct.body.id,
    );
    expect(assignedList.body.data.map((product: { id: string }) => product.id)).not.toContain(
      adminProductId,
    );
    const assignedUpdated = await request(app.getHttpServer())
      .patch(`/api/products/${assignedProduct.body.id}`)
      .set(bearer(viewerToken))
      .send({ cost_unit_price: '4.5000' });
    expect(assignedUpdated.status).toBe(200);
    expect(assignedUpdated.body.cost_unit_price).toBe('4.5000');
    const assignedCannotUpdateAdmin = await request(app.getHttpServer())
      .patch(`/api/products/${adminProductId}`)
      .set(bearer(viewerToken))
      .send({ name: 'Forbidden update' });
    expect(assignedCannotUpdateAdmin.status).toBe(404);
  });

  it('creates a customer-optional cost-profit draft with exact totals', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(adminToken))
      .send(documentPayload());
    expect(response.status).toBe(201);
    documentId = response.body.document_set_id;
    expect(response.body.customer).toBeNull();
    expect(response.body.totals.subtotal).toBe('1234.00');
    expect(response.body.internal_totals.cost_total).toBe('789.00');
    expect(response.body.lines[0].cost_unit_price).toBe('7.8900');
    expect(response.body.packages).toEqual([
      {
        package_no: 'PALLET-A',
        line_nos: [1],
        total_weight_kg: '42.0000',
        total_volume_cbm: '0.150000',
      },
    ]);
    expect(response.body.lines[0].custom_fields).toEqual([
      {
        field_key: 'customer_code',
        label: 'Customer code',
        value: 'CUSTOM-001',
        document_types: ['ci', 'pl'],
      },
    ]);
  });

  it('redacts costs when the financial scope excludes the document owner', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/document-sets/${documentId}`)
      .set(bearer(viewerToken));
    expect(response.status).toBe(200);
    expect(response.body.pricing_mode).toBeUndefined();
    expect(response.body.internal_totals).toBeUndefined();
    expect(response.body.lines[0].cost_unit_price).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('7.8900');
  });

  it('preserves hidden financial values when manage=all updates another owner document', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(adminToken))
      .send({ ...documentPayload(), quote_number: 'QT-FINANCIAL-SCOPE' });
    expect(created.status).toBe(201);

    const visible = await request(app.getHttpServer())
      .get(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(viewerToken));
    expect(visible.status).toBe(200);
    expect(visible.body.internal_expenses).toBeUndefined();
    expect(visible.body.lines[0].cost_unit_price).toBeUndefined();

    const updated = await request(app.getHttpServer())
      .patch(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(viewerToken))
      .send({ ...updatePayloadFromDocument(visible.body), terms: 'Public terms updated' });
    expect(updated.status).toBe(200);
    expect(updated.body.terms).toBe('Public terms updated');
    expect(updated.body.internal_expenses).toBeUndefined();

    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      const stored = await admin.query<{
        pricing_mode: string;
        internal_expenses: string;
        cost_unit_price: string | null;
      }>(
        `SELECT document.pricing_mode, document.internal_expenses::text,
                line.cost_unit_price::text
           FROM trade_document_sets document
           JOIN trade_document_lines line ON line.document_set_id = document.id
          WHERE document.id = $1`,
        [created.body.document_set_id],
      );
      expect(stored.rows[0]).toEqual({
        pricing_mode: 'cost_profit',
        internal_expenses: '3.00',
        cost_unit_price: '7.8900',
      });
    } finally {
      await admin.end();
    }

    const rejected = await request(app.getHttpServer())
      .patch(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(viewerToken))
      .send({
        ...updatePayloadFromDocument({ ...visible.body, source_version: 2 }),
        pricing_mode: 'cost_profit',
        internal_expenses: '9.00',
      });
    expect(rejected.status).toBe(400);

    const missingLineIdentity = await request(app.getHttpServer())
      .patch(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(viewerToken))
      .send({
        ...updatePayloadFromDocument({ ...visible.body, source_version: 2 }),
        lines: updatePayloadFromDocument({ ...visible.body, source_version: 2 }).lines.map(
          ({ id: _id, ...line }: { id?: string; [key: string]: unknown }) => line,
        ),
      });
    expect(missingLineIdentity.status).toBe(400);
  });

  it('intersects document scope with assigned financial scope per owner', async () => {
    const salesDenied = await request(app.getHttpServer())
      .get(`/api/document-sets/${documentId}`)
      .set(bearer(salesToken));
    expect(salesDenied.status).toBe(404);

    const ownDocument = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(viewerToken))
      .send({ ...documentPayload(), quote_number: 'QT-ASSIGNED-OWN' });
    expect(ownDocument.status).toBe(201);
    expect(ownDocument.body.internal_totals.cost_total).toBe('789.00');
    expect(ownDocument.body.lines[0].cost_unit_price).toBe('7.8900');

    const ownUpdated = await request(app.getHttpServer())
      .patch(`/api/document-sets/${ownDocument.body.document_set_id}`)
      .set(bearer(viewerToken))
      .send({
        ...updatePayloadFromDocument(ownDocument.body),
        lines: [
          {
            ...updatePayloadFromDocument(ownDocument.body).lines[0],
            cost_unit_price: '8.0000',
          },
        ],
      });
    expect(ownUpdated.status).toBe(200);
    expect(ownUpdated.body.lines[0].cost_unit_price).toBe('8.0000');

    const list = await request(app.getHttpServer())
      .get('/api/document-sets?pageSize=100')
      .set(bearer(viewerToken));
    expect(list.status).toBe(200);
    const other = list.body.data.find(
      (document: { document_set_id: string }) => document.document_set_id === documentId,
    );
    const own = list.body.data.find(
      (document: { document_set_id: string }) =>
        document.document_set_id === ownDocument.body.document_set_id,
    );
    expect(other.internal_totals).toBeUndefined();
    expect(own.internal_totals.cost_total).toBe('800.00');

    const deniedFinancialUpdate = await request(app.getHttpServer())
      .patch(`/api/document-sets/${documentId}`)
      .set(bearer(viewerToken))
      .send({ ...documentPayload(), quote_number: 'QT-FORBIDDEN', expected_version: 1 });
    expect(deniedFinancialUpdate.status).toBe(400);
  });

  it('enforces cross-tenant RLS on document ids', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/document-sets/${documentId}`)
      .set(bearer(tenant2Token));
    expect(response.status).toBe(404);
  });

  it('rejects quote conversion when the customer is outside the order create scope', async () => {
    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Out-of-scope conversion customer' });
    expect(customer.status).toBe(201);
    const created = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(adminToken))
      .send({
        ...publicDocumentPayload('QT-CUSTOMER-SCOPE'),
        customer_id: customer.body.id,
      });
    expect(created.status).toBe(201);

    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`UPDATE trade_document_sets SET owner_user_id=$1 WHERE id=$2`, [
        TEST_USER2_ID,
        created.body.document_set_id,
      ]);
    } finally {
      await admin.end();
    }

    const visibleQuote = await request(app.getHttpServer())
      .get(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(salesToken));
    expect(visibleQuote.status).toBe(200);

    const denied = await request(app.getHttpServer())
      .post(`/api/document-sets/${created.body.document_set_id}/sales-order`)
      .set(bearer(salesToken))
      .send({
        order_number: 'SO-CUSTOMER-SCOPE-DENIED',
        idempotency_key: `quote-to-order:${created.body.document_set_id}`,
        expected_version: created.body.source_version,
      });
    expect(denied.status).toBe(404);
    expect(denied.body.message).toBe('Customer not found');

    const verification = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await verification.connect();
    try {
      const stored = await verification.query<{
        sales_order_id: string | null;
        orders: string;
        conversion_audits: string;
      }>(
        `SELECT document.sales_order_id,
                (SELECT COUNT(*)::text FROM sales_orders order_record
                  WHERE order_record.source_document_set_id=document.id) AS orders,
                (SELECT COUNT(*)::text FROM audit_logs audit
                  WHERE (audit.action='trade_document.converted_to_sales_order'
                          AND audit.resource_id=document.id::text)
                     OR (audit.action='sales_order.created_from_quote'
                          AND audit.metadata_json->>'source_document_set_id'=document.id::text)
                ) AS conversion_audits
           FROM trade_document_sets document
          WHERE document.id=$1`,
        [created.body.document_set_id],
      );
      expect(stored.rows[0]).toEqual({
        sales_order_id: null,
        orders: '0',
        conversion_audits: '0',
      });
    } finally {
      await verification.end();
    }
  });

  it('idempotently creates a sales order from the exact quote version without customer confirmation', async () => {
    const missingCustomer = await request(app.getHttpServer())
      .post(`/api/document-sets/${documentId}/sales-order`)
      .set(bearer(adminToken))
      .send({
        order_number: 'SO-MISSING-CUSTOMER',
        idempotency_key: `quote-to-order:${documentId}`,
        expected_version: 1,
      });
    expect(missingCustomer.status).toBe(400);
    expect(missingCustomer.body.code).toBe('QUOTE_CUSTOMER_REQUIRED');

    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Quote conversion customer', country: 'DE' });
    expect(customer.status).toBe(201);
    const created = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(adminToken))
      .send({
        ...documentPayload(),
        customer_id: customer.body.id,
        quote_number: 'QT-CONVERT-001',
        lines: [{ ...documentPayload().lines[0], product_id: adminProductId }],
      });
    expect(created.status).toBe(201);
    const nonFinancialProjection = await request(app.getHttpServer())
      .get(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(viewerToken));
    expect(nonFinancialProjection.status).toBe(200);
    expect(nonFinancialProjection.body.lines[0].product_id).toBe(adminProductId);
    expect(nonFinancialProjection.body.lines[0].cost_unit_price).toBeUndefined();

    const conversionInput = {
      order_number: 'SO-CONVERT-001',
      idempotency_key: `quote-to-order:${created.body.document_set_id}`,
      expected_version: created.body.source_version,
    };
    const stale = await request(app.getHttpServer())
      .post(`/api/document-sets/${created.body.document_set_id}/sales-order`)
      .set(bearer(adminToken))
      .send({ ...conversionInput, expected_version: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('DOCUMENT_VERSION_CONFLICT');

    const crossTenant = await request(app.getHttpServer())
      .post(`/api/document-sets/${created.body.document_set_id}/sales-order`)
      .set(bearer(tenant2Token))
      .send(conversionInput);
    expect(crossTenant.status).toBe(404);
    const outOfOwnerScope = await request(app.getHttpServer())
      .post(`/api/document-sets/${created.body.document_set_id}/sales-order`)
      .set(bearer(salesToken))
      .send(conversionInput);
    expect(outOfOwnerScope.status).toBe(404);

    const converted = await request(app.getHttpServer())
      .post(`/api/document-sets/${created.body.document_set_id}/sales-order`)
      .set(bearer(adminToken))
      .send(conversionInput);
    expect(converted.status).toBe(200);
    expect(converted.body.idempotent).toBe(false);
    expect(converted.body.source_quote).toEqual({
      document_set_id: created.body.document_set_id,
      quote_number: 'QT-CONVERT-001',
      version: 1,
    });
    expect(converted.body.sales_order.total_amount).toBe('1184.30');
    expect(converted.body.sales_order.source_document_set_id).toBe(created.body.document_set_id);
    expect(converted.body.sales_order.source_quote_version).toBe(1);
    expect(converted.body.sales_order.items[0]).toMatchObject({
      product_id: adminProductId,
      source_document_line_id: created.body.lines[0].id,
      quantity: '100.000',
      unit_price: '12.3400',
      line_total: '1234.00',
    });
    const safeResponse = JSON.stringify(converted.body);
    expect(safeResponse).not.toContain('source_quote_snapshot');
    expect(safeResponse).not.toContain('cost_unit_price');
    expect(safeResponse).not.toContain('internal_expenses');
    expect(safeResponse).not.toContain('7.8900');

    const retried = await request(app.getHttpServer())
      .post(`/api/document-sets/${created.body.document_set_id}/sales-order`)
      .set(bearer(adminToken))
      .send(conversionInput);
    expect(retried.status).toBe(200);
    expect(retried.body.idempotent).toBe(true);
    expect(retried.body.sales_order.id).toBe(converted.body.sales_order.id);

    const linkedDocument = await request(app.getHttpServer())
      .get(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(adminToken));
    expect(linkedDocument.status).toBe(200);
    expect(linkedDocument.body.sales_order_id).toBe(converted.body.sales_order.id);
    const linkedOrder = await request(app.getHttpServer())
      .get(`/api/sales-orders/${converted.body.sales_order.id}`)
      .set(bearer(adminToken));
    expect(linkedOrder.status).toBe(200);
    expect(linkedOrder.body.source_document_set_id).toBe(created.body.document_set_id);
    expect(JSON.stringify(linkedOrder.body)).not.toContain('source_quote_snapshot');
    const deleteLinkedOrder = await request(app.getHttpServer())
      .delete(`/api/sales-orders/${converted.body.sales_order.id}`)
      .set(bearer(adminToken));
    expect(deleteLinkedOrder.status).toBe(409);

    const revisedQuote = await request(app.getHttpServer())
      .patch(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(adminToken))
      .send({
        ...updatePayloadFromDocument(linkedDocument.body),
        lines: [
          {
            ...updatePayloadFromDocument(linkedDocument.body).lines[0],
            unit_price: '99.9999',
          },
        ],
      });
    expect(revisedQuote.status).toBe(200);
    expect(revisedQuote.body.source_version).toBe(2);
    expect(revisedQuote.body.sales_order_id).toBe(converted.body.sales_order.id);

    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      const stored = await admin.query<{
        source_quote_version: number;
        source_price: string;
        source_cost: string;
        item_source_price: string;
        orders: string;
        create_audits: string;
        audit_payload: string;
      }>(
        `SELECT order_record.source_quote_version,
                order_record.source_quote_snapshot #>> '{lines,0,unit_price}' AS source_price,
                order_record.source_quote_snapshot #>> '{lines,0,cost_unit_price}' AS source_cost,
                item.source_line_snapshot #>> '{unit_price}' AS item_source_price,
                (SELECT COUNT(*)::text FROM sales_orders candidate
                  WHERE candidate.source_document_set_id=$1) AS orders,
                (SELECT COUNT(*)::text FROM audit_logs audit
                  WHERE audit.action='sales_order.created_from_quote'
                    AND audit.resource_id=order_record.id::text) AS create_audits,
                (SELECT COALESCE(string_agg(audit.after_json::text, ''), '') FROM audit_logs audit
                  WHERE audit.resource_id IN ($1::text, order_record.id::text)) AS audit_payload
           FROM sales_orders order_record
           JOIN sales_order_items item ON item.order_id=order_record.id AND item.deleted_at IS NULL
          WHERE order_record.id=$2`,
        [created.body.document_set_id, converted.body.sales_order.id],
      );
      expect(stored.rows[0]).toMatchObject({
        source_quote_version: 1,
        source_price: '12.3400',
        source_cost: '7.8900',
        item_source_price: '12.3400',
        orders: '1',
        create_audits: '1',
      });
      expect(stored.rows[0].audit_payload).not.toContain('cost_unit_price');
      expect(stored.rows[0].audit_payload).not.toContain('internal_expenses');
      await expect(
        admin.query(`UPDATE sales_orders SET source_quote_version=99 WHERE id=$1`, [
          converted.body.sales_order.id,
        ]),
      ).rejects.toThrow('sales order quote source snapshot is immutable');
    } finally {
      await admin.end();
    }
  });

  it('links a locked quote without changing its immutable locked snapshot', async () => {
    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Locked quote customer' });
    const created = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(adminToken))
      .send({
        ...publicDocumentPayload('QT-LOCKED-CONVERT'),
        customer_id: customer.body.id,
      });
    const locked = await request(app.getHttpServer())
      .post(`/api/document-sets/${created.body.document_set_id}/lock`)
      .set(bearer(adminToken));
    expect(locked.status).toBe(201);
    const converted = await request(app.getHttpServer())
      .post(`/api/document-sets/${created.body.document_set_id}/sales-order`)
      .set(bearer(adminToken))
      .send({
        order_number: 'SO-LOCKED-CONVERT',
        idempotency_key: `quote-to-order:${created.body.document_set_id}`,
        expected_version: 1,
      });
    expect(converted.status).toBe(200);
    expect(converted.body.sales_order.total_amount).toBe('10.00');

    const linked = await request(app.getHttpServer())
      .get(`/api/document-sets/${created.body.document_set_id}`)
      .set(bearer(adminToken));
    expect(linked.body.status).toBe('locked');
    expect(linked.body.sales_order_id).toBe(converted.body.sales_order.id);
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      const stored = await admin.query<{
        locked_sales_order_id: string | null;
        source_status: string;
      }>(
        `SELECT document.locked_snapshot #>> '{sales_order_id}' AS locked_sales_order_id,
                order_record.source_quote_snapshot #>> '{status}' AS source_status
           FROM trade_document_sets document
           JOIN sales_orders order_record ON order_record.id=document.sales_order_id
          WHERE document.id=$1`,
        [created.body.document_set_id],
      );
      expect(stored.rows[0]).toEqual({ locked_sales_order_id: null, source_status: 'locked' });
    } finally {
      await admin.end();
    }
  });

  it('rolls back quote conversion when the audit chain cannot be appended', async () => {
    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Conversion rollback customer' });
    const created = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(adminToken))
      .send({
        ...publicDocumentPayload('QT-CONVERT-ROLLBACK'),
        customer_id: customer.body.id,
      });
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`
        CREATE FUNCTION fail_quote_conversion_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'sales_order.created_from_quote' THEN
            RAISE EXCEPTION 'forced quote conversion audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_quote_conversion_audit
          BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION fail_quote_conversion_audit();
      `);
      const failed = await request(app.getHttpServer())
        .post(`/api/document-sets/${created.body.document_set_id}/sales-order`)
        .set(bearer(adminToken))
        .send({
          order_number: 'SO-CONVERT-ROLLBACK',
          idempotency_key: `quote-to-order:${created.body.document_set_id}`,
          expected_version: 1,
        });
      expect(failed.status).toBe(500);
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS fail_quote_conversion_audit ON audit_logs`);
      await admin.query(`DROP FUNCTION IF EXISTS fail_quote_conversion_audit()`);
    }
    try {
      const rolledBack = await admin.query<{ sales_order_id: string | null; orders: string }>(
        `SELECT document.sales_order_id,
                (SELECT COUNT(*)::text FROM sales_orders WHERE order_number='SO-CONVERT-ROLLBACK') AS orders
           FROM trade_document_sets document
          WHERE document.id=$1`,
        [created.body.document_set_id],
      );
      expect(rolledBack.rows[0]).toEqual({ sales_order_id: null, orders: '0' });
    } finally {
      await admin.end();
    }
  });

  it('generates and refreshes versioned order documents, then locks the order snapshot', async () => {
    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Stage B document customer', country: 'DE' });
    const product = await request(app.getHttpServer())
      .post('/api/products')
      .set(bearer(adminToken))
      .send({
        sku: 'STAGE-B-DOC',
        name: 'Stage B document product',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '25.0000',
        cost_unit_price: '11.0000',
        weight_kg: '2.5000',
        volume_cbm: '0.020000',
      });
    expect(product.status).toBe(201);
    const order = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: customer.body.id,
        order_number: 'SO-STAGE-B-DOC',
        currency: 'USD',
        items: [
          {
            product_id: product.body.id,
            description: 'Stage B document product',
            product_code: 'STAGE-B-DOC',
            unit: 'pcs',
            quantity: '2.000',
            unit_price: '25.0000',
          },
        ],
      });
    expect(order.status).toBe(201);

    const firstSync = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/document-set`)
      .set(bearer(adminToken))
      .send({
        idempotency_key: `order-documents:${order.body.id}:v1`,
        expected_updated_at: order.body.updated_at,
      });
    expect(firstSync.status).toBe(200);
    expect(firstSync.body).toMatchObject({
      idempotent: false,
      refreshed: false,
      preserved_export_count: 0,
      document_types: ['pi', 'sc', 'ci', 'pl'],
    });
    expect(firstSync.body.document.sales_order_id).toBe(order.body.id);
    expect(firstSync.body.document.source_version).toBe(1);
    expect(firstSync.body.document.lines[0]).toMatchObject({
      product_id: product.body.id,
      unit_price: '25.0000',
      cost_unit_price: '11.0000',
    });
    const realPdf = await new PuppeteerDocumentPdfRenderer().render(
      firstSync.body.document as PublicDocumentSnapshot,
      'ci',
      { thumbnails: {} },
    );
    expect(realPdf.subarray(0, 5).equals(Buffer.from('%PDF-'))).toBe(true);
    expect(realPdf.length).toBeGreaterThan(1000);

    const exported = await request(app.getHttpServer())
      .post(`/api/document-sets/${firstSync.body.document.document_set_id}/exports/ci`)
      .set(bearer(adminToken));
    expect(exported.status).toBe(201);
    expect(exported.body.source_version).toBe(1);

    const updatedOrder = await request(app.getHttpServer())
      .patch(`/api/sales-orders/${order.body.id}`)
      .set(bearer(adminToken))
      .send({
        currency: 'USD',
        items: [
          {
            product_id: product.body.id,
            description: 'Stage B document product',
            product_code: 'STAGE-B-DOC',
            unit: 'pcs',
            quantity: '3.000',
            unit_price: '30.0000',
          },
        ],
      });
    expect(updatedOrder.status).toBe(200);
    const refreshed = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/document-set`)
      .set(bearer(adminToken))
      .send({
        idempotency_key: `order-documents:${order.body.id}:v2`,
        expected_updated_at: updatedOrder.body.updated_at,
      });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body).toMatchObject({
      idempotent: false,
      refreshed: true,
      preserved_export_count: 1,
      result_document_version: 2,
    });
    expect(refreshed.body.document.lines[0]).toMatchObject({
      quantity: '3.000',
      unit_price: '30.0000',
    });

    const retried = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/document-set`)
      .set(bearer(adminToken))
      .send({
        idempotency_key: `order-documents:${order.body.id}:v2`,
        expected_updated_at: updatedOrder.body.updated_at,
      });
    expect(retried.status).toBe(200);
    expect(retried.body.idempotent).toBe(true);
    expect(retried.body.result_document_version).toBe(2);

    const locked = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/fulfillment-lock`)
      .set(bearer(adminToken))
      .send({ expected_updated_at: updatedOrder.body.updated_at });
    expect(locked.status).toBe(200);
    expect(locked.body.idempotent).toBe(false);
    expect(locked.body.sales_order.fulfillment_locked_at).toBeTruthy();
    const repeatedLock = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/fulfillment-lock`)
      .set(bearer(adminToken))
      .send({ expected_updated_at: updatedOrder.body.updated_at });
    expect(repeatedLock.status).toBe(200);
    expect(repeatedLock.body.idempotent).toBe(true);

    const rejectedMutation = await request(app.getHttpServer())
      .patch(`/api/sales-orders/${order.body.id}`)
      .set(bearer(adminToken))
      .send({ notes: 'must not mutate locked order' });
    expect(rejectedMutation.status).toBe(409);
    expect(rejectedMutation.body.code).toBe('FULFILLMENT_LOCKED_ORDER_IMMUTABLE');

    const lockedSync = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/document-set`)
      .set(bearer(adminToken))
      .send({
        idempotency_key: `order-documents:${order.body.id}:locked`,
        expected_updated_at: locked.body.sales_order.updated_at,
      });
    expect(lockedSync.status).toBe(200);
    expect(lockedSync.body.source_order.locked).toBe(true);
    expect(lockedSync.body.document.source_version).toBe(3);
    stageCOrderId = order.body.id;
    stageCOrderItemId = updatedOrder.body.items[0].id;
    stageCProductId = product.body.id;
    stageCDocumentSetId = lockedSync.body.document.document_set_id;
    stageCDocumentVersion = lockedSync.body.document.source_version;

    const replayedFirstSync = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/document-set`)
      .set(bearer(adminToken))
      .send({
        idempotency_key: `order-documents:${order.body.id}:v1`,
        expected_updated_at: locked.body.sales_order.updated_at,
      });
    expect(replayedFirstSync.status).toBe(200);
    expect(replayedFirstSync.body).toMatchObject({
      idempotent: true,
      refreshed: false,
      preserved_export_count: 0,
      result_document_version: 1,
      source_order: {
        sales_order_id: order.body.id,
        updated_at: order.body.updated_at,
        locked: false,
      },
    });
    expect(replayedFirstSync.body.document).toEqual(firstSync.body.document);
    expect(replayedFirstSync.body.document.source_version).toBe(1);
    expect(replayedFirstSync.body.document.lines[0]).toMatchObject({
      product_id: product.body.id,
      quantity: '2.000',
      unit_price: '25.0000',
      cost_unit_price: '11.0000',
    });

    const redactedReplay = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/document-set`)
      .set(bearer(viewerToken))
      .send({
        idempotency_key: `order-documents:${order.body.id}:v1`,
        expected_updated_at: locked.body.sales_order.updated_at,
      });
    expect(redactedReplay.status).toBe(200);
    expect(redactedReplay.body.document.source_version).toBe(1);
    expect(redactedReplay.body.document.pricing_mode).toBeUndefined();
    expect(redactedReplay.body.document.internal_totals).toBeUndefined();
    expect(redactedReplay.body.document.lines[0].cost_unit_price).toBeUndefined();
    expect(JSON.stringify(redactedReplay.body)).not.toContain('11.0000');

    const otherOrder = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: customer.body.id,
        order_number: 'SO-STAGE-B-DOC-OTHER',
        currency: 'USD',
        items: [
          {
            product_id: product.body.id,
            description: 'Stage B document product',
            product_code: 'STAGE-B-DOC',
            unit: 'pcs',
            quantity: '1.000',
            unit_price: '25.0000',
          },
        ],
      });
    expect(otherOrder.status).toBe(201);
    const reusedAcrossOrders = await request(app.getHttpServer())
      .post(`/api/sales-orders/${otherOrder.body.id}/document-set`)
      .set(bearer(adminToken))
      .send({
        idempotency_key: `order-documents:${order.body.id}:v1`,
        expected_updated_at: otherOrder.body.updated_at,
      });
    expect(reusedAcrossOrders.status).toBe(409);
    expect(reusedAcrossOrders.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const archived = await request(app.getHttpServer())
      .get(`/api/document-sets/${firstSync.body.document.document_set_id}/exports`)
      .set(bearer(adminToken));
    expect(archived.status).toBe(200);
    expect(archived.body).toHaveLength(1);
    expect(archived.body[0].source_version).toBe(1);
    renderer.snapshots = [];
    storage.objects.clear();
  });

  it('blocks incomplete mappings, then idempotently splits purchase orders with approval', async () => {
    const supplierOne = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: 'Stage B supplier one' });
    const supplierTwo = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: 'Stage B supplier two' });
    expect(supplierOne.status).toBe(201);
    expect(supplierTwo.status).toBe(201);
    const incompleteProduct = await request(app.getHttpServer())
      .post('/api/products')
      .set(bearer(adminToken))
      .send({
        sku: 'STAGE-B-PO-1',
        name: 'Stage B procurement product one',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '9.0000',
        cost_unit_price: '4.0000',
      });
    const mappedProduct = await request(app.getHttpServer())
      .post('/api/products')
      .set(bearer(adminToken))
      .send({
        sku: 'STAGE-B-PO-2',
        name: 'Stage B procurement product two',
        unit: 'pcs',
        default_currency: 'USD',
        default_unit_price: '12.0000',
        cost_unit_price: '6.0000',
        supplier_id: supplierTwo.body.id,
        purchase_currency: 'USD',
        purchase_unit_price: '5.5000',
      });
    expect(incompleteProduct.status).toBe(201);
    expect(mappedProduct.status).toBe(201);

    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Stage B procurement customer' });
    const order = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: customer.body.id,
        order_number: 'SO-STAGE-B-PO',
        currency: 'USD',
        items: [
          {
            product_id: incompleteProduct.body.id,
            description: 'Product one',
            product_code: 'STAGE-B-PO-1',
            unit: 'pcs',
            quantity: '2.000',
            unit_price: '9.0000',
          },
          {
            product_id: mappedProduct.body.id,
            description: 'Product two',
            product_code: 'STAGE-B-PO-2',
            unit: 'pcs',
            quantity: '3.000',
            unit_price: '12.0000',
          },
        ],
      });
    const locked = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/fulfillment-lock`)
      .set(bearer(adminToken))
      .send({ expected_updated_at: order.body.updated_at });
    expect(locked.status).toBe(200);

    const generationKey = `order-purchase-orders:${order.body.id}`;
    const blocked = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/purchase-orders/generate`)
      .set(bearer(adminToken))
      .send({ idempotency_key: generationKey });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('PROCUREMENT_MAPPING_INCOMPLETE');
    expect(blocked.body.missing).toEqual([
      {
        sales_order_item_id: order.body.items[0].id,
        line_no: 1,
        product_id: incompleteProduct.body.id,
        product_code: 'STAGE-B-PO-1',
        missing_fields: ['supplier_id', 'purchase_currency', 'purchase_unit_price'],
      },
    ]);

    const mapped = await request(app.getHttpServer())
      .patch(`/api/products/${incompleteProduct.body.id}`)
      .set(bearer(adminToken))
      .send({
        supplier_id: supplierOne.body.id,
        purchase_currency: 'RMB',
        purchase_unit_price: '3.2500',
      });
    expect(mapped.status).toBe(200);
    const generated = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/purchase-orders/generate`)
      .set(bearer(adminToken))
      .send({ idempotency_key: generationKey });
    expect(generated.status).toBe(200);
    expect(generated.body.idempotent).toBe(false);
    expect(generated.body.purchase_orders).toHaveLength(2);
    expect(
      generated.body.purchase_orders
        .map(
          (purchaseOrder: { currency: string; total_amount: string }) =>
            `${purchaseOrder.currency}:${purchaseOrder.total_amount}`,
        )
        .sort(),
    ).toEqual(['RMB:6.50', 'USD:16.50']);

    const retried = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/purchase-orders/generate`)
      .set(bearer(adminToken))
      .send({ idempotency_key: generationKey });
    expect(retried.status).toBe(200);
    expect(retried.body.idempotent).toBe(true);
    expect(
      retried.body.purchase_orders.map((purchaseOrder: { id: string }) => purchaseOrder.id),
    ).toEqual(
      generated.body.purchase_orders.map((purchaseOrder: { id: string }) => purchaseOrder.id),
    );

    const crossTenant = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/purchase-orders/generate`)
      .set(bearer(tenant2Token))
      .send({ idempotency_key: `tenant-two:${order.body.id}` });
    expect(crossTenant.status).toBe(404);

    const firstPurchaseOrderId = generated.body.purchase_orders[0].id;
    const submitted = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${firstPurchaseOrderId}/submit`)
      .set(bearer(adminToken));
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('pending_approval');
    const approved = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${firstPurchaseOrderId}/approve`)
      .set(bearer(viewerToken))
      .send({ reason: 'Independent Stage B approval' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');

    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      const stored = await admin.query<{
        generations: string;
        purchase_orders: string;
        audit_payload: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM sales_order_purchase_generations
             WHERE sales_order_id=$1) AS generations,
           (SELECT COUNT(*)::text FROM purchase_orders
             WHERE source_sales_order_generation_id=generated.id) AS purchase_orders,
           (SELECT COALESCE(string_agg(COALESCE(audit.after_json::text, '') ||
                                       COALESCE(audit.metadata_json::text, ''), ''), '')
              FROM audit_logs audit
             WHERE audit.action IN ('purchase_order.generated_from_sales_order',
                                    'sales_order.purchase_orders_generated')
               AND (audit.resource_id=$1::text
                    OR audit.after_json->>'sales_order_id'=$1::text)) AS audit_payload
          FROM sales_order_purchase_generations generated
         WHERE generated.sales_order_id=$1`,
        [order.body.id],
      );
      expect(stored.rows[0].generations).toBe('1');
      expect(stored.rows[0].purchase_orders).toBe('2');
      expect(stored.rows[0].audit_payload).not.toContain('purchase_unit_price');
      expect(stored.rows[0].audit_payload).not.toContain('3.2500');
      expect(stored.rows[0].audit_payload).not.toContain('5.5000');
    } finally {
      await admin.end();
    }
  });

  it('drives an audited partial shipment from a locked packing-list version', async () => {
    const submittedOrder = await request(app.getHttpServer())
      .post(`/api/sales-orders/${stageCOrderId}/submit`)
      .set(bearer(adminToken));
    expect(submittedOrder.status, JSON.stringify(submittedOrder.body)).toBe(200);
    const approvedOrder = await request(app.getHttpServer())
      .post(`/api/sales-orders/${stageCOrderId}/approve`)
      .set(bearer(viewerToken))
      .send({ reason: 'Independent sales approval before packing' });
    expect(approvedOrder.status, JSON.stringify(approvedOrder.body)).toBe(200);
    expect(approvedOrder.body.status).toBe('approved');

    const supplier = await request(app.getHttpServer())
      .post('/api/suppliers')
      .set(bearer(adminToken))
      .send({ company_name: 'Stage C packing supplier' });
    expect(supplier.status).toBe(201);
    const mapped = await request(app.getHttpServer())
      .patch(`/api/products/${stageCProductId}`)
      .set(bearer(adminToken))
      .send({
        supplier_id: supplier.body.id,
        purchase_currency: 'USD',
        purchase_unit_price: '10.0000',
      });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);
    const generated = await request(app.getHttpServer())
      .post(`/api/sales-orders/${stageCOrderId}/purchase-orders/generate`)
      .set(bearer(adminToken))
      .send({ idempotency_key: `stage-c-purchase:${stageCOrderId}` });
    expect(generated.status, JSON.stringify(generated.body)).toBe(200);
    expect(generated.body.purchase_orders).toHaveLength(1);
    const purchaseOrderId = generated.body.purchase_orders[0].id;
    await request(app.getHttpServer())
      .post(`/api/purchase-orders/${purchaseOrderId}/submit`)
      .set(bearer(adminToken))
      .expect(200);
    const approvedPurchase = await request(app.getHttpServer())
      .post(`/api/purchase-orders/${purchaseOrderId}/approve`)
      .set(bearer(viewerToken))
      .send({ reason: 'Independent procurement approval before packing' });
    expect(approvedPurchase.status, JSON.stringify(approvedPurchase.body)).toBe(200);

    const fulfillment = await request(app.getHttpServer())
      .get(`/api/sales-orders/${stageCOrderId}/fulfillment`)
      .set(bearer(adminToken));
    expect(fulfillment.status, JSON.stringify(fulfillment.body)).toBe(200);
    expect(fulfillment.body.packing_list_source).toEqual({
      document_set_id: stageCDocumentSetId,
      version: stageCDocumentVersion,
      source_order_locked: true,
      packages: [
        {
          package_no: 'PKG-1',
          net_weight_kg: '7.5000',
          volume_cbm: '0.060000',
          items: [
            {
              sales_order_item_id: stageCOrderItemId,
              quantity: '3.000',
              weight_kg: '2.5000',
              volume_cbm: '0.020000',
            },
          ],
        },
      ],
    });
    expect(fulfillment.body.items[0].available_quantity).toBe('3.000');

    const packingDocument = await request(app.getHttpServer())
      .get(`/api/document-sets/${stageCDocumentSetId}`)
      .set(bearer(adminToken));
    expect(packingDocument.status).toBe(200);
    const realPackingPdf = await new PuppeteerDocumentPdfRenderer().render(
      packingDocument.body as PublicDocumentSnapshot,
      'pl',
      { thumbnails: {} },
    );
    expect(realPackingPdf.subarray(0, 5).equals(Buffer.from('%PDF-'))).toBe(true);
    expect(realPackingPdf.length).toBeGreaterThan(1000);

    const shipmentInput = {
      idempotency_key: `stage-c-shipment:${stageCOrderId}:one`,
      batch_number: 'SHIP-STAGE-C-1',
      carrier: 'DHL',
      tracking_number: 'DHL-STAGE-C-1',
      packing_list_document_set_id: stageCDocumentSetId,
      packing_list_version: stageCDocumentVersion,
      boxes: [
        {
          package_no: 'PKG-1',
          gross_weight_kg: '3.0000',
          net_weight_kg: '2.5000',
          volume_cbm: '0.020000',
          items: [{ sales_order_item_id: stageCOrderItemId, quantity: '1.000' }],
        },
      ],
    };
    const invalidWeight = await request(app.getHttpServer())
      .post(`/api/sales-orders/${stageCOrderId}/shipments`)
      .set(bearer(adminToken))
      .send({
        ...shipmentInput,
        idempotency_key: `stage-c-shipment:${stageCOrderId}:invalid-weight`,
        boxes: [{ ...shipmentInput.boxes[0], net_weight_kg: '2.4000' }],
      });
    expect(invalidWeight.status).toBe(400);
    expect(invalidWeight.body.code).toBe('PACKAGE_NET_WEIGHT_MISMATCH');

    const unknownPackage = await request(app.getHttpServer())
      .post(`/api/sales-orders/${stageCOrderId}/shipments`)
      .set(bearer(adminToken))
      .send({
        ...shipmentInput,
        idempotency_key: `stage-c-shipment:${stageCOrderId}:unknown-package`,
        boxes: [{ ...shipmentInput.boxes[0], package_no: 'NOT-IN-PL' }],
      });
    expect(unknownPackage.status).toBe(400);
    expect(unknownPackage.body.code).toBe('PACKAGE_NOT_IN_PACKING_LIST');

    const shipmentResponses = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post(`/api/sales-orders/${stageCOrderId}/shipments`)
          .set(bearer(adminToken))
          .send(shipmentInput),
      ),
    );
    expect(shipmentResponses.map((response) => response.status)).toEqual([201, 201]);
    expect(shipmentResponses.map((response) => response.body.idempotent).sort()).toEqual([
      false,
      true,
    ]);
    expect(shipmentResponses[1].body.id).toBe(shipmentResponses[0].body.id);
    const created = shipmentResponses.find((response) => !response.body.idempotent)!;
    expect(created.body).toMatchObject({
      status: 'draft',
      packing_list_document_set_id: stageCDocumentSetId,
      packing_list_version: stageCDocumentVersion,
      idempotent: false,
    });
    expect(created.body.boxes).toEqual([
      expect.objectContaining({
        package_no: 'PKG-1',
        gross_weight_kg: '3.0000',
        net_weight_kg: '2.5000',
        volume_cbm: '0.020000',
      }),
    ]);
    const mismatchedReplay = await request(app.getHttpServer())
      .post(`/api/sales-orders/${stageCOrderId}/shipments`)
      .set(bearer(adminToken))
      .send({ ...shipmentInput, carrier: 'FedEx' });
    expect(mismatchedReplay.status).toBe(409);
    expect(mismatchedReplay.body.code).toBe('IDEMPOTENCY_KEY_PAYLOAD_MISMATCH');
    const crossTenant = await request(app.getHttpServer())
      .post(`/api/sales-orders/${stageCOrderId}/shipments`)
      .set(bearer(tenant2Token))
      .send({ ...shipmentInput, idempotency_key: 'stage-c-shipment:tenant-two' });
    expect(crossTenant.status).toBe(404);

    const dispatched = await request(app.getHttpServer())
      .post(`/api/shipments/${created.body.id}/dispatch`)
      .set(bearer(adminToken));
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.status).toBe('dispatched');
    const transitAt = new Date(Date.now() + 1000).toISOString();
    const transitInput = {
      idempotency_key: `stage-c-transit:${created.body.id}`,
      event_type: 'in_transit',
      location: 'Yantian Port',
      description: 'Container gate out',
      occurred_at: transitAt,
    };
    const transitResponses = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post(`/api/shipments/${created.body.id}/logistics-events`)
          .set(bearer(adminToken))
          .send(transitInput),
      ),
    );
    expect(transitResponses.map((response) => response.status)).toEqual([201, 201]);
    expect(transitResponses.map((response) => response.body.idempotent).sort()).toEqual([
      false,
      true,
    ]);
    expect(transitResponses[1].body.id).toBe(transitResponses[0].body.id);

    const proof = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(adminToken))
      .field('purpose', 'delivery_proof')
      .attach('file', Buffer.from('stage-c-signed-proof'), {
        filename: 'stage-c-proof.pdf',
        contentType: 'application/pdf',
      });
    const exceptionEvidence = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(adminToken))
      .field('purpose', 'delivery_exception')
      .attach('file', Buffer.from('stage-c-exception-photo'), {
        filename: 'stage-c-exception.jpg',
        contentType: 'image/jpeg',
      });
    expect(proof.status).toBe(201);
    expect(exceptionEvidence.status).toBe(201);
    const delivered = await request(app.getHttpServer())
      .post(`/api/shipments/${created.body.id}/deliver`)
      .set(bearer(adminToken))
      .send({
        delivered_at: new Date(Date.now() + 2000).toISOString(),
        received_by: 'Erika Mustermann',
        attachment_file_ids: [proof.body.id, exceptionEvidence.body.id],
        note: 'One carton signed at warehouse',
        exception_note: 'Outer carton dented; goods accepted after inspection',
      });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
    expect(delivered.body).toMatchObject({
      status: 'delivered',
      received_by_name: 'Erika Mustermann',
      delivery_exception_note: 'Outer carton dented; goods accepted after inspection',
    });
    expect(delivered.body.delivery_files).toHaveLength(2);

    const partial = await request(app.getHttpServer())
      .get(`/api/sales-orders/${stageCOrderId}/fulfillment`)
      .set(bearer(adminToken));
    expect(partial.status).toBe(200);
    expect(partial.body.aggregate_status).toBe('fulfillment');
    expect(partial.body.items[0]).toMatchObject({
      quantity: '3.000',
      shipped_quantity: '1.000',
      delivered_quantity: '1.000',
      available_quantity: '2.000',
    });

    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      const evidence = await admin.query<{
        action_count: string;
        packing_snapshot: Record<string, unknown>;
        audit_payload: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM audit_logs
             WHERE resource_id=$1::text
               AND action IN ('shipment.created_from_packing_list', 'shipment.dispatched',
                              'shipment.in_transit', 'shipment.delivered')) AS action_count,
           shipment.packing_list_snapshot AS packing_snapshot,
           (SELECT string_agg(COALESCE(after_json::text, ''), '') FROM audit_logs
             WHERE resource_id=$1::text) AS audit_payload
          FROM shipments shipment WHERE shipment.id=$1::uuid`,
        [created.body.id],
      );
      expect(evidence.rows[0].action_count).toBe('4');
      expect(evidence.rows[0].packing_snapshot).toMatchObject({
        document_set_id: stageCDocumentSetId,
        document_version: stageCDocumentVersion,
        source_order_locked: true,
      });
      expect(evidence.rows[0].audit_payload).not.toContain('cost_unit_price');
      expect(evidence.rows[0].audit_payload).not.toContain('10.0000');
    } finally {
      await admin.end();
    }
    storage.objects.clear();
  });

  it('stores audit projections without product or document financials', async () => {
    for (const auditTarget of [
      { action: 'product.created', resourceId: adminProductId },
      { action: 'trade_document.created', resourceId: documentId },
    ]) {
      const list = await request(app.getHttpServer())
        .get(
          `/api/audit-logs?action=${auditTarget.action}&resourceId=${auditTarget.resourceId}&pageSize=1`,
        )
        .set(bearer(viewerToken));
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      const detail = await request(app.getHttpServer())
        .get(`/api/audit-logs/${list.body.data[0].id}`)
        .set(bearer(viewerToken));
      expect(detail.status).toBe(200);
      const serialized = JSON.stringify(detail.body);
      expect(serialized).not.toContain('cost_unit_price');
      expect(serialized).not.toContain('internal_expenses');
      expect(serialized).not.toContain('internal_totals');
      expect(serialized).not.toContain('gross_profit');
      expect(serialized).not.toContain('7.8900');
      expect(serialized).not.toContain('6.5000');
    }
  });

  it('rejects same-tenant document assets outside Files view and download scope', async () => {
    const image = await request(app.getHttpServer())
      .post('/api/files')
      .set(bearer(adminToken))
      .attach('file', Buffer.from('fake-png'), {
        filename: 'brand.png',
        contentType: 'image/png',
      });
    expect(image.status).toBe(201);
    adminImageId = image.body.id;

    const unauthorizedReference = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(salesToken))
      .send({ ...publicDocumentPayload('QT-FILE-SCOPE-DENIED'), logo_file_id: adminImageId });
    expect(unauthorizedReference.status).toBe(400);

    const legacyDocument = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(adminToken))
      .send({ ...publicDocumentPayload('QT-FILE-SCOPE-LEGACY'), logo_file_id: adminImageId });
    expect(legacyDocument.status).toBe(201);
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`UPDATE trade_document_sets SET owner_user_id=$1 WHERE id=$2`, [
        TEST_USER2_ID,
        legacyDocument.body.document_set_id,
      ]);
    } finally {
      await admin.end();
    }

    const unauthorizedExport = await request(app.getHttpServer())
      .post(`/api/document-sets/${legacyDocument.body.document_set_id}/exports/pl`)
      .set(bearer(salesToken));
    expect(unauthorizedExport.status).toBe(404);
    expect(renderer.snapshots).toHaveLength(0);
  });

  it('exports a true PDF archive using only the public projection', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/document-sets/${documentId}/exports/ci`)
      .set(bearer(adminToken));
    expect(response.status).toBe(201);
    exportId = response.body.id;
    expect(response.body.file_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.objects.size).toBe(2);
    expect(renderer.snapshots).toHaveLength(1);
    expect(JSON.stringify(renderer.snapshots[0])).not.toContain('7.8900');
    expect(JSON.stringify(renderer.snapshots[0])).not.toContain('internal_totals');
    expect(renderer.snapshots[0].lines[0].custom_fields[0].document_types).toEqual(['ci', 'pl']);
  });

  it('stores only the link hash and keeps the linked export version fixed', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/document-links')
      .set(bearer(adminToken))
      .send({ export_id: exportId });
    expect(created.status).toBe(201);
    rawToken = created.body.token;
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body.expires_at).toBeNull();

    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      const result = await admin.query<{ token_hash: string }>(
        `SELECT token_hash FROM trade_document_share_links WHERE id=$1`,
        [created.body.id],
      );
      expect(result.rows[0].token_hash).toBe(
        await import('node:crypto').then(({ createHash }) =>
          createHash('sha256').update(rawToken).digest('hex'),
        ),
      );
      expect(result.rows[0].token_hash).not.toBe(rawToken);
    } finally {
      await admin.end();
    }

    const updated = await request(app.getHttpServer())
      .patch(`/api/document-sets/${documentId}`)
      .set(bearer(adminToken))
      .send({ ...documentPayload('20.0000'), expected_version: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.source_version).toBe(2);

    const opened = await request(app.getHttpServer()).get(`/api/public/documents/${rawToken}`);
    expect(opened.status).toBe(200);
    expect(opened.body.document.source_version).toBe(1);
    expect(opened.body.document.lines[0].unit_price).toBe('12.3400');
    expect(JSON.stringify(opened.body)).not.toContain('7.8900');
  });

  it('tracks download and confirmation, then rejects a revoked link', async () => {
    const download = await request(app.getHttpServer()).get(
      `/api/public/documents/${rawToken}/download`,
    );
    expect(download.status).toBe(200);
    expect(Buffer.from(download.body).equals(PDF)).toBe(true);

    const confirmed = await request(app.getHttpServer()).post(
      `/api/public/documents/${rawToken}/confirm`,
    );
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.confirmed).toBe(true);

    const repeatedConfirmation = await request(app.getHttpServer()).post(
      `/api/public/documents/${rawToken}/confirm`,
    );
    expect(repeatedConfirmation.status).toBe(201);
    expect(repeatedConfirmation.body.confirmed_at).toBe(confirmed.body.confirmed_at);

    const links = await request(app.getHttpServer())
      .get(`/api/document-sets/${documentId}/links`)
      .set(bearer(adminToken));
    expect(links.status).toBe(200);
    expect(links.body[0].events).toEqual({ opened: 1, downloaded: 1, confirmed: 1 });

    const revoked = await request(app.getHttpServer())
      .delete(`/api/document-links/${links.body[0].id}`)
      .set(bearer(adminToken));
    expect(revoked.status).toBe(200);
    const rejected = await request(app.getHttpServer()).get(`/api/public/documents/${rawToken}`);
    expect(rejected.status).toBe(404);
  });

  it('locks the new source version and prevents further mutation', async () => {
    const locked = await request(app.getHttpServer())
      .post(`/api/document-sets/${documentId}/lock`)
      .set(bearer(adminToken));
    expect(locked.status).toBe(201);
    expect(locked.body.status).toBe('locked');

    const mutation = await request(app.getHttpServer())
      .patch(`/api/document-sets/${documentId}`)
      .set(bearer(adminToken))
      .send({ ...documentPayload('30.0000'), expected_version: 2 });
    expect(mutation.status).toBe(409);
  });
});
