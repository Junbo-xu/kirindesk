import { createHash } from 'node:crypto';

export function canonicalizeJson(obj: unknown): string {
  if (obj === null || obj === undefined) return '';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalizeJson).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const parts = keys.map(
    (k) => JSON.stringify(k) + ':' + canonicalizeJson((obj as Record<string, unknown>)[k]),
  );
  return '{' + parts.join(',') + '}';
}

export interface AuditLogHashInput {
  hash_version: number;
  prev_hash: string;
  tenant_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_json: unknown;
  after_json: unknown;
  metadata_json: unknown;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  reason: string | null;
  created_at: Date;
}

export function computeRowHash(row: AuditLogHashInput): string {
  const parts = [
    String(row.hash_version),
    row.prev_hash,
    row.tenant_id ?? '',
    row.actor_type,
    row.actor_id ?? '',
    row.action,
    row.resource_type,
    row.resource_id ?? '',
    canonicalizeJson(row.before_json),
    canonicalizeJson(row.after_json),
    canonicalizeJson(row.metadata_json),
    row.request_id ?? '',
    row.ip_address ?? '',
    row.user_agent ?? '',
    row.reason ?? '',
    row.created_at.toISOString(),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
