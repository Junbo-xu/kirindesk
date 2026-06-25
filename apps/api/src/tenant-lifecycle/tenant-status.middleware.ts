import { ForbiddenException, Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Pool } from 'pg';
import type { Request, Response, NextFunction } from 'express';
import { APP_POOL } from '../database/database.module';

/**
 * Global tenant-status gate (plan §3.6). Runs before the route guards and
 * blocks any request carrying a valid tenant JWT whose tenant is not 'active'
 * — enforcing tenant suspension/deactivation for already-issued tokens (login
 * itself already refuses non-active tenants in AuthService).
 *
 * It deliberately verifies the bearer with the TENANT secret and no-ops on
 * anything that is not a valid tenant token: platform tokens (different secret)
 * and unauthenticated requests fall through untouched, so the route's own
 * guards still handle 401 and platform endpoints are never tenant-status-gated.
 */
@Injectable()
export class TenantStatusMiddleware implements NestMiddleware {
  constructor(
    @Inject(APP_POOL) private readonly pool: Pool,
    private readonly jwt: JwtService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return next();
    }

    let payload: { type?: string; tenantId?: string };
    try {
      payload = this.jwt.verify(auth.slice(7));
    } catch {
      // Not a valid tenant token (platform token / expired / malformed) — let
      // the route guard deal with authentication.
      return next();
    }
    if (payload.type !== 'tenant_user' || !payload.tenantId) {
      return next();
    }

    const { rows } = await this.pool.query<{ status: string }>(
      `SELECT status FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
      [payload.tenantId],
    );
    if (rows[0]?.status !== 'active') {
      throw new ForbiddenException('租户已停用');
    }
    next();
  }
}
