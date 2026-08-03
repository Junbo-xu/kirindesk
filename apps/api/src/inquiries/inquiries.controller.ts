import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ModuleGuard, RequireModule } from '../subscription/module.guard';
import { QuotaGuard } from '../subscription/quota.guard';
import { CheckQuota } from '../subscription/quota.service';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { CreateSelectionDto } from './dto/create-selection.dto';
import { InquiriesService, RequestActor } from './inquiries.service';
import { QuotationsService } from './quotations.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/inquiries')
@UseGuards(TenantAuthGuard, PermissionGuard, ModuleGuard)
@RequireModule('orders')
export class InquiriesController {
  constructor(
    private readonly inquiries: InquiriesService,
    private readonly quotations: QuotationsService,
  ) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Post()
  @RequirePermission('inquiries', 'create')
  async create(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateInquiryDto,
  ) {
    return this.inquiries.create(this.actor(user, req), dto);
  }

  @Get()
  @RequirePermission('inquiries', 'view')
  async list(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.inquiries.list(this.actor(user, req));
  }

  @Get(':id')
  @RequirePermission('inquiries', 'view')
  async getOne(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inquiries.getOne(this.actor(user, req), id);
  }

  @Post(':id/submit')
  @RequirePermission('inquiries', 'submit')
  async submit(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inquiries.submit(this.actor(user, req), id);
  }

  @Post(':id/sanitize')
  @UseGuards(QuotaGuard)
  @CheckQuota('ai')
  @RequirePermission('inquiries', 'sanitize')
  async sanitize(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inquiries.sanitize(this.actor(user, req), id);
  }

  @Get(':id/quotations')
  @RequirePermission('inquiries', 'view')
  async listSalesQuotations(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.quotations.listForSalesInquiry(this.actor(user, req), id);
  }

  @Post(':id/selections')
  @RequirePermission('quote_selections', 'create')
  async select(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSelectionDto,
  ) {
    return this.quotations.createSelection(this.actor(user, req), id, dto);
  }

  @Get(':id/selections')
  @RequirePermission('quote_selections', 'view')
  async listSelections(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.quotations.listSelections(this.actor(user, req), id);
  }
}
