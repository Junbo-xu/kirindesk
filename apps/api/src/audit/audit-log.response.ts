import { NotFoundException } from '@nestjs/common';

/**
 * Response shaping for the audit-log viewer (plan §3.3). The viewer is a pure
 * read consumer of audit_logs: it exposes the event identity + before/after/
 * metadata snapshots, and deliberately omits the hash-chain internals
 * (row_hash / prev_hash / hash_version) — those carry no meaning for an end
 * user, and chain trust is conveyed by the aggregate verify endpoint, not by
 * feeding the chain internals to the UI (plan §3.3/§4.1.5/§5.4). `id` is a
 * bigint surfaced as a string to avoid JS number precision loss.
 */

export interface AuditLogRow {
  id: string; // bigint as text from pg (selected as id::text)
  tenant_id: string | null;
  actor_type: string;
  actor_id: string;
  actor_name: string | null; // LEFT JOIN users.name for tenant_user actors, else null
  action: string;
  resource_type: string;
  resource_id: string | null;
  created_at: Date;
  // Detail-only columns (absent from list rows):
  before_json?: unknown;
  after_json?: unknown;
  metadata_json?: unknown;
  reason?: string | null;
  request_id?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
}

export interface AuditLogSummary {
  id: string;
  tenantId: string | null;
  actorType: string;
  actorId: string;
  actorName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  createdAt: Date;
}

export interface AuditLogDetail extends AuditLogSummary {
  before: unknown;
  after: unknown;
  metadata: unknown;
  reason: string | null;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export function toAuditLogSummary(row: AuditLogRow): AuditLogSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    createdAt: row.created_at,
  };
}

export function toAuditLogDetail(row: AuditLogRow): AuditLogDetail {
  return {
    ...toAuditLogSummary(row),
    // before/after/metadata are returned as the stored jsonb, unmodified — the
    // viewer never re-parses, rewrites, or enriches them (plan §3.3/§4.1.5).
    before: row.before_json ?? null,
    after: row.after_json ?? null,
    metadata: row.metadata_json ?? null,
    reason: row.reason ?? null,
    requestId: row.request_id ?? null,
    ipAddress: row.ip_address ?? null,
    userAgent: row.user_agent ?? null,
  };
}

/**
 * Raised when an audit-log id is not visible to the caller — wrong tenant, out
 * of dataScope, or non-existent. Deliberately opaque (one 404 for all) so
 * existence is never revealed across tenant / scope boundaries (plan §4.1.1).
 */
export class AuditLogNotFoundException extends NotFoundException {
  constructor() {
    super('Audit log not found');
  }
}
