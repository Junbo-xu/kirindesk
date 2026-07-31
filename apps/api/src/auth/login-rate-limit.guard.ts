import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { RateLimitService } from '../redis/rate-limit.service';
import { AuditService } from '../audit/audit.service';
import { APP_POOL } from '../database/database.module';
import type { Pool } from 'pg';

const LOGIN_RATE_LIMIT_BUCKET = 'login_rate_limit_bucket';

export const LoginRateLimit = (bucket: 'tenant' | 'platform') =>
  SetMetadata(LOGIN_RATE_LIMIT_BUCKET, bucket);

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    @Inject(APP_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.get<'tenant' | 'platform'>(
      LOGIN_RATE_LIMIT_BUCKET,
      context.getHandler(),
    );
    if (!bucket) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const body = request.body as { email?: string; tenantSlug?: string };
    const ip = this.clientIp(request);
    const identity = createHash('sha256')
      .update(
        `${bucket}:${body.tenantSlug?.trim().toLowerCase() ?? ''}:${body.email?.trim().toLowerCase() ?? ''}`,
      )
      .digest('hex');
    const max = this.positiveInteger('LOGIN_RATE_LIMIT_MAX', 5);
    const windowSec = this.positiveInteger('LOGIN_RATE_LIMIT_WINDOW_SEC', 900);

    const [ipResult, identityResult] = await Promise.all([
      this.rateLimit.consume(`login:${bucket}:ip`, ip, max, windowSec, { failClosed: true }),
      this.rateLimit.consume(`login:${bucket}:identity`, identity, max, windowSec, {
        failClosed: true,
      }),
    ]);
    if (!ipResult.allowed || !identityResult.allowed) {
      const retryAfter = Math.max(ipResult.retryAfterSec, identityResult.retryAfterSec, 1);
      if (ipResult.count === max + 1 || identityResult.count === max + 1) {
        await this.auditFirstLimitBreach(bucket, body.tenantSlug, identity, ip, request).catch(
          () => undefined,
        );
      }
      context.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: '登录尝试过于频繁，请稍后再试' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private clientIp(request: Request): string {
    if (process.env.TRUST_PROXY === 'true') {
      const forwarded = request.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const first = value?.split(',')[0]?.trim();
      if (first) return first;
    }
    return request.ip || request.socket?.remoteAddress || 'unknown';
  }

  private positiveInteger(name: string, fallback: number): number {
    const parsed = Number(process.env[name] ?? fallback);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private async auditFirstLimitBreach(
    bucket: 'tenant' | 'platform',
    tenantSlug: string | undefined,
    identityHash: string,
    ip: string,
    request: Request,
  ): Promise<void> {
    let tenantId: string | null = null;
    if (bucket === 'tenant' && tenantSlug) {
      const result = await this.pool.query<{ id: string }>(
        `SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL`,
        [tenantSlug],
      );
      tenantId = result.rows[0]?.id ?? null;
    }
    await this.audit
      .log({
        tenantId,
        actorType: bucket === 'platform' ? 'platform_admin' : 'tenant_user',
        actorId: '00000000-0000-0000-0000-000000000000',
        action: 'auth:login_rate_limited',
        resourceType: 'authentication',
        metadata: { bucket, identityHash },
        ipAddress: ip,
        userAgent: request.headers['user-agent'],
      })
      .catch(() => undefined);
  }
}
