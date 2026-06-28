import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { AuditModule } from '../audit/audit.module';
import { PlatformTenantsController } from './platform-tenants.controller';
import { PlatformTenantsService } from './platform-tenants.service';
import { TenantOnboardingService } from './tenant-onboarding.service';

@Module({
  imports: [PlatformAuthModule, AuditModule],
  controllers: [PlatformTenantsController],
  providers: [PlatformTenantsService, TenantOnboardingService],
  exports: [TenantOnboardingService],
})
export class PlatformTenantsModule {}
