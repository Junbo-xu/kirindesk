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
  AddLogisticsEventDto,
  CompleteExpenseFxDto,
  ConfirmGoodsReceiptDto,
  CreateGoodsReceiptDto,
  CreateShipmentDto,
  DeliverShipmentDto,
  InspectGoodsReceiptDto,
  LinkShipmentReceiptDto,
  RecordOrderExpenseDto,
  UpdateFulfillmentSettingsDto,
} from './dto/fulfillment.dto';
import { FulfillmentActor, FulfillmentService } from './fulfillment.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class FulfillmentController {
  constructor(private readonly fulfillment: FulfillmentService) {}

  private actor(user: TenantJwtUser, req: Request): FulfillmentActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get('fulfillment/settings')
  @RequirePermission('fulfillment', 'view')
  getSettings(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.fulfillment.getSettings(this.actor(user, req));
  }

  @Put('fulfillment/settings')
  @RequirePermission('tenant_settings', 'update')
  updateSettings(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: UpdateFulfillmentSettingsDto,
  ) {
    return this.fulfillment.updateSettings(this.actor(user, req), dto);
  }

  @Get('sales-orders/:id/fulfillment')
  @RequirePermission('fulfillment', 'view')
  getOrder(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.fulfillment.getOrder(this.actor(user, req), id);
  }

  @Post('purchase-orders/:id/goods-receipts')
  @RequirePermission('goods_receipts', 'manage')
  createGoodsReceipt(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateGoodsReceiptDto,
  ) {
    return this.fulfillment.createGoodsReceipt(this.actor(user, req), id, dto);
  }

  @Post('goods-receipts/:id/inspect')
  @RequirePermission('goods_receipts', 'manage')
  @HttpCode(200)
  inspectGoodsReceipt(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InspectGoodsReceiptDto,
  ) {
    return this.fulfillment.inspectGoodsReceipt(this.actor(user, req), id, dto);
  }

  @Post('goods-receipts/:id/confirm')
  @RequirePermission('goods_receipts', 'confirm')
  @HttpCode(200)
  confirmGoodsReceipt(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmGoodsReceiptDto,
  ) {
    return this.fulfillment.confirmGoodsReceipt(this.actor(user, req), id, dto);
  }

  @Post('sales-orders/:id/shipments')
  @RequirePermission('shipments', 'manage')
  createShipment(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShipmentDto,
  ) {
    return this.fulfillment.createShipment(this.actor(user, req), id, dto);
  }

  @Post('shipments/:id/dispatch')
  @RequirePermission('shipments', 'manage')
  @HttpCode(200)
  dispatchShipment(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.fulfillment.dispatchShipment(this.actor(user, req), id);
  }

  @Post('shipments/:id/logistics-events')
  @RequirePermission('shipments', 'manage')
  addLogisticsEvent(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddLogisticsEventDto,
  ) {
    return this.fulfillment.addLogisticsEvent(this.actor(user, req), id, dto);
  }

  @Post('shipments/:id/deliver')
  @RequirePermission('shipments', 'manage')
  @HttpCode(200)
  deliverShipment(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverShipmentDto,
  ) {
    return this.fulfillment.deliverShipment(this.actor(user, req), id, dto);
  }

  @Post('sales-orders/:id/expenses')
  @RequirePermission('order_expenses', 'record')
  recordExpense(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordOrderExpenseDto,
  ) {
    return this.fulfillment.recordExpense(this.actor(user, req), id, dto);
  }

  @Post('order-expenses/:id/complete-fx')
  @RequirePermission('order_expenses', 'record')
  @HttpCode(200)
  completeExpenseFx(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteExpenseFxDto,
  ) {
    return this.fulfillment.completeExpenseFx(this.actor(user, req), id, dto);
  }

  @Post('shipments/:id/customer-receipts')
  @RequirePermission('shipments', 'manage')
  linkCustomerReceipt(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkShipmentReceiptDto,
  ) {
    return this.fulfillment.linkCustomerReceipt(this.actor(user, req), id, dto);
  }
}
