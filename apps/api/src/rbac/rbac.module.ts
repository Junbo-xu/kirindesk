import { Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { PermissionGuard } from './permission.guard';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [RbacService, PermissionGuard],
  exports: [RbacService, PermissionGuard],
})
export class RbacModule {}
