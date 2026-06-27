import { Global, Module } from '@nestjs/common';
import { SubscriptionController } from './subscription.controller';
import { PlatformSubscriptionController } from './platform-subscription.controller';
import { SubscriptionService } from './subscription.service';
import { QuotaService } from './quota.service';
import { QuotaGuard } from './quota.guard';
import { ModuleGuard } from './module.guard';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [SubscriptionController, PlatformSubscriptionController],
  providers: [SubscriptionService, QuotaService, QuotaGuard, ModuleGuard],
  exports: [QuotaService, QuotaGuard, ModuleGuard],
})
export class SubscriptionModule {}
