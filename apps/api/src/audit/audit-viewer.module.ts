import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from './audit.module';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';
import { AuditExportService } from './audit-export.service';

/**
 * Read-only audit-log viewer + export module (plan §3). Kept SEPARATE from the
 * write-side AuditModule: AuditModule is a leaf imported by RbacModule/AuthModule
 * for the write path, so importing those guards back into AuditModule would form
 * a cycle. This module imports them cleanly (mirroring ReportsModule:
 * RbacModule + AuditModule + AuthModule). AuditModule (exporting AuditService) is
 * imported both for the shared PermissionGuard and for AuditExportService, which
 * writes one audit event per export (1J §5.2) — viewing/listing still never
 * writes audit. APP_POOL comes from the global DatabaseModule.
 */
@Module({
  imports: [RbacModule, AuditModule, AuthModule],
  controllers: [AuditController],
  providers: [AuditQueryService, AuditExportService],
  // AuditQueryService is exported so the platform support-access module (1K-B)
  // can reuse its read-only list/getOne/verifyTenantChain under a
  // platform_admin actor (plan §3.4) — no second audit query implementation.
  exports: [AuditQueryService],
})
export class AuditViewerModule {}
