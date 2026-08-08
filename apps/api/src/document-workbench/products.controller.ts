import {
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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  CreateProductDto,
  CreateProductFieldDto,
  ListProductsQuery,
  UpdateProductDto,
  UpdateProductFieldDto,
} from './dto/product.dto';
import { DocumentWorkbenchActor, ProductsService } from './products.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

abstract class ProductControllerBase {
  protected actor(user: TenantJwtUser, request: Request): DocumentWorkbenchActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (request as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }
}

@Controller('api/products')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProductsController extends ProductControllerBase {
  constructor(private readonly products: ProductsService) {
    super();
  }

  @Get()
  @RequirePermission('products', 'view')
  list(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Query() query: ListProductsQuery,
  ) {
    return this.products.list(this.actor(user, request), query);
  }

  @Post()
  @RequirePermission('products', 'manage')
  create(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(this.actor(user, request), dto);
  }

  @Get(':id')
  @RequirePermission('products', 'view')
  get(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.get(this.actor(user, request), id);
  }

  @Patch(':id')
  @RequirePermission('products', 'manage')
  update(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(this.actor(user, request), id, dto);
  }
}

@Controller('api/product-fields')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class ProductFieldsController extends ProductControllerBase {
  constructor(private readonly products: ProductsService) {
    super();
  }

  @Get()
  @RequirePermission('products', 'view')
  list(@CurrentUser() user: TenantJwtUser, @Req() request: Request) {
    return this.products.listFields(this.actor(user, request));
  }

  @Post()
  @RequirePermission('product_fields', 'manage')
  create(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Body() dto: CreateProductFieldDto,
  ) {
    return this.products.createField(this.actor(user, request), dto);
  }

  @Patch(':id')
  @RequirePermission('product_fields', 'manage')
  update(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductFieldDto,
  ) {
    return this.products.updateField(this.actor(user, request), id, dto);
  }

  @Delete(':id')
  @RequirePermission('product_fields', 'manage')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.products.deleteField(this.actor(user, request), id);
    return { id, deleted: true };
  }
}
