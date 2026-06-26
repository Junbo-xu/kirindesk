import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { AuditViewerModule } from '../audit/audit-viewer.module';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';
import { UsersModule } from '../users/users.module';
import { RolesModule } from '../roles/roles.module';
import { SupportAccessController } from './support-access.controller';
import { SupportAccessService } from './support-access.service';
import { PlatformSupportController } from './platform-support.controller';
import { PlatformSupportService } from './platform-support.service';
import { SupportAccessGuard } from './support-access.guard';

/**
 * Phase 1K-B support access. Two faces (plan §3):
 *   - Tenant side (SupportAccessController): TenantAuthGuard (AuthModule) +
 *     PermissionGuard (RbacModule), audited via AuditModule. The customer
 *     authorizes/revokes named platform admins.
 *   - Platform side (PlatformSupportController): PlatformAuthGuard
 *     (PlatformAuthModule) + SupportAccessGuard, reusing AuditViewerModule's
 *     AuditQueryService and UsersModule/RolesModule read services under a
 *     platform_admin actor (plan §3.4). Reads are audited (support_access.
 *     accessed) via AuditModule; no second query implementation.
 * No cycle: none of these modules import SupportAccessModule. APP_POOL comes
 * from the global DatabaseModule.
 */
@Module({
  imports: [
    AuthModule,
    RbacModule,
    AuditModule,
    AuditViewerModule,
    PlatformAuthModule,
    UsersModule,
    RolesModule,
  ],
  controllers: [SupportAccessController, PlatformSupportController],
  providers: [SupportAccessService, PlatformSupportService, SupportAccessGuard],
})
export class SupportAccessModule {}
