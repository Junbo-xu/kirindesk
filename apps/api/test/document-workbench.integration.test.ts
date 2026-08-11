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
  let conversionDocumentId: string;
  let conversionOrderId: string;

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

  it('requires a customer and both document/order permissions for internal conversion', async () => {
    const missingCustomer = await request(app.getHttpServer())
      .post(`/api/document-sets/${documentId}/sales-order`)
      .set(bearer(adminToken))
      .send({
        order_number: 'SO-MISSING-CUSTOMER',
        idempotency_key: 'a1000000-0000-4000-8000-000000000001',
      });
    expect(missingCustomer.status).toBe(400);
    expect(missingCustomer.body.code).toBe('QUOTE_CUSTOMER_REQUIRED');

    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: 'Stage A customer', country: 'DE' });
    expect(customer.status).toBe(201);
    const quote = await request(app.getHttpServer())
      .post('/api/document-sets')
      .set(bearer(adminToken))
      .send({
        ...documentPayload(),
        quote_number: 'QT-STAGE-A-CONVERSION',
        customer_id: customer.body.id,
      });
    expect(quote.status).toBe(201);
    conversionDocumentId = quote.body.document_set_id;

    const missingOrderPermission = await request(app.getHttpServer())
      .post(`/api/document-sets/${conversionDocumentId}/sales-order`)
      .set(bearer(viewerToken))
      .send({
        order_number: 'SO-STAGE-A-DENIED',
        idempotency_key: 'a1000000-0000-4000-8000-000000000002',
      });
    expect(missingOrderPermission.status).toBe(403);

    const crossTenant = await request(app.getHttpServer())
      .post(`/api/document-sets/${conversionDocumentId}/sales-order`)
      .set(bearer(tenant2Token))
      .send({
        order_number: 'SO-STAGE-A-CROSS-TENANT',
        idempotency_key: 'a1000000-0000-4000-8000-000000000003',
      });
    expect(crossTenant.status).toBe(404);
  });

  it('idempotently creates a draft sales order without customer confirmation', async () => {
    const payload = {
      order_number: 'SO-STAGE-A-001',
      idempotency_key: 'a1000000-0000-4000-8000-000000000004',
    };
    const created = await request(app.getHttpServer())
      .post(`/api/document-sets/${conversionDocumentId}/sales-order`)
      .set(bearer(adminToken))
      .send(payload);
    expect(created.status).toBe(201);
    conversionOrderId = created.body.id;
    expect(created.body).toMatchObject({
      order_number: payload.order_number,
      status: 'draft',
      currency: 'USD',
      total_amount: '1184.30',
      source_quote_id: conversionDocumentId,
      source_quote_version: 1,
      source_quote_number: 'QT-STAGE-A-CONVERSION',
    });
    expect(created.body.items).toHaveLength(1);
    expect(created.body.items[0]).toMatchObject({
      description: 'Steel bottle',
      product_code: 'BOTTLE-750',
      quantity: '100.000',
      unit_price: '12.3400',
    });
    expect(JSON.stringify(created.body)).not.toContain('source_quote_snapshot');
    expect(JSON.stringify(created.body)).not.toContain('7.8900');

    const replay = await request(app.getHttpServer())
      .post(`/api/document-sets/${conversionDocumentId}/sales-order`)
      .set(bearer(adminToken))
      .send(payload);
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(conversionOrderId);

    const retryWithNewRequestKey = await request(app.getHttpServer())
      .post(`/api/document-sets/${conversionDocumentId}/sales-order`)
      .set(bearer(adminToken))
      .send({
        order_number: 'SO-STAGE-A-RETRY-IGNORED',
        idempotency_key: 'a1000000-0000-4000-8000-000000000005',
      });
    expect(retryWithNewRequestKey.status).toBe(201);
    expect(retryWithNewRequestKey.body.id).toBe(conversionOrderId);

    const quote = await request(app.getHttpServer())
      .get(`/api/document-sets/${conversionDocumentId}`)
      .set(bearer(adminToken));
    expect(quote.status).toBe(200);
    expect(quote.body.sales_order_id).toBe(conversionOrderId);

    const order = await request(app.getHttpServer())
      .get(`/api/sales-orders/${conversionOrderId}`)
      .set(bearer(adminToken));
    expect(order.status).toBe(200);
    expect(order.body.source_quote_id).toBe(conversionDocumentId);
    expect(order.body.source_quote_version).toBe(1);
    expect(JSON.stringify(order.body)).not.toContain('source_quote_snapshot');
    expect(JSON.stringify(order.body)).not.toContain('7.8900');

    const auditList = await request(app.getHttpServer())
      .get(
        `/api/audit-logs?action=trade_document.converted_to_sales_order&resourceId=${conversionDocumentId}&pageSize=1`,
      )
      .set(bearer(viewerToken));
    expect(auditList.status).toBe(200);
    expect(auditList.body.data).toHaveLength(1);
    const auditDetail = await request(app.getHttpServer())
      .get(`/api/audit-logs/${auditList.body.data[0].id}`)
      .set(bearer(viewerToken));
    expect(auditDetail.status).toBe(200);
    expect(JSON.stringify(auditDetail.body)).not.toContain('source_quote_snapshot');
    expect(JSON.stringify(auditDetail.body)).not.toContain('cost_unit_price');
    expect(JSON.stringify(auditDetail.body)).not.toContain('7.8900');
  });

  it('preserves the exact source version and financial snapshot outside public responses', async () => {
    const quoteBefore = await request(app.getHttpServer())
      .get(`/api/document-sets/${conversionDocumentId}`)
      .set(bearer(adminToken));
    const updated = await request(app.getHttpServer())
      .patch(`/api/document-sets/${conversionDocumentId}`)
      .set(bearer(adminToken))
      .send({
        ...updatePayloadFromDocument(quoteBefore.body),
        terms: 'Updated after order conversion',
      });
    expect(updated.status).toBe(200);
    expect(updated.body.source_version).toBe(2);

    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    try {
      const stored = await admin.query<{
        source_quote_version: number;
        source_quote_snapshot: {
          source_version: number;
          lines: Array<{ cost_unit_price: string | null }>;
        };
        orders: string;
        conversion_audits: string;
      }>(
        `SELECT order_record.source_quote_version,
                order_record.source_quote_snapshot,
                (SELECT COUNT(*)::text FROM sales_orders WHERE source_quote_id = $1::uuid) AS orders,
                (SELECT COUNT(*)::text FROM audit_logs
                  WHERE resource_id = $1::text
                    AND action = 'trade_document.converted_to_sales_order')
                  AS conversion_audits
           FROM sales_orders order_record
          WHERE order_record.id = $2`,
        [conversionDocumentId, conversionOrderId],
      );
      expect(stored.rows[0].source_quote_version).toBe(1);
      expect(stored.rows[0].source_quote_snapshot.source_version).toBe(1);
      expect(stored.rows[0].source_quote_snapshot.lines[0].cost_unit_price).toBe('7.8900');
      expect(stored.rows[0].orders).toBe('1');
      expect(stored.rows[0].conversion_audits).toBe('1');
    } finally {
      await admin.end();
    }
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
