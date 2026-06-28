import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SignupService } from './signup.service';
import { SignupDto } from './dto/signup.dto';
import { SignupRateLimitGuard } from './signup-rate-limit.guard';

/**
 * Phase 2B: public, unauthenticated tenant self-service registration.
 *
 * No guard — this is the one tenant-side route that anonymous callers may hit.
 * TenantStatusMiddleware no-ops without a bearer token, so the request reaches
 * this handler. Abuse protection (Redis IP rate limiting) is added in the next
 * sub-step; this skeleton intentionally has none yet.
 */
@Controller('api/auth/signup')
@UseGuards(SignupRateLimitGuard)
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Post()
  @HttpCode(201)
  async register(@Body() dto: SignupDto) {
    return this.signup.register(dto);
  }
}
