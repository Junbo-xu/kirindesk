import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkbenchModule } from '../workbench/workbench.module';
import { FulfillmentController } from './fulfillment.controller';
import { FulfillmentService } from './fulfillment.service';

@Module({
  imports: [AuthModule, RbacModule, AuditModule, FilesModule, WorkbenchModule],
  controllers: [FulfillmentController],
  providers: [FulfillmentService],
})
export class FulfillmentModule {}
