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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { DocumentSetsService } from './document-sets.service';
import {
  ConvertDocumentSetToSalesOrderDto,
  CreateDocumentSetDto,
  CreateShareLinkDto,
  GenerateSalesOrderPurchaseOrdersDto,
  ListDocumentSetsQuery,
  LockSalesOrderForFulfillmentDto,
  SyncSalesOrderDocumentsDto,
  UpdateDocumentSetDto,
} from './dto/document-set.dto';
import { DocumentWorkbenchActor } from './products.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

abstract class DocumentControllerBase {
  protected actor(user: TenantJwtUser, request: Request): DocumentWorkbenchActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (request as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }
}

@Controller('api/document-sets')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class DocumentSetsController extends DocumentControllerBase {
  constructor(private readonly documents: DocumentSetsService) {
    super();
  }

  @Get()
  @RequirePermission('document_sets', 'view')
  list(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Query() query: ListDocumentSetsQuery,
  ) {
    return this.documents.list(this.actor(user, request), query);
  }

  @Post()
  @RequirePermission('document_sets', 'manage')
  create(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Body() dto: CreateDocumentSetDto,
  ) {
    return this.documents.create(this.actor(user, request), dto);
  }

  @Get(':id')
  @RequirePermission('document_sets', 'view')
  get(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documents.get(this.actor(user, request), id);
  }

  @Patch(':id')
  @RequirePermission('document_sets', 'manage')
  update(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDocumentSetDto,
  ) {
    return this.documents.update(this.actor(user, request), id, dto);
  }

  @Post(':id/lock')
  @RequirePermission('document_sets', 'lock')
  lock(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documents.lock(this.actor(user, request), id);
  }

  @Post(':id/sales-order')
  @RequirePermission('orders', 'create')
  @HttpCode(200)
  convertToSalesOrder(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConvertDocumentSetToSalesOrderDto,
  ) {
    return this.documents.convertToSalesOrder(this.actor(user, request), id, dto);
  }

  @Post(':id/exports/:documentType')
  @RequirePermission('document_sets', 'export')
  export(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentType') documentType: string,
  ) {
    return this.documents.export(this.actor(user, request), id, documentType);
  }

  @Get(':id/exports')
  @RequirePermission('document_sets', 'view')
  listExports(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documents.listExports(this.actor(user, request), id);
  }

  @Get(':id/links')
  @RequirePermission('document_links', 'manage')
  listLinks(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.documents.listLinks(this.actor(user, request), id);
  }
}

@Controller('api/sales-orders')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class SalesOrderFulfillmentBridgeController extends DocumentControllerBase {
  constructor(private readonly documents: DocumentSetsService) {
    super();
  }

  @Post(':id/fulfillment-lock')
  @RequirePermission('orders', 'update')
  @HttpCode(200)
  lockForFulfillment(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LockSalesOrderForFulfillmentDto,
  ) {
    return this.documents.lockSalesOrderForFulfillment(this.actor(user, request), id, dto);
  }

  @Post(':id/document-set')
  @RequirePermission('document_sets', 'manage')
  @HttpCode(200)
  syncDocuments(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SyncSalesOrderDocumentsDto,
  ) {
    return this.documents.syncSalesOrderDocuments(this.actor(user, request), id, dto);
  }

  @Post(':id/purchase-orders/generate')
  @RequirePermission('procurement', 'create')
  @HttpCode(200)
  generatePurchaseOrders(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateSalesOrderPurchaseOrdersDto,
  ) {
    return this.documents.generatePurchaseOrders(this.actor(user, request), id, dto);
  }
}

@Controller('api/document-links')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class DocumentLinksController extends DocumentControllerBase {
  constructor(private readonly documents: DocumentSetsService) {
    super();
  }

  @Post()
  @RequirePermission('document_links', 'manage')
  create(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Body() dto: CreateShareLinkDto,
  ) {
    return this.documents.createLink(this.actor(user, request), dto);
  }

  @Delete(':id')
  @RequirePermission('document_links', 'manage')
  @HttpCode(200)
  async revoke(
    @CurrentUser() user: TenantJwtUser,
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.documents.revokeLink(this.actor(user, request), id);
    return { id, revoked: true };
  }
}

@Controller('api/public/documents')
export class PublicDocumentsController {
  constructor(private readonly documents: DocumentSetsService) {}

  @Get(':token')
  open(@Req() request: Request, @Param('token') token: string) {
    return this.documents.openPublic(token, request.ip, request.headers['user-agent']);
  }

  @Get(':token/download')
  async download(
    @Req() request: Request,
    @Param('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    const target = await this.documents.downloadPublic(
      token,
      request.ip,
      request.headers['user-agent'],
    );
    response.setHeader('Content-Type', target.mimeType);
    response.setHeader('Content-Length', target.sizeBytes);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${target.fileName.replace(/["\r\n]/g, '_')}"`,
    );
    response.setHeader('Cache-Control', 'no-store');
    target.stream.on('error', () => response.end());
    target.stream.pipe(response);
  }

  @Post(':token/confirm')
  confirm(@Req() request: Request, @Param('token') token: string) {
    return this.documents.confirmPublic(token, request.ip, request.headers['user-agent']);
  }
}
