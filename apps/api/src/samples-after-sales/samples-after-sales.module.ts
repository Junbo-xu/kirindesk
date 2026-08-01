import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CommercialModule } from '../commercial/commercial.module';
import { FinanceModule } from '../finance/finance.module';
import { RbacModule } from '../rbac/rbac.module';
import { WorkbenchModule } from '../workbench/workbench.module';
import { SamplesAfterSalesController } from './samples-after-sales.controller';
import { SamplesAfterSalesService } from './samples-after-sales.service';

@Module({
  imports: [AuthModule, RbacModule, AuditModule, WorkbenchModule, CommercialModule, FinanceModule],
  controllers: [SamplesAfterSalesController],
  providers: [SamplesAfterSalesService],
})
export class SamplesAfterSalesModule {}
