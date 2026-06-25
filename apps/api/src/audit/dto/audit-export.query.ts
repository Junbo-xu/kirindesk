import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ACTOR_TYPES, ActorTypeFilter } from './list-audit-logs.query';
import { EXPORT_FORMATS, ExportFormat } from '../../common/export-csv';

/**
 * Export query for the audit log (plan §3.2). Carries the SAME filter fields
 * (and the same validators) as ListAuditLogsQuery so the exported set matches
 * the list exactly, but deliberately omits page/pageSize — export is the full
 * filtered set up to the server cap, so pagination is meaningless and is
 * rejected by forbidNonWhitelisted. Only `format` is added.
 */
export class AuditExportQuery {
  @IsOptional()
  @IsISO8601({ strict: false })
  from?: string;

  @IsOptional()
  @IsISO8601({ strict: false })
  to?: string;

  // Any UUID version (seeded/historical actor ids may be non-v4) — 1H lesson.
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsIn(ACTOR_TYPES)
  actorType?: ActorTypeFilter;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  resourceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  requestId?: string;

  // Only 'csv' this phase; 'xlsx' is rejected (400) until the §4 decision.
  @IsOptional()
  @IsIn(EXPORT_FORMATS)
  format?: ExportFormat;
}
