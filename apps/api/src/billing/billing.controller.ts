import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BillingActor, BillingService } from './billing.service';
import { ListInvoicesQuery } from './dto/list-invoices.query';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/billing')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  private actor(user: TenantJwtUser, req: Request): BillingActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get('invoices')
  @RequirePermission('billing', 'view')
  list(@CurrentUser() user: TenantJwtUser, @Req() req: Request, @Query() query: ListInvoicesQuery) {
    return this.billing.list(this.actor(user, req), query);
  }

  @Get('invoices/:id')
  @RequirePermission('billing', 'view')
  getOne(@CurrentUser() user: TenantJwtUser, @Req() req: Request, @Param('id') id: string) {
    return this.billing.getOne(this.actor(user, req), id);
  }

  @Post('invoices/:id/pay')
  @HttpCode(200)
  @RequirePermission('billing', 'pay')
  pay(@CurrentUser() user: TenantJwtUser, @Req() req: Request, @Param('id') id: string) {
    return this.billing.pay(this.actor(user, req), id);
  }
}
