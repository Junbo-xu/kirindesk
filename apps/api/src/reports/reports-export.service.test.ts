import { describe, expect, it, vi } from 'vitest';
import { ReportsExportService } from './reports-export.service';
import type { ReportsService, ReportSummary } from './reports.service';
import type { AuditService } from '../audit/audit.service';

const ACTOR = { userId: 'u1', tenantId: 't1', dataScope: 'all' };
const QUERY = { from: '2026-01-01', to: '2026-12-31' };

function summary(): ReportSummary {
  return {
    caliber: 'all',
    currency: 'RMB',
    groupBy: 'status',
    range: { from: '2026-01-01', to: '2026-12-31', granularity: 'month' },
    rows: [{ key: 'draft', label: '草稿', orderCount: 2, amountBase: '100.00', unCostedCount: 1 }],
    totals: { orderCount: 2, amountBase: '100.00', unCostedCount: 1 },
  };
}

describe('ReportsExportService', () => {
  it('serializes the summary and audits exactly once before returning', async () => {
    const reports = {
      salesSummary: vi.fn().mockResolvedValue(summary()),
    } as unknown as ReportsService;
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const svc = new ReportsExportService(reports, audit);

    const file = await svc.exportSummary('sales', ACTOR, QUERY);

    expect(file.filename).toMatch(/^report-sales_all_2026-01-01_2026-12-31_\d{8}T\d{6}Z\.csv$/);
    expect(file.mime).toBe('text/csv; charset=utf-8');
    expect(file.body[0]).toBe(0xef); // BOM
    const text = file.body.toString('utf8');
    expect(text).toContain('草稿');
    expect(text).toContain('合计');

    expect(audit.log).toHaveBeenCalledTimes(1);
    const evt = (audit.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(evt.action).toBe('report.exported');
    expect(evt.resourceType).toBe('report');
    expect(evt.resourceId).toBe('sales');
    expect(evt.metadata).toMatchObject({ side: 'sales', format: 'csv', rowCount: 1 });
  });

  it('fail-closed: if the audit write throws, the export throws and returns no file', async () => {
    const reports = {
      salesSummary: vi.fn().mockResolvedValue(summary()),
    } as unknown as ReportsService;
    const audit = {
      log: vi.fn().mockRejectedValue(new Error('chain down')),
    } as unknown as AuditService;
    const svc = new ReportsExportService(reports, audit);

    await expect(svc.exportSummary('sales', ACTOR, QUERY)).rejects.toThrow('chain down');
    expect(reports.salesSummary).toHaveBeenCalledTimes(1); // query ran, but no un-audited egress
  });
});
