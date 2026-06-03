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
import { CustomersService, RequestActor } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { ListCustomersQuery } from './dto/list-customers.query';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/customers')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Post()
  @RequirePermission('customers', 'create')
  async create(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customersService.create(this.actor(user, req), dto);
  }

  @Get()
  @RequirePermission('customers', 'view')
  async list(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListCustomersQuery,
  ) {
    return this.customersService.list(this.actor(user, req), query);
  }

  @Get(':id')
  @RequirePermission('customers', 'view')
  async getOne(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customersService.getOne(this.actor(user, req), id);
  }

  @Patch(':id')
  @RequirePermission('customers', 'update')
  async update(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    // ValidationPipe(transform) instantiates the DTO with every optional field
    // present as `undefined` (ES2022 class fields), so Object.keys(dto).length
    // is never 0. Count fields that actually carry a value instead.
    const hasUpdate = Object.values(dto).some((v) => v !== undefined);
    if (!hasUpdate) {
      throw new BadRequestException('At least one updatable field is required');
    }
    return this.customersService.update(this.actor(user, req), id, dto);
  }

  @Delete(':id')
  @RequirePermission('customers', 'delete')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.customersService.remove(this.actor(user, req), id);
    return { id, deleted: true };
  }
}
