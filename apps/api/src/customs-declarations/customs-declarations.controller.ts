import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import {
  CreateCustomsDeclarationDto,
  CustomsIdempotencyDto,
  RefreshCustomsDeclarationDto,
} from './dto/customs-declaration.dto';
import {
  CustomsDeclarationActor,
  CustomsDeclarationsService,
} from './customs-declarations.service';

enum CustomsDownloadDocumentType {
  PRE_ENTRY = 'pre_entry',
  AUTHORIZATION = 'authorization',
}

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class CustomsDeclarationsController {
  constructor(private readonly customs: CustomsDeclarationsService) {}

  private actor(user: TenantJwtUser, request: Request): CustomsDeclarationActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (request as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get('customs-declarations')
  @RequirePermission('customs_declarations', 'view')
  list(@CurrentUser() user: TenantJwtUser, @Req() request: Request) {
    return this.customs.list(this.actor(user, request));
  }

  @Get('sales-orders/:id/customs-declaration')
  @RequirePermission('customs_declarations', 'view')
  getBySalesOrder(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.customs.getBySalesOrder(this.actor(user, request), id);
  }

  @Post('sales-orders/:id/customs-declarations')
  @RequirePermission('customs_declarations', 'manage')
  create(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCustomsDeclarationDto,
  ) {
    return this.customs.create(this.actor(user, request), id, dto);
  }

  @Post('customs-declarations/:id/refresh')
  @RequirePermission('customs_declarations', 'manage')
  @HttpCode(200)
  refresh(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefreshCustomsDeclarationDto,
  ) {
    return this.customs.refresh(this.actor(user, request), id, dto);
  }

  @Post('customs-declarations/:id/generate')
  @RequirePermission('customs_declarations', 'manage')
  @HttpCode(200)
  generate(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CustomsIdempotencyDto,
  ) {
    return this.customs.generate(this.actor(user, request), id, dto);
  }

  @Post('customs-declarations/:id/versions/:version/export')
  @RequirePermission('customs_declarations', 'export')
  @HttpCode(200)
  exportVersion(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: CustomsIdempotencyDto,
  ) {
    return this.customs.exportVersion(this.actor(user, request), id, version, dto);
  }

  @Post('customs-declarations/:id/versions/:version/files/:documentType/token')
  @RequirePermission('customs_declarations', 'export')
  createVersionDownloadToken(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Param('documentType', new ParseEnumPipe(CustomsDownloadDocumentType))
    documentType: CustomsDownloadDocumentType,
  ) {
    return this.customs.createVersionDownloadToken(
      this.actor(user, request),
      id,
      version,
      documentType,
    );
  }
}
