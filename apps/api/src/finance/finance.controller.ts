import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { ModuleGuard, RequireModule } from '../subscription/module.guard';
import {
  CalculateCommissionCandidateDto,
  CreateFinanceReviewDto,
  CreateProfitSnapshotDto,
  LockCommissionCandidateDto,
  ReplaceCommissionRulesDto,
} from './dto/finance.dto';
import { FinanceActor, FinanceService } from './finance.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/finance')
@UseGuards(TenantAuthGuard, PermissionGuard, ModuleGuard)
@RequireModule('finance')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  private actor(user: TenantJwtUser, req: Request): FinanceActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get('orders')
  @RequirePermission('finance_reviews', 'view')
  listOrders(@CurrentUser() user: TenantJwtUser, @Req() req: Request): Promise<unknown> {
    return this.finance.listOrders(this.actor(user, req));
  }

  @Get('orders/:id')
  @RequirePermission('finance_reviews', 'view')
  getOrder(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return this.finance.getOrder(this.actor(user, req), id);
  }

  @Post('orders/:id/reviews')
  @RequirePermission('finance_reviews', 'review')
  createReview(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateFinanceReviewDto,
  ): Promise<unknown> {
    return this.finance.createReview(this.actor(user, req), id, dto);
  }

  @Post('orders/:id/profit-snapshots')
  @RequirePermission('profit_snapshots', 'create')
  createProfitSnapshot(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProfitSnapshotDto,
  ): Promise<unknown> {
    return this.finance.createProfitSnapshot(this.actor(user, req), id, dto);
  }

  @Get('commission-rules')
  @RequirePermission('finance_reviews', 'view')
  getCommissionRules(@CurrentUser() user: TenantJwtUser, @Req() req: Request): Promise<unknown> {
    return this.finance.getCommissionRules(this.actor(user, req));
  }

  @Put('commission-rules')
  @RequirePermission('commission_rules', 'manage')
  replaceCommissionRules(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: ReplaceCommissionRulesDto,
  ): Promise<unknown> {
    return this.finance.replaceCommissionRules(this.actor(user, req), dto);
  }

  @Post('orders/:id/commission-candidates')
  @RequirePermission('commission_candidates', 'calculate')
  calculateCandidate(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CalculateCommissionCandidateDto,
  ): Promise<unknown> {
    return this.finance.calculateCandidate(this.actor(user, req), id, dto);
  }

  @Post('commission-candidates/:id/lock')
  @HttpCode(200)
  @RequirePermission('commission_candidates', 'lock')
  lockCandidate(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LockCommissionCandidateDto,
  ): Promise<unknown> {
    return this.finance.lockCandidate(this.actor(user, req), id, dto);
  }
}
