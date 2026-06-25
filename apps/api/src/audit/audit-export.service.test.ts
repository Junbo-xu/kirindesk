import { describe, expect, it, vi } from 'vitest';
import { AuditExportService } from './audit-export.service';
import type { AuditQueryService } from './audit-query.service';
import type { AuditService } from './audit.service';
import type { AuditLogSummary } from './audit-log.response';

const ACTOR = { userId: 'u1', tenantId: 't1', dataScope: 'all' };

function summaryRow(over: Partial<AuditLogSummary> = {}): AuditLogSummary {
  return {
    id: '42',
    tenantId: 't1',
    actorType: 'tenant_user',
    actorId: 'u1',
    actorName: 'Dev Admin',
    action: 'customer.created',
    resourceType: 'customer',
    resourceId: 'c1',
    createdAt: new Date('2026-06-25T13:21:28.182Z'),
    ...over,
  };
}

describe('AuditExportService', () => {
  it('exports only summary columns and audits exactly once', async () => {
    const query = {
      listForExport: vi.fn().mockResolvedValue({ data: [summaryRow()], truncated: false }),
    } as unknown as AuditQueryService;
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const svc = new AuditExportService(query, audit);

    const file = await svc.exportLogs(ACTOR, {});
    const text = file.body.toString('utf8');

    expect(file.filename).toMatch(/^audit-logs_all_all_\d{8}T\d{6}Z\.csv$/);
    expect(text.split('\r\n')[0]).toBe('\uFEFF时间,操作者,操作者类型,动作,资源类型,资源ID,事件ID');
    // ISO 8601 UTC time + no leaked snapshot/chain columns.
    expect(text).toContain('2026-06-25T13:21:28.182Z');
    for (const forbidden of [
      'before',
      'after',
      'metadata',
      'row_hash',
      'prev_hash',
      'hash_version',
    ]) {
      expect(text).not.toContain(forbidden);
    }

    expect(audit.log).toHaveBeenCalledTimes(1);
    const evt = (audit.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(evt.action).toBe('audit_logs.exported');
    expect(evt.resourceType).toBe('audit_log');
    expect(evt.resourceId).toBeNull();
    expect(evt.metadata).toMatchObject({ format: 'csv', rowCount: 1, truncated: false });
  });

  it('appends a truncation marker and flags truncated:true when the cap clips', async () => {
    const query = {
      listForExport: vi.fn().mockResolvedValue({ data: [summaryRow()], truncated: true }),
    } as unknown as AuditQueryService;
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const svc = new AuditExportService(query, audit);

    const file = await svc.exportLogs(ACTOR, {}, 1);
    expect(file.body.toString('utf8')).toContain('已截断');
    const evt = (audit.log as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(evt.metadata).toMatchObject({ truncated: true, cap: 1 });
  });

  it('fail-closed: if the audit write throws, the export throws and returns no file', async () => {
    const query = {
      listForExport: vi.fn().mockResolvedValue({ data: [summaryRow()], truncated: false }),
    } as unknown as AuditQueryService;
    const audit = {
      log: vi.fn().mockRejectedValue(new Error('chain down')),
    } as unknown as AuditService;
    const svc = new AuditExportService(query, audit);

    await expect(svc.exportLogs(ACTOR, {})).rejects.toThrow('chain down');
  });
});
