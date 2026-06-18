/**
 * Response shaping for AI/OCR invocations (plan §7.4). Read endpoints must never
 * return the raw provider_invocations row: request_json / response_json hold
 * internal summaries that are not part of the API contract. List/detail expose
 * only the operational summary fields. The full OCR text / AI output is returned
 * live at process time but is never persisted (plan §5.3), so it is absent here.
 */

export interface InvocationRow {
  id: string;
  tenant_id: string;
  provider_type: string;
  provider_name: string;
  action: string;
  status: string;
  duration_ms: number | null;
  tokens_used: number | null;
  source_file_id: string | null;
  invoked_by: string;
  created_at: Date;
}

export interface InvocationSummary {
  id: string;
  providerType: string;
  providerName: string;
  action: string;
  status: string;
  durationMs: number | null;
  tokensUsed: number | null;
  sourceFileId: string | null;
  createdAt: Date;
}

export function toInvocationSummary(row: InvocationRow): InvocationSummary {
  return {
    id: row.id,
    providerType: row.provider_type,
    providerName: row.provider_name,
    action: row.action,
    status: row.status,
    durationMs: row.duration_ms,
    tokensUsed: row.tokens_used,
    sourceFileId: row.source_file_id,
    createdAt: row.created_at,
  };
}
