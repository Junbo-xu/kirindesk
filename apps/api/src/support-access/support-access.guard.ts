import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { APP_POOL } from '../database/database.module';

// Stashed on the request by the guard so the controller knows WHICH grant
// authorized the read (for the support_access.accessed audit resourceId) and
// the scope. Never trusts client input — populated only from a valid grant.
export interface SupportGrant {
  grantId: string;
  scope: string;
  tenantId: string;
}

export type RequestWithSupportGrant = Request & { supportGrant?: SupportGrant };

// Any UUID version (seeded tenants may use synthetic non-v4 UUIDs, as the 1H/1I
// work documented). Used only to reject obviously-malformed ids before the
// uuid-typed DEFINER call — not a security check (the grant lookup is).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-request authorization check for platform-side support reads (plan §3.4).
 * Runs AFTER PlatformAuthGuard, on routes carrying a :tenantId param. Takes the
 * authenticated platform admin id from the JWT (req.user.sub) — NEVER from a
 * client-supplied field (§4 escalation guard) — and the route :tenantId, and
 * calls the SECURITY DEFINER app_check_support_access(adminId, tenantId), which
 * internally requires status='active' AND now() < expires_at. No valid grant →
 * 403 (default deny). On success it stashes { grantId, scope, tenantId } on the
 * request and lets the read proceed.
 */
@Injectable()
export class SupportAccessGuard implements CanActivate {
  constructor(@Inject(APP_POOL) private readonly pool: Pool) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSupportGrant>();
    const user = request.user as { sub?: string; type?: string } | undefined;
    if (!user || user.type !== 'platform_admin' || !user.sub) {
      throw new ForbiddenException('Support access denied');
    }

    const tenantId = request.params?.tenantId;
    if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
      // A missing or malformed tenant id can never match a grant — deny
      // (and avoid passing a non-uuid into the uuid-typed DEFINER function).
      throw new ForbiddenException('Support access denied');
    }

    const { rows } = await this.pool.query<{ grant_id: string; scope: string }>(
      `SELECT grant_id, scope FROM app_check_support_access($1, $2)`,
      [user.sub, tenantId],
    );
    if (rows.length === 0) {
      throw new ForbiddenException('Support access denied');
    }

    request.supportGrant = { grantId: rows[0].grant_id, scope: rows[0].scope, tenantId };
    return true;
  }
}
