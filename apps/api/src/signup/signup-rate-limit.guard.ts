import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimitService } from '../redis/rate-limit.service';

/**
 * Phase 2B: IP rate limiting for anonymous self-service signup.
 *
 * Defaults: 5 signups / IP / hour. Overridable via SIGNUP_RATE_LIMIT_MAX and
 * SIGNUP_RATE_LIMIT_WINDOW_SEC. On limit breach → 429 with Retry-After.
 *
 * Client IP: X-Forwarded-For is only trusted when TRUST_PROXY=true (i.e. behind
 * a known proxy); otherwise it is spoofable and we use the socket address. This
 * matters because the IP is the rate-limit key — trusting an attacker-supplied
 * header would let one client masquerade as many.
 */
@Injectable()
export class SignupRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimit: RateLimitService) {}

  private clientIp(req: Request): string {
    if (process.env.TRUST_PROXY === 'true') {
      const xff = req.headers['x-forwarded-for'];
      const value = Array.isArray(xff) ? xff[0] : xff;
      const first = value?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = this.clientIp(req);

    const max = Number(process.env.SIGNUP_RATE_LIMIT_MAX ?? 5);
    const windowSec = Number(process.env.SIGNUP_RATE_LIMIT_WINDOW_SEC ?? 3600);

    const result = await this.rateLimit.consume('signup', ip, max, windowSec);
    if (!result.allowed) {
      const res = context.switchToHttp().getResponse<Response>();
      res.setHeader('Retry-After', String(result.retryAfterSec));
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: '注册过于频繁，请稍后再试' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
