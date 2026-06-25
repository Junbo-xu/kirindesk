import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ReportsService, RequestActor, ReportSummary } from './reports.service';
import { ReportSummaryQuery } from './dto/report-summary.query';
import {
  CsvCell,
  CSV_MIME,
  ExportFile,
  ExportFormat,
  exportTimestamp,
  num,
  txt,
  serializeCsv,
  BLANK_ROW,
} from '../common/export-csv';

export type ReportSide = 'sales' | 'purchase';

const SIDE_LABEL: Record<ReportSide, string> = {
  sales: '销售汇总',
  purchase: '采购汇总',
};

// Presentation labels for the self-describing preamble (plan §4.4). The data
// rows' group labels are already localized by ReportsService.
const CALIBER_LABEL: Record<string, string> = {
  realized: '已实现',
  approved_up: '已审批及以上',
  pipeline: '在途',
  all: '全部',
};
const GROUP_BY_LABEL: Record<string, string> = {
  status: '按状态',
  customer: '按客户',
  supplier: '按供应商',
  period: '按时间',
};
const GRANULARITY_LABEL: Record<string, string> = { month: '按月', day: '按日' };

/**
 * Serializes a report summary to a CSV download and records one audit event
 * (plan §3.6/§5.2). Reuses ReportsService for the aggregation — same query,
 * same dataScope, same base currency — so the export can never drift from the
 * page. ReportsService itself is untouched.
 */
@Injectable()
export class ReportsExportService {
  constructor(
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  async exportSummary(
    side: ReportSide,
    actor: RequestActor,
    query: ReportSummaryQuery & { format?: ExportFormat },
  ): Promise<ExportFile> {
    const summary =
      side === 'sales'
        ? await this.reports.salesSummary(actor, query)
        : await this.reports.purchaseSummary(actor, query);

    const body = serializeCsv(this.buildRows(side, summary));
    const format: ExportFormat = query.format ?? 'csv';

    const from = query.from.slice(0, 10);
    const to = query.to.slice(0, 10);
    const filename = `report-${side}_${summary.caliber}_${from}_${to}_${exportTimestamp()}.${format}`;

    // Audit BEFORE returning the bytes (fail-closed, plan §5.2): if the audit
    // write throws, this propagates and the controller never sends the file —
    // no un-recorded bulk export. Identifiers + summary only, no business data.
    await this.audit.log({
      tenantId: actor.tenantId,
      actorType: 'tenant_user',
      actorId: actor.userId,
      action: 'report.exported',
      resourceType: 'report',
      resourceId: side,
      metadata: {
        side,
        format,
        caliber: summary.caliber,
        groupBy: summary.groupBy,
        granularity: summary.range.granularity,
        from: query.from,
        to: query.to,
        currency: summary.currency,
        rowCount: summary.rows.length,
      },
    });

    return { filename, mime: CSV_MIME, body };
  }

  private buildRows(side: ReportSide, summary: ReportSummary): CsvCell[][] {
    const amountHeader = `本位币金额(${summary.currency})`;

    const preamble: CsvCell[][] = [
      [txt('报表'), txt(SIDE_LABEL[side])],
      [txt('口径'), txt(CALIBER_LABEL[summary.caliber] ?? summary.caliber)],
      [txt('本位币'), txt(summary.currency)],
      [txt('时间范围'), txt(`${summary.range.from} ~ ${summary.range.to}`)],
      [txt('分组'), txt(GROUP_BY_LABEL[summary.groupBy] ?? summary.groupBy)],
    ];
    if (summary.groupBy === 'period') {
      preamble.push([
        txt('粒度'),
        txt(GRANULARITY_LABEL[summary.range.granularity] ?? summary.range.granularity),
      ]);
    }

    const header: CsvCell[] = [txt('分组'), txt('订单数'), txt(amountHeader), txt('未计入笔数')];
    const dataRows: CsvCell[][] = summary.rows.map((r) => [
      txt(r.label),
      num(r.orderCount),
      num(r.amountBase),
      num(r.unCostedCount),
    ]);
    const totalsRow: CsvCell[] = [
      txt('合计'),
      num(summary.totals.orderCount),
      num(summary.totals.amountBase),
      num(summary.totals.unCostedCount),
    ];

    return [...preamble, BLANK_ROW, header, ...dataRows, totalsRow];
  }
}
