import { Module } from '@nestjs/common';
import { PlatformTenantsModule } from '../platform-tenants/platform-tenants.module';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';

/**
 * Phase 2B: public tenant self-service registration. Reuses
 * TenantOnboardingService (exported by PlatformTenantsModule) rather than
 * duplicating the atomic provisioning transaction.
 */
@Module({
  imports: [PlatformTenantsModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule {}
