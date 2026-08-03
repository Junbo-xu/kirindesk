import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { BusinessEventsService } from './business-events.service';
import { BusinessExceptionsService } from './business-exceptions.service';
import { WorkbenchController } from './workbench.controller';
import { WorkbenchService } from './workbench.service';

@Module({
  imports: [AuthModule, RbacModule, AuditModule],
  controllers: [WorkbenchController],
  providers: [WorkbenchService, BusinessEventsService, BusinessExceptionsService],
  exports: [BusinessEventsService, BusinessExceptionsService],
})
export class WorkbenchModule {}
