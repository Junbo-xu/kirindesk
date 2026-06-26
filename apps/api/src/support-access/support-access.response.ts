import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * Response shaping for support-access grants (plan §3.3). A grant is a
 * governance credential, not business data: the shape carries the
 * authorization terms (who/why/scope/when) and lifecycle stamps, plus the
 * platform admin's email (joined from platform_admins, a global no-RLS table)
 * so the tenant sees who they authorized without a second lookup.
 */

export interface SupportAccessGrantRow {
  id: string;
  tenant_id: string;
  platform_admin_id: string;
  platform_admin_email: string | null;
  scope: string;
  reason: string;
  status: string;
  expires_at: Date;
  granted_by_user_id: string;
  approved_at: Date | null;
  revoked_by_user_id: string | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SupportAccessGrantSummary {
  id: string;
  tenantId: string;
  platformAdminId: string;
  platformAdminEmail: string | null;
  scope: string;
  reason: string;
  status: string;
  expiresAt: Date;
  grantedByUserId: string;
  approvedAt: Date | null;
  revokedByUserId: string | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// Columns for the tenant-side grant list/detail. platform_admin_email comes from
// a LEFT JOIN on platform_admins (global table, no RLS).
export const GRANT_COLUMNS = `g.id, g.tenant_id, g.platform_admin_id, pa.email AS platform_admin_email,
       g.scope, g.reason, g.status, g.expires_at, g.granted_by_user_id, g.approved_at,
       g.revoked_by_user_id, g.revoked_at, g.revoke_reason, g.created_at, g.updated_at`;

export const GRANT_ADMIN_JOIN = `LEFT JOIN platform_admins pa ON pa.id = g.platform_admin_id`;

// Bare columns (no `g.` qualifier, no joined email) for INSERT ... RETURNING,
// where no platform_admins join is available. The caller backfills the email.
export const GRANT_RETURNING_COLUMNS = `id, tenant_id, platform_admin_id, scope, reason, status,
       expires_at, granted_by_user_id, approved_at, revoked_by_user_id, revoked_at,
       revoke_reason, created_at, updated_at`;

export function toSupportAccessGrantSummary(row: SupportAccessGrantRow): SupportAccessGrantSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    platformAdminId: row.platform_admin_id,
    platformAdminEmail: row.platform_admin_email,
    scope: row.scope,
    reason: row.reason,
    status: row.status,
    expiresAt: row.expires_at,
    grantedByUserId: row.granted_by_user_id,
    approvedAt: row.approved_at,
    revokedByUserId: row.revoked_by_user_id,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Raised when a grant is not visible to the caller — wrong tenant (RLS empty
 * set) or non-existent. Opaque 404 (never reveals existence across tenants).
 */
export class SupportAccessGrantNotFoundException extends NotFoundException {
  constructor() {
    super('Support access grant not found');
  }
}

/** Raised when revoking a grant that is already revoked (plan §3.2). */
export class SupportAccessGrantAlreadyRevokedException extends ConflictException {
  constructor() {
    super('Support access grant is already revoked');
  }
}

/**
 * Raised when an active grant already exists for the same (admin, tenant) pair
 * (plan §3.3) — the terms are frozen, so widening requires revoke-then-regrant.
 * The partial-unique index uq_sag_one_active backstops this at the DB layer.
 */
export class SupportAccessGrantAlreadyActiveException extends ConflictException {
  constructor() {
    super('An active support access grant already exists for this platform admin');
  }
}
