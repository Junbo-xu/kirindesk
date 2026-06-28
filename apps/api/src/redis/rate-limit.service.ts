import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

export interface RateLimitResult {
  allowed: boolean;
  /** Current hit count within the window (0 when limiting is disabled). */
  count: number;
  /** Seconds until the current window resets (0 when disabled/unknown). */
  retryAfterSec: number;
}

/**
 * Fixed-window IP rate limiter backed by Redis (Phase 2B).
 *
 * Fail-open by design: rate limiting is abuse mitigation, not a security
 * boundary (tenant isolation is RLS-based). If Redis is absent or unreachable,
 * consume() allows the request and logs a warning — a degraded limiter must
 * never take down a public endpoint. The hard guarantees (slug/email
 * uniqueness, RLS) hold regardless.
 *
 * Fixed window via INCR + EXPIRE-on-first-hit: simple and debuggable. A burst
 * straddling a window boundary can briefly allow up to 2x max; acceptable for
 * signup abuse mitigation (per approved scope).
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async consume(
    bucket: string,
    identifier: string,
    max: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    if (!this.redis) {
      // No Redis configured (e.g. integration tests, or REDIS_URL unset).
      return { allowed: true, count: 0, retryAfterSec: 0 };
    }
    const key = `ratelimit:${bucket}:${identifier}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        // First hit in this window — set the TTL.
        await this.redis.expire(key, windowSec);
      }
      if (count > max) {
        const ttl = await this.redis.ttl(key);
        return { allowed: false, count, retryAfterSec: ttl > 0 ? ttl : windowSec };
      }
      return { allowed: true, count, retryAfterSec: 0 };
    } catch (err) {
      // Fail open: a broken limiter must not break the endpoint.
      this.logger.warn(
        `Rate limit check failed for ${bucket}:${identifier}; allowing request. ${
          (err as Error).message
        }`,
      );
      return { allowed: true, count: 0, retryAfterSec: 0 };
    }
  }
}
