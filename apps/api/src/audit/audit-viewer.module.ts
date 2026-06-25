import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from './audit.module';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';

/**
 * Read-only audit-log viewer module (plan §3). Kept SEPARATE from the write-side
 * AuditModule: AuditModule is a leaf imported by RbacModule/AuthModule for the
 * write path, so importing those guards back into AuditModule would form a
 * cycle. This module imports them cleanly (mirroring ReportsModule:
 * RbacModule + AuditModule + AuthModule) and ships only the read controller +
 * AuditQueryService. AuditModule is imported because the shared PermissionGuard
 * depends on AuditService, which AuditModule exports; AuditQueryService itself
 * never touches it — viewing never writes audit. APP_POOL comes from the global
 * DatabaseModule.
 */
@Module({
  imports: [RbacModule, AuditModule, AuthModule],
  controllers: [AuditController],
  providers: [AuditQueryService],
})
export class AuditViewerModule {}
