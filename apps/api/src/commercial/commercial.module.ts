import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkbenchModule } from '../workbench/workbench.module';
import {
  CommercialFinanceController,
  CommercialOrdersController,
  CommercialSettingsController,
} from './commercial.controller';
import { CommercialService } from './commercial.service';

@Module({
  imports: [AuthModule, RbacModule, AuditModule, WorkbenchModule],
  controllers: [
    CommercialOrdersController,
    CommercialFinanceController,
    CommercialSettingsController,
  ],
  providers: [CommercialService],
  exports: [CommercialService],
})
export class CommercialModule {}
