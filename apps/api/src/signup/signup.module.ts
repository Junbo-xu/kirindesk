import { Module } from '@nestjs/common';
import { PlatformTenantsModule } from '../platform-tenants/platform-tenants.module';
import { RedisModule } from '../redis/redis.module';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';
import { SignupRateLimitGuard } from './signup-rate-limit.guard';

/**
 * Phase 2B: public tenant self-service registration. Reuses
 * TenantOnboardingService (exported by PlatformTenantsModule) rather than
 * duplicating the atomic provisioning transaction. RedisModule supplies the
 * IP rate limiter (RedisModule is @Global, but importing it here is explicit).
 */
@Module({
  imports: [PlatformTenantsModule, RedisModule],
  controllers: [SignupController],
  providers: [SignupService, SignupRateLimitGuard],
})
export class SignupModule {}
