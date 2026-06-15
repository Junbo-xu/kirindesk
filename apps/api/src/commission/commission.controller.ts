import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CommissionService, RequestActor } from './commission.service';
import { CommissionPayoutService } from './commission-payout.service';
import { CommissionQuery } from './dto/commission-query.dto';
import {
  CreateCommissionTableDto,
  ReplaceCommissionRulesDto,
  UpdateCommissionTableDto,
} from './dto/commission-table.dto';
import { CreateSettlementDto, UnlockSettlementDto } from './dto/settlement.dto';
import { CreatePayoutDto, ListPayoutsQuery, PayBatchDto, VoidPayoutDto } from './dto/payout.dto';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/commission')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class CommissionController {
  constructor(
    private readonly commission: CommissionService,
    private readonly payouts: CommissionPayoutService,
  ) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  // ---- Calculation (read-only, derived) --------------------------------------

  @Get('summary')
  @RequirePermission('commission_tables', 'view')
  async summary(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: CommissionQuery,
  ) {
    return this.commission.summary(this.actor(user, req), query);
  }

  @Get('orders')
  @RequirePermission('commission_tables', 'view')
  async orders(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: CommissionQuery,
  ) {
    return this.commission.orders(this.actor(user, req), query);
  }

  // ---- Rate table management (writes, audited) -------------------------------

  @Get('tables')
  @RequirePermission('commission_tables', 'view')
  async listTables(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.commission.listTables(this.actor(user, req));
  }

  @Get('tables/:id')
  @RequirePermission('commission_tables', 'view')
  async getTable(@CurrentUser() user: TenantJwtUser, @Req() req: Request, @Param('id') id: string) {
    return this.commission.getTable(this.actor(user, req), id);
  }

  @Post('tables')
  @RequirePermission('commission_tables', 'lock')
  async createTable(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateCommissionTableDto,
  ) {
    return this.commission.createTable(this.actor(user, req), dto);
  }

  @Patch('tables/:id')
  @RequirePermission('commission_tables', 'lock')
  async updateTable(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateCommissionTableDto,
  ) {
    return this.commission.updateTable(this.actor(user, req), id, dto);
  }

  @Put('tables/:id/rules')
  @RequirePermission('commission_tables', 'lock')
  async replaceRules(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ReplaceCommissionRulesDto,
  ) {
    return this.commission.replaceRules(this.actor(user, req), id, dto);
  }

  // ---- Lock / settle (privileged, audited) -----------------------------------

  @Post('settlements')
  @RequirePermission('commission_tables', 'lock')
  async createSettlement(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateSettlementDto,
  ) {
    return this.commission.createSettlement(this.actor(user, req), dto);
  }

  @Get('settlements')
  @RequirePermission('commission_tables', 'view')
  async listSettlements(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.commission.listSettlements(this.actor(user, req));
  }

  @Get('settlements/:id')
  @RequirePermission('commission_tables', 'view')
  async getSettlement(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return this.commission.getSettlement(this.actor(user, req), id);
  }

  @Post('settlements/:id/unlock')
  @RequirePermission('commission_tables', 'unlock')
  async unlockSettlement(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UnlockSettlementDto,
  ) {
    return this.commission.unlockSettlement(this.actor(user, req), id, dto);
  }

  // ---- Payouts / disbursement (plan §5) --------------------------------------

  // 201 on a fresh create, 200 when an existing live payout is returned
  // idempotently (plan §5.1).
  @Post('payouts')
  @RequirePermission('commission_payouts', 'disburse')
  async createPayout(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: CreatePayoutDto,
  ) {
    const result = await this.payouts.create(this.actor(user, req), dto);
    res.status(result.created ? 201 : 200);
    return result.payout;
  }

  @Get('payouts')
  @RequirePermission('commission_payouts', 'view')
  async listPayouts(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListPayoutsQuery,
  ) {
    return this.payouts.list(this.actor(user, req), query);
  }

  @Get('payouts/:id')
  @RequirePermission('commission_payouts', 'view')
  async getPayout(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return this.payouts.getDetail(this.actor(user, req), id);
  }

  @Post('payouts/:id/lines/:lineId/pay')
  @HttpCode(200)
  @RequirePermission('commission_payouts', 'disburse')
  async payPayoutLine(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
  ) {
    return this.payouts.payLine(this.actor(user, req), id, lineId);
  }

  @Post('payouts/:id/pay')
  @HttpCode(200)
  @RequirePermission('commission_payouts', 'disburse')
  async payPayout(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PayBatchDto,
  ) {
    return this.payouts.payBatch(this.actor(user, req), id, dto);
  }

  @Post('payouts/:id/void')
  @HttpCode(200)
  @RequirePermission('commission_payouts', 'reverse')
  async voidPayout(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: VoidPayoutDto,
  ) {
    return this.payouts.void(this.actor(user, req), id, dto);
  }
}
