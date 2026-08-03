import { Injectable } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditQueryService, AUDIT_EXPORT_CAP, RequestActor } from './audit-query.service';
import { AuditExportQuery } from './dto/audit-export.query';
import { AuditLogSummary } from './audit-log.response';
import {
  CsvCell,
  CSV_MIME,
  ExportFile,
  ExportFormat,
  exportTimestamp,
  exportWatermarkRows,
  num,
  txt,
  serializeCsv,
  BLANK_ROW,
} from '../common/export-csv';

/**
 * Serializes an audit-log filter result to a CSV download and records one
 * audit event (plan §3.6/§5.2). Reuses AuditQueryService.listForExport — same
 * WHERE, same dataScope, same RLS as the list — and exports ONLY the summary
 * columns (no before/after/metadata/reason/ip/ua/requestId/hash, plan §2.3).
 */
@Injectable()
export class AuditExportService {
  constructor(
    private readonly query: AuditQueryService,
    private readonly audit: AuditService,
  ) {}

  async exportLogs(
    actor: RequestActor,
    query: AuditExportQuery,
    cap: number = AUDIT_EXPORT_CAP,
  ): Promise<ExportFile> {
    const { data, truncated } = await this.query.listForExport(actor, query, cap);

    const exportedAt = new Date();
    const body = serializeCsv([
      ...exportWatermarkRows(actor, exportedAt),
      BLANK_ROW,
      ...this.buildRows(data, truncated, cap),
    ]);
    const format: ExportFormat = query.format ?? 'csv';

    const from = query.from ? query.from.slice(0, 10) : 'all';
    const to = query.to ? query.to.slice(0, 10) : 'all';
    const filename = `audit-logs_${from}_${to}_${exportTimestamp(exportedAt)}.${format}`;

    // Fail-closed (plan §5.2): audit BEFORE returning the bytes. Filter summary
    // + row count + truncation flag only — never the exported row content.
    await this.audit.log({
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action: 'audit_logs.exported',
      resourceType: 'audit_log',
      resourceId: null,
      metadata: {
        format,
        from: query.from ?? null,
        to: query.to ?? null,
        actorType: query.actorType ?? null,
        action: query.action ?? null,
        resourceType: query.resourceType ?? null,
        resourceId: query.resourceId ?? null,
        requestId: query.requestId ?? null,
        rowCount: data.length,
        truncated,
        cap,
      },
    });

    return { filename, mime: CSV_MIME, body };
  }

  private buildRows(rows: AuditLogSummary[], truncated: boolean, cap: number): CsvCell[][] {
    const header: CsvCell[] = [
      txt('时间'),
      txt('操作者'),
      txt('操作者类型'),
      txt('动作'),
      txt('资源类型'),
      txt('资源ID'),
      txt('事件ID'),
    ];
    const dataRows: CsvCell[][] = rows.map((r) => [
      // ISO 8601 UTC for unambiguous, sortable archival (plan §4.6).
      txt(new Date(r.createdAt).toISOString()),
      txt(r.actorName ?? r.actorId),
      txt(r.actorType),
      txt(r.action),
      txt(r.resourceType),
      txt(r.resourceId),
      num(r.id), // numeric string id — exempt from formula-neutralization
    ]);

    const out = [header, ...dataRows];
    if (truncated) {
      // Explicit, obviously-non-data marker — never silently truncate (§4.4).
      out.push([txt(`已截断，本次导出至多 ${cap} 行，请收窄时间窗或过滤后重导`)]);
    }
    return out;
  }
}
