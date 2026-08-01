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
  CloseDto,
  ConfirmSampleDto,
  ConvertSampleOrderDto,
  CreateAfterSalesCaseDto,
  CreateSampleOrderDto,
  DecideDto,
  DeliverSampleDto,
  DispatchSampleDto,
  ExecuteAfterSalesDto,
  ReplaceAfterSalesApprovalConfigDto,
} from './dto/samples-after-sales.dto';
import { SamplesAfterSalesActor, SamplesAfterSalesService } from './samples-after-sales.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class SamplesAfterSalesController {
  constructor(private readonly service: SamplesAfterSalesService) {}

  private actor(user: TenantJwtUser, req: Request): SamplesAfterSalesActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get('sample-orders')
  @RequirePermission('sample_orders', 'view')
  listSamples(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.service.listSamples(this.actor(user, req));
  }

  @Post('sample-orders')
  @RequirePermission('sample_orders', 'create')
  createSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateSampleOrderDto,
  ) {
    return this.service.createSample(this.actor(user, req), dto);
  }

  @Get('sample-orders/:id')
  @RequirePermission('sample_orders', 'view')
  getSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getSample(this.actor(user, req), id);
  }

  @Post('sample-orders/:id/submit')
  @HttpCode(200)
  @RequirePermission('sample_orders', 'create')
  submitSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.submitSample(this.actor(user, req), id);
  }

  @Post('sample-orders/:id/decision')
  @HttpCode(200)
  @RequirePermission('sample_orders', 'approve')
  decideSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideDto,
  ) {
    return this.service.decideSample(this.actor(user, req), id, dto);
  }

  @Post('sample-orders/:id/dispatch')
  @HttpCode(200)
  @RequirePermission('sample_orders', 'fulfill')
  dispatchSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispatchSampleDto,
  ) {
    return this.service.dispatchSample(this.actor(user, req), id, dto);
  }

  @Post('sample-orders/:id/deliver')
  @HttpCode(200)
  @RequirePermission('sample_orders', 'fulfill')
  deliverSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliverSampleDto,
  ) {
    return this.service.deliverSample(this.actor(user, req), id, dto);
  }

  @Post('sample-orders/:id/confirm')
  @HttpCode(200)
  @RequirePermission('sample_orders', 'create')
  confirmSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmSampleDto,
  ) {
    return this.service.confirmSample(this.actor(user, req), id, dto);
  }

  @Post('sample-orders/:id/convert')
  @HttpCode(200)
  @RequirePermission('sample_orders', 'convert')
  convertSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertSampleOrderDto,
  ) {
    return this.service.convertSample(this.actor(user, req), id, dto);
  }

  @Post('sample-orders/:id/close')
  @HttpCode(200)
  @RequirePermission('sample_orders', 'create')
  closeSample(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseDto,
  ) {
    return this.service.closeSample(this.actor(user, req), id, dto);
  }

  @Get('after-sales/approval-config')
  @RequirePermission('after_sales', 'approve')
  getApprovalConfig(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.service.getAfterSalesApprovalConfig(this.actor(user, req));
  }

  @Put('after-sales/approval-config')
  @RequirePermission('after_sales', 'approve')
  replaceApprovalConfig(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: ReplaceAfterSalesApprovalConfigDto,
  ) {
    return this.service.replaceAfterSalesApprovalConfig(this.actor(user, req), dto);
  }

  @Get('after-sales-cases')
  @RequirePermission('after_sales', 'view')
  listAfterSales(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.service.listAfterSalesCases(this.actor(user, req));
  }

  @Post('sales-orders/:id/after-sales-cases')
  @RequirePermission('after_sales', 'create')
  createAfterSales(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAfterSalesCaseDto,
  ) {
    return this.service.createAfterSalesCase(this.actor(user, req), id, dto);
  }

  @Get('after-sales-cases/:id')
  @RequirePermission('after_sales', 'view')
  getAfterSales(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.getAfterSalesCase(this.actor(user, req), id);
  }

  @Post('after-sales-cases/:id/submit')
  @HttpCode(200)
  @RequirePermission('after_sales', 'create')
  submitAfterSales(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.submitAfterSalesCase(this.actor(user, req), id);
  }

  @Post('after-sales-cases/:id/decisions')
  @HttpCode(200)
  @RequirePermission('after_sales', 'approve')
  decideAfterSales(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideDto,
  ) {
    return this.service.decideAfterSalesCase(this.actor(user, req), id, dto);
  }

  @Post('after-sales-cases/:id/start')
  @HttpCode(200)
  @RequirePermission('after_sales', 'execute')
  startAfterSales(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.startAfterSalesCase(this.actor(user, req), id);
  }

  @Post('after-sales-cases/:id/execute')
  @HttpCode(200)
  @RequirePermission('after_sales', 'execute')
  executeAfterSales(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExecuteAfterSalesDto,
  ) {
    return this.service.executeAfterSalesCase(this.actor(user, req), id, dto);
  }

  @Post('after-sales-cases/:id/close')
  @HttpCode(200)
  @RequirePermission('after_sales', 'execute')
  closeAfterSales(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.closeAfterSalesCase(this.actor(user, req), id);
  }
}
