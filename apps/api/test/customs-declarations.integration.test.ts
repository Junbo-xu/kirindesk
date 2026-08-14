import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { closePool, verifyChain } from '@kirindesk/database';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import {
  CUSTOMS_PDF_RENDERER,
  CustomsPdfRenderer,
  PuppeteerCustomsPdfRenderer,
} from '../src/customs-declarations/customs-pdf.renderer';
import type {
  CustomsDocumentType,
  CustomsPdfSnapshot,
} from '../src/customs-declarations/customs-declarations.types';
import { APP_POOL } from '../src/database/database.module';
import {
  DOCUMENT_PDF_RENDERER,
  DocumentPdfRenderer,
} from '../src/document-workbench/document-pdf.renderer';
import type {
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
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_USER_EMAIL,
} from './fixtures';

const PDF = Buffer.from('%PDF-1.4\nKirinDesk customs integration document\n%%EOF');

class ContractCustomsRenderer implements CustomsPdfRenderer {
  readonly calls: Array<{ snapshot: CustomsPdfSnapshot; type: CustomsDocumentType }> = [];

  async render(snapshot: CustomsPdfSnapshot, type: CustomsDocumentType): Promise<Buffer> {
    this.calls.push({ snapshot, type });
    return PDF;
  }
}

class ContractDocumentRenderer implements DocumentPdfRenderer {
  async render(
    _snapshot: PublicDocumentSnapshot,
    _documentType: DocumentType,
    _assets: DocumentRenderAssets,
  ): Promise<Buffer> {
    return PDF;
  }
}

describe('Stage D customs declaration archives (integration)', () => {
  let app: INestApplication;
  let pool: pg.Pool;
  let storage: FakeStorageProvider;
  let renderer: ContractCustomsRenderer;
  let adminToken: string;
  let salesToken: string;
  let tenant2Token: string;
  let noPermissionToken: string;
  let declarationId: string;
  let salesOrderId: string;

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

  async function withAdmin<T>(callback: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      return await callback(client);
    } finally {
      await client.end();
    }
  }

  async function grantIndependentApprover(): Promise<void> {
    await withAdmin(async (client) => {
      const roleId = '7c000000-0000-4000-8000-000000000001';
      await client.query(
        `INSERT INTO roles (id, tenant_id, name, is_system)
         VALUES ($1,$2,'Customs independent approver',false)`,
        [roleId, TEST_TENANT_ID],
      );
      await client.query(
        `INSERT INTO user_roles (tenant_id, user_id, role_id)
         VALUES ($1,'77777777-7777-7777-7777-777777777777',$2)`,
        [TEST_TENANT_ID, roleId],
      );
      await client.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
         SELECT $1,$2,id,'all' FROM permissions
          WHERE code=ANY($3::text[])`,
        [
          TEST_TENANT_ID,
          roleId,
          ['orders:approve', 'customs_declarations:manage', 'files:download'],
        ],
      );
    });
  }

  async function createSource(suffix: string, complete: boolean) {
    const product = await request(app.getHttpServer())
      .post('/api/products')
      .set(bearer(adminToken))
      .send({
        sku: `CUS-${suffix}`,
        name: `Customs product ${suffix}`,
        unit: 'pcs',
        ...(complete ? { hs_code: '8504409999' } : {}),
        default_currency: 'USD',
        default_unit_price: '25.0000',
        cost_unit_price: '7.0000',
        weight_kg: '2.5000',
        volume_cbm: '0.020000',
        custom_values: complete ? { declaration_elements: '品牌类型;型号;用途;额定功率' } : {},
      });
    expect(product.status, JSON.stringify(product.body)).toBe(201);

    const customer = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(adminToken))
      .send({ company_name: `Customs customer ${suffix}`, country: 'US' });
    expect(customer.status).toBe(201);

    const order = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(adminToken))
      .send({
        customer_id: customer.body.id,
        order_number: `SO-CUS-${suffix}`,
        currency: 'USD',
        items: [
          {
            product_id: product.body.id,
            description: `Customs product ${suffix}`,
            product_code: `CUS-${suffix}`,
            unit: 'pcs',
            quantity: '4.000',
            unit_price: '25.0000',
          },
        ],
      });
    expect(order.status).toBe(201);
    const submitted = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/submit`)
      .set(bearer(adminToken));
    expect(submitted.status).toBe(200);
    const approved = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/approve`)
      .set(bearer(noPermissionToken));
    expect(approved.status).toBe(200);
    const locked = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/fulfillment-lock`)
      .set(bearer(adminToken))
      .send({ expected_updated_at: approved.body.updated_at });
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    expect(locked.body.sales_order.fulfillment_locked_at).toBeTruthy();

    const synced = await request(app.getHttpServer())
      .post(`/api/sales-orders/${order.body.id}/document-set`)
      .set(bearer(adminToken))
      .send({
        idempotency_key: `customs-sync:${suffix}`,
        expected_updated_at: locked.body.sales_order.updated_at,
      });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    await withAdmin((client) =>
      client.query(
        `UPDATE trade_document_lines SET package_no='PKG-1'
          WHERE document_set_id=$1`,
        [synced.body.document.document_set_id],
      ),
    );
    const document = await request(app.getHttpServer())
      .post(`/api/document-sets/${synced.body.document.document_set_id}/lock`)
      .set(bearer(adminToken));
    expect(document.status).toBe(201);
    for (const type of ['ci', 'pl']) {
      const exported = await request(app.getHttpServer())
        .post(`/api/document-sets/${synced.body.document.document_set_id}/exports/${type}`)
        .set(bearer(adminToken));
      expect(exported.status, JSON.stringify(exported.body)).toBe(201);
      expect(exported.body.is_draft).toBe(false);
    }
    return { orderId: order.body.id as string };
  }

  function declarationInput(idempotencyKey: string, port = '上海海关') {
    return {
      idempotency_key: idempotencyKey,
      port,
      trade_mode: '一般贸易',
      package_type: '纸箱',
      gross_weight_kg: '11.0000',
      consignor_name: '麒麟桌国际贸易有限公司',
      consignor_uscc: '91310000MA1K123456',
      consignor_contact: '林经理',
      consignor_phone: '13800000000',
      customs_broker_name: '上海示范报关有限公司',
      customs_broker_uscc: '91310115MA1K654321',
      customs_broker_contact: '陈报关员',
      customs_broker_phone: '13900000000',
      authorization_matters: ['代理申报', '配合海关查验', '办理放行手续'],
    };
  }

  beforeAll(async () => {
    storage = new FakeStorageProvider();
    renderer = new ContractCustomsRenderer();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STORAGE_PROVIDER)
      .useValue(storage)
      .overrideProvider(DOCUMENT_PDF_RENDERER)
      .useValue(new ContractDocumentRenderer())
      .overrideProvider(CUSTOMS_PDF_RENDERER)
      .useValue(renderer)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<pg.Pool>(APP_POOL);
    await grantIndependentApprover();
    adminToken = await login(TEST_USER_EMAIL);
    salesToken = await login(TEST_USER2_EMAIL);
    tenant2Token = await login(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);
    noPermissionToken = await login(TEST_USER4_EMAIL);
    const field = await request(app.getHttpServer())
      .post('/api/product-fields')
      .set(bearer(adminToken))
      .send({
        field_key: 'declaration_elements',
        label: '申报要素',
        data_type: 'text',
        document_types: ['ci'],
      });
    expect(field.status).toBe(201);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (pool) await pool.end();
    await closePool();
  });

  it('blocks incomplete source data with a clear missing list', async () => {
    const source = await createSource('MISSING', false);
    const response = await request(app.getHttpServer())
      .post(`/api/sales-orders/${source.orderId}/customs-declarations`)
      .set(bearer(adminToken))
      .send(declarationInput('customs-create:missing'));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('CUSTOMS_SOURCE_INCONSISTENT');
    expect(response.body.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'HS_CODE_REQUIRED', line_no: 1 }),
        expect.objectContaining({ code: 'DECLARATION_ELEMENTS_REQUIRED', line_no: 1 }),
      ]),
    );
  });

  it('creates idempotently from locked order and CI/PL history without leaking costs', async () => {
    const source = await createSource('COMPLETE', true);
    salesOrderId = source.orderId;
    const invalidWeight = await request(app.getHttpServer())
      .post(`/api/sales-orders/${salesOrderId}/customs-declarations`)
      .set(bearer(adminToken))
      .send({
        ...declarationInput('customs-create:weight-conflict'),
        gross_weight_kg: '9.0000',
      });
    expect(invalidWeight.status).toBe(400);
    expect(invalidWeight.body.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'GROSS_WEIGHT_BELOW_NET_WEIGHT' })]),
    );
    const input = declarationInput('customs-create:complete');
    const first = await request(app.getHttpServer())
      .post(`/api/sales-orders/${salesOrderId}/customs-declarations`)
      .set(bearer(adminToken))
      .send(input);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.idempotent).toBe(false);
    expect(first.body.declaration.customs_data).toMatchObject({
      port: '上海海关',
      trade_mode: '一般贸易',
      package_type: '纸箱',
      package_count: 1,
      gross_weight_kg: '11.0000',
      net_weight_kg: '10.0000',
      currency: 'USD',
      total_amount: '100.00',
    });
    expect(first.body.declaration.customs_data.lines[0]).toMatchObject({
      hs_code: '8504409999',
      declaration_elements: '品牌类型;型号;用途;额定功率',
      quantity: '4.000',
      line_total: '100.00',
      package_no: 'PKG-1',
      net_weight_kg: '10.0000',
    });
    expect(JSON.stringify(first.body)).not.toContain('cost_unit_price');
    expect(JSON.stringify(first.body)).not.toContain('internal_totals');
    declarationId = first.body.declaration.id;

    const replay = await request(app.getHttpServer())
      .post(`/api/sales-orders/${salesOrderId}/customs-declarations`)
      .set(bearer(adminToken))
      .send(input);
    expect(replay.status).toBe(201);
    expect(replay.body.idempotent).toBe(true);
    expect(replay.body.declaration.id).toBe(declarationId);

    const reused = await request(app.getHttpServer())
      .post(`/api/sales-orders/${salesOrderId}/customs-declarations`)
      .set(bearer(adminToken))
      .send({ ...input, port: '宁波海关' });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const list = await request(app.getHttpServer())
      .get('/api/customs-declarations')
      .set(bearer(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: declarationId, sales_order_id: salesOrderId }),
      ]),
    );
    expect(JSON.stringify(list.body)).not.toContain('cost_unit_price');
  });

  it('generates immutable archived PDFs, exports idempotently, and records audit', async () => {
    const first = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/generate`)
      .set(bearer(noPermissionToken))
      .send({ idempotency_key: 'customs-generate:complete:v1' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.idempotent).toBe(false);
    expect(first.body.version.version).toBe(1);
    expect(renderer.calls.map((call) => call.type)).toEqual(['pre_entry', 'authorization']);

    const replay = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/generate`)
      .set(bearer(adminToken))
      .send({ idempotency_key: 'customs-generate:complete:v1' });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
    expect(replay.body.version).toMatchObject({
      id: first.body.version.id,
      pre_entry_file_id: first.body.version.pre_entry_file_id,
      authorization_file_id: first.body.version.authorization_file_id,
    });
    expect(renderer.calls).toHaveLength(2);

    const files = await withAdmin((client) =>
      client.query<{ id: string; storage_key: string; purpose: string; size_bytes: string }>(
        `SELECT id, storage_key, purpose, size_bytes::text
           FROM files
          WHERE id=ANY($1::uuid[])
          ORDER BY purpose`,
        [[first.body.version.pre_entry_file_id, first.body.version.authorization_file_id]],
      ),
    );
    expect(files.rows.map((file) => file.purpose).sort()).toEqual([
      'customs-authorization',
      'customs-pre-entry',
    ]);
    for (const file of files.rows) {
      expect(storage.objects.get(file.storage_key)?.body.subarray(0, 5).toString()).toBe('%PDF-');
      expect(Number(file.size_bytes)).toBe(PDF.length);
    }

    const genericList = await request(app.getHttpServer())
      .get('/api/files')
      .set(bearer(adminToken));
    expect(genericList.status).toBe(200);
    expect(genericList.body.data.map((file: { id: string }) => file.id)).not.toContain(
      first.body.version.pre_entry_file_id,
    );

    for (const tokenActor of [adminToken, noPermissionToken]) {
      const genericToken = await request(app.getHttpServer())
        .post(`/api/files/${first.body.version.pre_entry_file_id}/token`)
        .set(bearer(tokenActor));
      expect(genericToken.status).toBe(404);
    }
    const missingExportPermission = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/versions/1/files/pre_entry/token`)
      .set(bearer(noPermissionToken));
    expect(missingExportPermission.status).toBe(403);

    const domainToken = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/versions/1/files/pre_entry/token`)
      .set(bearer(adminToken));
    expect(domainToken.status).toBe(201);
    const download = await request(app.getHttpServer()).get(
      `/api/files/download?token=${domainToken.body.token}`,
    );
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(download.body).equals(PDF)).toBe(true);

    const exported = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/versions/1/export`)
      .set(bearer(adminToken))
      .send({ idempotency_key: 'customs-export:complete:v1' });
    expect(exported.status).toBe(200);
    expect(exported.body.idempotent).toBe(false);
    const exportReplay = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/versions/1/export`)
      .set(bearer(adminToken))
      .send({ idempotency_key: 'customs-export:complete:v1' });
    expect(exportReplay.status).toBe(200);
    expect(exportReplay.body.idempotent).toBe(true);

    const audits = await withAdmin((client) =>
      client.query<{ action: string; after_json: Record<string, unknown> }>(
        `SELECT action, after_json FROM audit_logs
          WHERE resource_id IN ($1,$2)
             OR (after_json->>'declaration_set_id')=$3`,
        [declarationId, first.body.version.id, declarationId],
      ),
    );
    expect(audits.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'customs_declaration.created',
        'customs_declaration.generated',
        'customs_declaration.exported',
      ]),
    );
    expect(JSON.stringify(audits.rows)).not.toContain('cost_unit_price');
    const chain = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(chain.ok).toBe(true);
  });

  it('preserves generated versions when refreshed and creates a new archive version', async () => {
    const refreshed = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/refresh`)
      .set(bearer(adminToken))
      .send(declarationInput('customs-refresh:complete:v2', '宁波海关'));
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
    expect(refreshed.body).toMatchObject({
      idempotent: false,
      refreshed: true,
      preserved_version_count: 1,
    });
    expect(refreshed.body.declaration.status).toBe('draft');
    expect(refreshed.body.declaration.customs_data.port).toBe('宁波海关');
    expect(refreshed.body.declaration.versions).toHaveLength(1);
    expect(refreshed.body.declaration.versions[0].customs_data.port).toBe('上海海关');

    const refreshReplay = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/refresh`)
      .set(bearer(adminToken))
      .send(declarationInput('customs-refresh:complete:v2', '宁波海关'));
    expect(refreshReplay.status).toBe(200);
    expect(refreshReplay.body).toMatchObject({
      idempotent: true,
      refreshed: true,
      preserved_version_count: 1,
    });

    const generated = await request(app.getHttpServer())
      .post(`/api/customs-declarations/${declarationId}/generate`)
      .set(bearer(adminToken))
      .send({ idempotency_key: 'customs-generate:complete:v2' });
    expect(generated.status, JSON.stringify(generated.body)).toBe(200);
    expect(generated.body.version.version).toBe(2);
    expect(generated.body.version.customs_data.port).toBe('宁波海关');

    const current = await request(app.getHttpServer())
      .get(`/api/sales-orders/${salesOrderId}/customs-declaration`)
      .set(bearer(adminToken));
    expect(current.status).toBe(200);
    expect(current.body.versions.map((version: { version: number }) => version.version)).toEqual([
      2, 1,
    ]);

    await expect(
      withAdmin((client) =>
        client.query(
          `UPDATE customs_declaration_versions SET source_fingerprint=$1
            WHERE declaration_set_id=$2 AND version=1`,
          ['0'.repeat(64), declarationId],
        ),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('enforces RBAC, owner scope, and cross-tenant RLS', async () => {
    const noPermission = await request(app.getHttpServer())
      .get(`/api/sales-orders/${salesOrderId}/customs-declaration`)
      .set(bearer(noPermissionToken));
    expect(noPermission.status).toBe(403);

    await withAdmin((client) =>
      client.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_id, data_scope)
         SELECT $1,'7c000000-0000-4000-8000-000000000001',id,'none'
           FROM permissions WHERE code='customs_declarations:view'`,
        [TEST_TENANT_ID],
      ),
    );
    const noneScoped = await request(app.getHttpServer())
      .get(`/api/sales-orders/${salesOrderId}/customs-declaration`)
      .set(bearer(noPermissionToken));
    expect(noneScoped.status).toBe(404);
    const noneScopedList = await request(app.getHttpServer())
      .get('/api/customs-declarations')
      .set(bearer(noPermissionToken));
    expect(noneScopedList.status).toBe(200);
    expect(noneScopedList.body.data).toEqual([]);

    const ownerScoped = await request(app.getHttpServer())
      .get(`/api/sales-orders/${salesOrderId}/customs-declaration`)
      .set(bearer(salesToken));
    expect(ownerScoped.status).toBe(404);

    const crossTenant = await request(app.getHttpServer())
      .get(`/api/sales-orders/${salesOrderId}/customs-declaration`)
      .set(bearer(tenant2Token));
    expect(crossTenant.status).toBe(404);
    const crossTenantList = await request(app.getHttpServer())
      .get('/api/customs-declarations')
      .set(bearer(tenant2Token));
    expect(crossTenantList.status).toBe(200);
    expect(crossTenantList.body.data).toEqual([]);
  });

  it('renders both real PDF document types', async () => {
    const current = await request(app.getHttpServer())
      .get(`/api/sales-orders/${salesOrderId}/customs-declaration`)
      .set(bearer(adminToken));
    expect(current.status).toBe(200);
    const snapshot: CustomsPdfSnapshot = {
      version: current.body.latest_version,
      generated_at: new Date().toISOString(),
      data: current.body.customs_data,
    };
    const realRenderer = new PuppeteerCustomsPdfRenderer();
    for (const type of ['pre_entry', 'authorization'] as const) {
      const pdf = await realRenderer.render(snapshot, type);
      expect(pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))).toBe(true);
      expect(pdf.length).toBeGreaterThan(1000);
    }
  });
});
