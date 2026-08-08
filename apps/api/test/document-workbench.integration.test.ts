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
  let viewerToken: string;
  let tenant2Token: string;
  let documentId: string;
  let exportId: string;
  let rawToken: string;

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

  async function grantReadOnlyViewer(): Promise<void> {
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
         SELECT $1,$2,id,'all' FROM permissions WHERE code='document_sets:view'`,
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
    await grantReadOnlyViewer();
    adminToken = await login(TEST_USER_EMAIL);
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
        custom_values: { customer_code: 'CUSTOM-001' },
      });
    expect(product.status).toBe(201);
    expect(product.body.custom_values).toEqual({ customer_code: 'CUSTOM-001' });
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
    expect(response.body.lines[0].custom_fields).toEqual([
      {
        field_key: 'customer_code',
        label: 'Customer code',
        value: 'CUSTOM-001',
        document_types: ['ci', 'pl'],
      },
    ]);
  });

  it('redacts costs for an authorized viewer without financial permission', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/document-sets/${documentId}`)
      .set(bearer(viewerToken));
    expect(response.status).toBe(200);
    expect(response.body.pricing_mode).toBeUndefined();
    expect(response.body.internal_totals).toBeUndefined();
    expect(response.body.lines[0].cost_unit_price).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('7.8900');
  });

  it('enforces cross-tenant RLS on document ids', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/document-sets/${documentId}`)
      .set(bearer(tenant2Token));
    expect(response.status).toBe(404);
  });

  it('exports a true PDF archive using only the public projection', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/document-sets/${documentId}/exports/ci`)
      .set(bearer(adminToken));
    expect(response.status).toBe(201);
    exportId = response.body.id;
    expect(response.body.file_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.objects.size).toBe(1);
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
