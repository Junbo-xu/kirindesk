import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PurchaseOrdersService, RequestActor } from './purchase-orders.service';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto';
import { UpdatePurchaseOrderDto } from './dto/update-purchase-order.dto';
import { ListPurchaseOrdersQuery } from './dto/list-purchase-orders.query';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/purchase-orders')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrdersService: PurchaseOrdersService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Post()
  @RequirePermission('procurement', 'create')
  async create(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return this.purchaseOrdersService.create(this.actor(user, req), dto);
  }

  @Get()
  @RequirePermission('procurement', 'view')
  async list(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListPurchaseOrdersQuery,
  ) {
    return this.purchaseOrdersService.list(this.actor(user, req), query);
  }

  @Get(':id')
  @RequirePermission('procurement', 'view')
  async getOne(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseOrdersService.getOne(this.actor(user, req), id);
  }

  @Patch(':id')
  @RequirePermission('procurement', 'update')
  async update(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    // ValidationPipe(transform) instantiates the DTO with every optional field
    // present as `undefined` (ES2022 class fields), so Object.keys(dto).length
    // is never 0. Count fields that actually carry a value instead.
    const hasUpdate = Object.values(dto).some((v) => v !== undefined);
    if (!hasUpdate) {
      throw new BadRequestException('At least one updatable field is required');
    }
    return this.purchaseOrdersService.update(this.actor(user, req), id, dto);
  }

  @Delete(':id')
  @RequirePermission('procurement', 'delete')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.purchaseOrdersService.remove(this.actor(user, req), id);
    return { id, deleted: true };
  }
}
