import { Module } from '@nestjs/common';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { AuditModule } from '../audit/audit.module';
import { PlatformTenantsController } from './platform-tenants.controller';
import { PlatformTenantsService } from './platform-tenants.service';

/**
 * Platform tenant lifecycle (1K-A). Imports PlatformAuthModule for the
 * PlatformAuthGuard and AuditModule for the status-change audit. APP_POOL comes
 * from the global DatabaseModule.
 */
@Module({
  imports: [PlatformAuthModule, AuditModule],
  controllers: [PlatformTenantsController],
  providers: [PlatformTenantsService],
})
export class PlatformTenantsModule {}
