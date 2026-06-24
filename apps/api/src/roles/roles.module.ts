import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { PermissionsController } from './permissions.controller';
import { RolesService } from './roles.service';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  // AuthModule provides TenantAuthGuard; RbacModule the PermissionGuard +
  // RbacService (subset guard); AuditModule the audit double-write. No cycle
  // here (AuthModule does not import RolesModule), so no forwardRef needed.
  imports: [RbacModule, AuditModule, AuthModule],
  controllers: [RolesController, PermissionsController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
