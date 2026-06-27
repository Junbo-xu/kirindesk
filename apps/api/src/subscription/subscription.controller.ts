import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SubscriptionService } from './subscription.service';

interface TenantJwtUser { sub: string; tenantId: string }

@Controller()
@UseGuards(TenantAuthGuard)
export class SubscriptionController {
  constructor(private readonly subscription: SubscriptionService) {}

  @Get('api/subscription')
  get(@CurrentUser() user: TenantJwtUser) {
    return this.subscription.getForTenant(user.tenantId, user.sub);
  }

  // Phase 2C mobile alias (plan §4.2) — identical response, separate path.
  @Get('api/mobile/v1/subscription')
  getMobile(@CurrentUser() user: TenantJwtUser) {
    return this.subscription.getForTenant(user.tenantId, user.sub);
  }
}
