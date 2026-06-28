import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { PlatformAuthGuard } from '../platform-auth/platform-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SubscriptionService } from './subscription.service';
import { AssignPlanDto } from './dto/assign-plan.dto';

interface PlatformJwtUser {
  sub: string;
  email: string;
}

@Controller()
@UseGuards(PlatformAuthGuard)
export class PlatformSubscriptionController {
  constructor(private readonly subscription: SubscriptionService) {}

  @Get('api/platform/plans')
  listPlans() {
    return this.subscription.getAllPlans();
  }

  @Get('api/platform/tenants/:id/subscription')
  getTenantPlan(@Param('id') id: string) {
    return this.subscription.getTenantPlan(id);
  }

  @Put('api/platform/tenants/:id/subscription')
  assignPlan(
    @Param('id') id: string,
    @Body() dto: AssignPlanDto,
    @CurrentUser() user: PlatformJwtUser,
  ) {
    return this.subscription.assignPlan(id, dto, user.sub);
  }
}
