import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReportsService, RequestActor } from './reports.service';
import { ReportSummaryQuery } from './dto/report-summary.query';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/reports')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get('sales-summary')
  @RequirePermission('reports', 'view')
  async salesSummary(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ReportSummaryQuery,
  ) {
    return this.reportsService.salesSummary(this.actor(user, req), query);
  }

  @Get('purchase-summary')
  @RequirePermission('reports', 'view')
  async purchaseSummary(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ReportSummaryQuery,
  ) {
    return this.reportsService.purchaseSummary(this.actor(user, req), query);
  }
}
