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
import {
  CreateProcurementRequestDto,
  DecideProcurementRequestDto,
  PlacePurchaseOrderDto,
  UpdateProcurementApprovalConfigDto,
  WithdrawProcurementRequestDto,
} from './dto/procurement.dto';
import { ProcurementActor, ProcurementService } from './procurement.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  private actor(user: TenantJwtUser, req: Request): ProcurementActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get('procurement/approval-config')
  @RequirePermission('procurement', 'approve')
  getApprovalConfig(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.procurement.getApprovalConfig(this.actor(user, req));
  }

  @Put('procurement/approval-config')
  @RequirePermission('procurement', 'approve')
  updateApprovalConfig(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: UpdateProcurementApprovalConfigDto,
  ) {
    return this.procurement.updateApprovalConfig(this.actor(user, req), dto);
  }

  @Post('sales-orders/:id/procurement-requests')
  @RequirePermission('procurement', 'create')
  createRequest(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProcurementRequestDto,
  ) {
    return this.procurement.createRequest(this.actor(user, req), id, dto);
  }

  @Get('sales-orders/:id/procurement-requests')
  @RequirePermission('procurement', 'view')
  listRequests(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.procurement.listRequests(this.actor(user, req), id);
  }

  @Get('procurement-requests/:id')
  @RequirePermission('procurement', 'view')
  getRequest(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.procurement.getRequest(this.actor(user, req), id);
  }

  @Post('procurement-requests/:id/decisions')
  @RequirePermission('procurement', 'approve')
  @HttpCode(200)
  decideRequest(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideProcurementRequestDto,
  ) {
    return this.procurement.decideRequest(this.actor(user, req), id, dto);
  }

  @Post('procurement-requests/:id/withdraw')
  @RequirePermission('procurement', 'update')
  @HttpCode(200)
  withdrawRequest(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WithdrawProcurementRequestDto,
  ) {
    return this.procurement.withdrawRequest(this.actor(user, req), id, dto);
  }

  @Post('purchase-orders/:id/place')
  @RequirePermission('procurement', 'update')
  @HttpCode(200)
  placePurchaseOrder(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PlacePurchaseOrderDto,
  ) {
    return this.procurement.placePurchaseOrder(this.actor(user, req), id, dto);
  }
}
