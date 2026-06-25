import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReportsService, RequestActor } from './reports.service';
import { ReportsExportService } from './reports-export.service';
import { ReportSummaryQuery } from './dto/report-summary.query';
import { ReportSummaryExportQuery } from './dto/report-summary-export.query';
import { sendExportFile } from '../common/export-response';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/reports')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly reportsExport: ReportsExportService,
  ) {}

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

  // CSV export of the same summaries (plan §3). Same query + perm as the JSON
  // endpoints; @Res so we stream the file ourselves with download headers.
  @Get('sales-summary/export')
  @RequirePermission('reports', 'view')
  async exportSalesSummary(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ReportSummaryExportQuery,
    @Res() res: Response,
  ) {
    const file = await this.reportsExport.exportSummary('sales', this.actor(user, req), query);
    sendExportFile(res, file);
  }

  @Get('purchase-summary/export')
  @RequirePermission('reports', 'view')
  async exportPurchaseSummary(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ReportSummaryExportQuery,
    @Res() res: Response,
  ) {
    const file = await this.reportsExport.exportSummary('purchase', this.actor(user, req), query);
    sendExportFile(res, file);
  }
}
