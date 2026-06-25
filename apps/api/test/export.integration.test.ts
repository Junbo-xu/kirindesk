import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { closePool, verifyChain } from '@kirindesk/database';
import { AppModule } from '../src/app.module';
import { APP_POOL } from '../src/database/database.module';
import { AuditQueryService } from '../src/audit/audit-query.service';
import { AuditExportService } from '../src/audit/audit-export.service';
import {
  TEST_TENANT_ID,
  TEST_TENANT_SLUG,
  TEST_TENANT2_SLUG,
  TEST_USER_ID,
  TEST_USER_EMAIL,
  TEST_USER2_EMAIL,
  TEST_USER3_EMAIL,
  TEST_USER4_EMAIL,
  TEST_PASSWORD,
} from './fixtures';

// Minimal RFC 4180 parser (handles our serializer's quoting + CRLF) so we can
// compare exported cells against the JSON endpoints.
function parseCsv(body: string): string[][] {
  const text = body.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe('Data Export API (integration)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminToken: string; // tenant1 admin, scope=all
  let salesToken: string; // tenant1 sales, scope=own
  let nopermToken: string; // tenant1, no roles
  let tenant2Token: string; // tenant2 admin, scope=all
  let tenant1AdminCustomerId: string;

  async function tenantLogin(email: string, slug: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: TEST_PASSWORD, tenantSlug: slug });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  function bearer(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function createCustomer(token: string, companyName: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/customers')
      .set(bearer(token))
      .send({ company_name: companyName });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createDraftOrder(token: string, customerId: string, orderNumber: string) {
    const res = await request(app.getHttpServer())
      .post('/api/sales-orders')
      .set(bearer(token))
      .send({
        customer_id: customerId,
        order_number: orderNumber,
        currency: 'RMB',
        items: [{ description: 'Export sample', quantity: '1', unit_price: '50' }],
      });
    expect(res.status).toBe(201);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    pool = app.get<Pool>(APP_POOL);

    adminToken = await tenantLogin(TEST_USER_EMAIL, TEST_TENANT_SLUG);
    salesToken = await tenantLogin(TEST_USER2_EMAIL, TEST_TENANT_SLUG);
    nopermToken = await tenantLogin(TEST_USER4_EMAIL, TEST_TENANT_SLUG);
    tenant2Token = await tenantLogin(TEST_USER3_EMAIL, TEST_TENANT2_SLUG);

    // Real audited writes → real, chain-valid audit rows + report data.
    tenant1AdminCustomerId = await createCustomer(adminToken, 'Export Admin Customer');
    const salesCustomerId = await createCustomer(salesToken, 'Export Sales Customer');
    await createCustomer(tenant2Token, 'Export T2 Customer');
    await createDraftOrder(adminToken, tenant1AdminCustomerId, 'EXP-SO-ADMIN-1');
    await createDraftOrder(salesToken, salesCustomerId, 'EXP-SO-SALES-1');
  });

  afterAll(async () => {
    if (app) {
      await app.close();
      await pool.end();
    }
    await closePool();
  });

  // ---- reports export -------------------------------------------------------

  const REPORT_Q = 'from=2026-01-01&to=2026-12-31&caliber=all&groupBy=status';

  it('reports: exports CSV with download headers, BOM, preamble, and totals', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/reports/sales-summary/export?${REPORT_Q}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="report-sales_/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text.charCodeAt(0)).toBe(0xfeff); // BOM
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(['报表', '销售汇总']);
    expect(rows.some((r) => r[0] === '合计')).toBe(true);
  });

  it('reports: CSV data rows + totals match the JSON summary (no drift)', async () => {
    const json = await request(app.getHttpServer())
      .get(`/api/reports/sales-summary?${REPORT_Q}`)
      .set(bearer(adminToken));
    expect(json.status).toBe(200);

    const csv = await request(app.getHttpServer())
      .get(`/api/reports/sales-summary/export?${REPORT_Q}`)
      .set(bearer(adminToken));
    const rows = parseCsv(csv.text);

    const headerIdx = rows.findIndex((r) => r[0] === '分组' && r.length === 4);
    expect(headerIdx).toBeGreaterThan(-1);
    const dataRows = rows.slice(headerIdx + 1).filter((r) => r[0] !== '合计' && r.length === 4);
    const totalsRow = rows.find((r) => r[0] === '合计')!;

    // Every JSON row appears in the CSV with identical values.
    expect(dataRows.length).toBe(json.body.rows.length);
    for (const jr of json.body.rows) {
      const cr = dataRows.find((r) => r[0] === jr.label);
      expect(cr, `missing CSV row for ${jr.label}`).toBeTruthy();
      expect(cr![1]).toBe(String(jr.orderCount));
      expect(cr![2]).toBe(jr.amountBase);
      expect(cr![3]).toBe(String(jr.unCostedCount));
    }
    expect(totalsRow[1]).toBe(String(json.body.totals.orderCount));
    expect(totalsRow[2]).toBe(json.body.totals.amountBase);
    expect(totalsRow[3]).toBe(String(json.body.totals.unCostedCount));
  });

  it('reports: rejects a wrong-side groupBy (400), reusing the JSON validation', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/reports/sales-summary/export?from=2026-01-01&to=2026-12-31&groupBy=supplier')
      .set(bearer(adminToken));
    expect(res.status).toBe(400);
  });

  it('reports: rejects format=xlsx (400) — CSV only this phase', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/reports/sales-summary/export?${REPORT_Q}&format=xlsx`)
      .set(bearer(adminToken));
    expect(res.status).toBe(400);
  });

  // ---- audit export ---------------------------------------------------------

  const AUDIT_Q = 'from=2020-01-01&to=2030-01-01';
  const FORBIDDEN_COLS = ['before', 'after', 'metadata', 'row_hash', 'prev_hash', 'hash_version'];

  it('audit: exports only the 7 summary columns — no snapshot/chain columns', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/audit-logs/export?${AUDIT_Q}`)
      .set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      '时间',
      '操作者',
      '操作者类型',
      '动作',
      '资源类型',
      '资源ID',
      '事件ID',
    ]);
    for (const col of FORBIDDEN_COLS) expect(res.text).not.toContain(col);
  });

  it('audit: a filtered export matches the list endpoint with the same filter', async () => {
    const filter = `${AUDIT_Q}&action=customer.created`;
    const list = await request(app.getHttpServer())
      .get(`/api/audit-logs?${filter}&pageSize=1`)
      .set(bearer(adminToken));
    expect(list.status).toBe(200);

    const csv = await request(app.getHttpServer())
      .get(`/api/audit-logs/export?${filter}`)
      .set(bearer(adminToken));
    const dataRows = parseCsv(csv.text).slice(1); // drop header
    expect(dataRows.length).toBe(list.body.total);
    for (const r of dataRows) expect(r[3]).toBe('customer.created');
  });

  it('audit: own-scope export only contains the caller-initiated events', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/audit-logs/export?${AUDIT_Q}`)
      .set(bearer(salesToken));
    expect(res.status).toBe(200);
    const dataRows = parseCsv(res.text).slice(1);
    expect(dataRows.length).toBeGreaterThan(0);
    // own anchors to actor_id → every row is the sales user; never the admin.
    for (const r of dataRows) expect(r[1]).toBe('Test Sales');
  });

  it('audit: cross-tenant export cannot see another tenant rows', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/audit-logs/export?${AUDIT_Q}`)
      .set(bearer(tenant2Token));
    expect(res.status).toBe(200);
    // tenant1's admin-created customer id must never appear in tenant2's export.
    expect(res.text).not.toContain(tenant1AdminCustomerId);
  });

  // ---- RBAC -----------------------------------------------------------------

  it('rejects unauthenticated and unauthorized export requests', async () => {
    expect((await request(app.getHttpServer()).get('/api/audit-logs/export')).status).toBe(401);
    expect(
      (await request(app.getHttpServer()).get(`/api/reports/sales-summary/export?${REPORT_Q}`))
        .status,
    ).toBe(401);

    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/audit-logs/export?${AUDIT_Q}`)
          .set(bearer(nopermToken))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/reports/sales-summary/export?${REPORT_Q}`)
          .set(bearer(nopermToken))
      ).status,
    ).toBe(403);
  });

  // ---- export is itself audited; chain stays valid --------------------------

  it('each successful export writes one audit event with summary-only metadata', async () => {
    // The exports run above already produced report.exported / audit_logs.exported.
    const reportEvt = await request(app.getHttpServer())
      .get('/api/audit-logs?action=report.exported&pageSize=1')
      .set(bearer(adminToken));
    expect(reportEvt.body.total).toBeGreaterThan(0);
    const id = reportEvt.body.data[0].id;
    const detail = await request(app.getHttpServer())
      .get(`/api/audit-logs/${id}`)
      .set(bearer(adminToken));
    expect(detail.body.action).toBe('report.exported');
    expect(detail.body.resourceType).toBe('report');
    expect(detail.body.metadata).toMatchObject({ format: 'csv' });
    expect(typeof detail.body.metadata.rowCount).toBe('number');
    // No business plaintext leaked into the audit metadata.
    expect(JSON.stringify(detail.body.metadata)).not.toContain('Export Admin Customer');

    const auditEvt = await request(app.getHttpServer())
      .get('/api/audit-logs?action=audit_logs.exported&pageSize=1')
      .set(bearer(adminToken));
    expect(auditEvt.body.total).toBeGreaterThan(0);
  });

  it('the tenant audit chain still verifies after exports', async () => {
    const result = await verifyChain(`tenant:${TEST_TENANT_ID}`);
    expect(result.ok).toBe(true);
  });

  // ---- cap / truncation (direct service call with a tiny cap) ---------------

  it('listForExport caps rows and flags truncation; export appends a marker', async () => {
    const actor = { userId: TEST_USER_ID, tenantId: TEST_TENANT_ID, dataScope: 'all' };
    const queryService = app.get(AuditQueryService);
    const capped = await queryService.listForExport(actor, {}, 1);
    expect(capped.data.length).toBe(1);
    expect(capped.truncated).toBe(true);

    const exportService = app.get(AuditExportService);
    const file = await exportService.exportLogs(actor, {}, 1);
    expect(file.body.toString('utf8')).toContain('已截断');
  });
});
