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
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ModuleGuard, RequireModule } from '../subscription/module.guard';
import { QuotaGuard } from '../subscription/quota.guard';
import { CheckQuota } from '../subscription/quota.service';
import { ManualQuoteTaskDto } from './dto/manual-quote-task.dto';
import { UpsertQuotationDto } from './dto/upsert-quotation.dto';
import { InquiriesService, RequestActor } from './inquiries.service';
import { QuotationsService } from './quotations.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/quote-tasks')
@UseGuards(TenantAuthGuard, PermissionGuard, ModuleGuard)
@RequireModule('procurement')
export class QuoteTasksController {
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

  @Get()
  @RequirePermission('quotations', 'view')
  async list(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.inquiries.listQuoteTasks(this.actor(user, req));
  }

  @Get(':id')
  @RequirePermission('quotations', 'view')
  async getOne(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inquiries.getQuoteTask(this.actor(user, req), id);
  }

  @Put(':id/manual')
  @RequirePermission('quotations', 'manage')
  async manuallyCorrect(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ManualQuoteTaskDto,
  ) {
    return this.inquiries.manuallyCorrect(this.actor(user, req), id, dto);
  }

  @Post(':id/retry')
  @UseGuards(QuotaGuard)
  @CheckQuota('ai')
  @RequirePermission('quotations', 'manage')
  async retry(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inquiries.retrySanitization(this.actor(user, req), id);
  }

  @Get(':id/quotations')
  @RequirePermission('quotations', 'view')
  async listQuotations(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.quotations.listForTask(this.actor(user, req), id);
  }

  @Put(':id/quotations')
  @HttpCode(200)
  @RequirePermission('quotations', 'manage')
  async upsertQuotation(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertQuotationDto,
  ) {
    return this.quotations.upsert(this.actor(user, req), id, dto);
  }
}
