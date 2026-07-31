import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';
import { AiModule } from '../ai/ai.module';
import { RbacModule } from '../rbac/rbac.module';
import { InquiriesController } from './inquiries.controller';
import { QuoteTasksController } from './quote-tasks.controller';
import { QuotationsController } from './quotations.controller';
import { InquiriesService } from './inquiries.service';
import { QuotationsService } from './quotations.service';

@Module({
  imports: [AuthModule, AuditModule, AiModule, RbacModule],
  controllers: [InquiriesController, QuoteTasksController, QuotationsController],
  providers: [InquiriesService, QuotationsService],
})
export class InquiriesModule {}
