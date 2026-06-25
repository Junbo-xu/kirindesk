import { IsIn, IsOptional } from 'class-validator';
import { ReportSummaryQuery } from './report-summary.query';
import { EXPORT_FORMATS, ExportFormat } from '../../common/export-csv';

/**
 * Export query for the report summaries (plan §3.2). Inherits the exact same
 * from/to/groupBy/granularity/caliber validation as the JSON endpoint — the
 * export calls the same ReportsService method, so per-side groupBy and
 * from≤to checks apply identically and the export can never drift from the
 * page. Only `format` is added.
 */
export class ReportSummaryExportQuery extends ReportSummaryQuery {
  // Only 'csv' this phase; 'xlsx' is rejected (400) until the §4 decision.
  @IsOptional()
  @IsIn(EXPORT_FORMATS)
  format?: ExportFormat;
}
