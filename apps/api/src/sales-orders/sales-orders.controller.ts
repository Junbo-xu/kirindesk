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
import { SalesOrdersService, RequestActor } from './sales-orders.service';
import { CreateSalesOrderDto } from './dto/create-sales-order.dto';
import { UpdateSalesOrderDto } from './dto/update-sales-order.dto';
import { ListSalesOrdersQuery } from './dto/list-sales-orders.query';
import {
  ApproveOrderDto,
  RejectOrderDto,
  WithdrawOrderDto,
} from '../common/dto/order-approval.dto';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/sales-orders')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class SalesOrdersController {
  constructor(private readonly salesOrdersService: SalesOrdersService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Post()
  @RequirePermission('orders', 'create')
  async create(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateSalesOrderDto,
  ) {
    return this.salesOrdersService.create(this.actor(user, req), dto);
  }

  @Get()
  @RequirePermission('orders', 'view')
  async list(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListSalesOrdersQuery,
  ) {
    return this.salesOrdersService.list(this.actor(user, req), query);
  }

  @Get(':id')
  @RequirePermission('orders', 'view')
  async getOne(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.salesOrdersService.getOne(this.actor(user, req), id);
  }

  @Patch(':id')
  @RequirePermission('orders', 'update')
  async update(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalesOrderDto,
  ) {
    // ValidationPipe(transform) instantiates the DTO with every optional field
    // present as `undefined` (ES2022 class fields), so Object.keys(dto).length
    // is never 0. Count fields that actually carry a value instead.
    const hasUpdate = Object.values(dto).some((v) => v !== undefined);
    if (!hasUpdate) {
      throw new BadRequestException('At least one updatable field is required');
    }
    return this.salesOrdersService.update(this.actor(user, req), id, dto);
  }

  // ---- Phase 1F-C: approval workflow transitions -------------------------
  // submit/withdraw are editor actions (orders:update); approve/reject are the
  // privileged ones (orders:approve, additionally requiring all-scope +
  // approver != submitter, enforced in the service).

  @Post(':id/submit')
  @RequirePermission('orders', 'update')
  @HttpCode(200)
  async submit(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.salesOrdersService.submit(this.actor(user, req), id);
  }

  @Post(':id/approve')
  @RequirePermission('orders', 'approve')
  @HttpCode(200)
  async approve(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveOrderDto,
  ) {
    return this.salesOrdersService.approve(this.actor(user, req), id, dto.reason);
  }

  @Post(':id/reject')
  @RequirePermission('orders', 'approve')
  @HttpCode(200)
  async reject(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectOrderDto,
  ) {
    return this.salesOrdersService.reject(this.actor(user, req), id, dto.reason);
  }

  @Post(':id/withdraw')
  @RequirePermission('orders', 'update')
  @HttpCode(200)
  async withdraw(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WithdrawOrderDto,
  ) {
    return this.salesOrdersService.withdraw(this.actor(user, req), id, dto.reason);
  }

  @Delete(':id')
  @RequirePermission('orders', 'delete')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.salesOrdersService.remove(this.actor(user, req), id);
    return { id, deleted: true };
  }
}
