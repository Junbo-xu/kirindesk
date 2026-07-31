import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { sendExportFile } from '../common/export-response';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { ModuleGuard, RequireModule } from '../subscription/module.guard';
import { CommercialActor, CommercialService } from './commercial.service';
import { UpdateCommercialSettingsDto } from './dto/commercial-settings.dto';
import { RecordCustomerReceiptDto, ReviewCustomerReceiptDto } from './dto/customer-receipt.dto';
import { LinkInquiryCustomerDto, UpgradeInquiryCustomerDto } from './dto/customer-upgrade.dto';
import {
  ApproveLowMarginDto,
  CreateProformaInvoiceDto,
  ReviseProformaInvoiceDto,
} from './dto/proforma-invoice.dto';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

abstract class CommercialControllerBase {
  protected actor(user: TenantJwtUser, req: Request): CommercialActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }
}

@Controller('api')
@UseGuards(TenantAuthGuard, PermissionGuard, ModuleGuard)
@RequireModule('orders')
export class CommercialOrdersController extends CommercialControllerBase {
  constructor(private readonly commercial: CommercialService) {
    super();
  }

  @Post('inquiries/:id/customer-upgrade')
  @RequirePermission('customers', 'create')
  async upgradeCustomer(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpgradeInquiryCustomerDto,
  ) {
    return this.commercial.upgradeInquiryCustomer(this.actor(user, req), id, dto);
  }

  @Put('inquiries/:id/customer-link')
  @RequirePermission('customers', 'view')
  async linkCustomer(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkInquiryCustomerDto,
  ) {
    return this.commercial.linkInquiryCustomer(this.actor(user, req), id, dto);
  }

  @Post('quote-selections/:id/margin-approval')
  @RequirePermission('quote_selections', 'approve_margin')
  async approveMargin(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveLowMarginDto,
  ) {
    return this.commercial.approveLowMargin(this.actor(user, req), id, dto.reason);
  }

  @Post('inquiries/:id/proforma-invoices')
  @RequirePermission('proforma_invoices', 'create')
  async createPi(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProformaInvoiceDto,
  ) {
    return this.commercial.createProformaInvoice(this.actor(user, req), id, dto);
  }

  @Get('inquiries/:id/proforma-invoices')
  @RequirePermission('proforma_invoices', 'view')
  async listPis(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.listProformaInvoices(this.actor(user, req), id);
  }

  @Get('proforma-invoices/:id')
  @RequirePermission('proforma_invoices', 'view')
  async getPi(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.getProformaInvoice(this.actor(user, req), id);
  }

  @Post('proforma-invoices/:id/revisions')
  @RequirePermission('proforma_invoices', 'create')
  async revisePi(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviseProformaInvoiceDto,
  ) {
    return this.commercial.reviseProformaInvoice(this.actor(user, req), id, dto);
  }

  @Post('proforma-invoices/:id/issue')
  @RequirePermission('proforma_invoices', 'issue')
  async issuePi(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.issueProformaInvoice(this.actor(user, req), id);
  }

  @Post('proforma-invoices/:id/customer-confirm')
  @RequirePermission('proforma_invoices', 'confirm')
  async confirmPi(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.confirmProformaInvoice(this.actor(user, req), id);
  }

  @Get('proforma-invoices/:id/export')
  @RequirePermission('proforma_invoices', 'export')
  async exportPi(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    sendExportFile(res, await this.commercial.exportProformaInvoice(this.actor(user, req), id));
  }
}

@Controller('api')
@UseGuards(TenantAuthGuard, PermissionGuard, ModuleGuard)
@RequireModule('finance')
export class CommercialFinanceController extends CommercialControllerBase {
  constructor(private readonly commercial: CommercialService) {
    super();
  }

  @Post('sales-orders/:id/customer-receipts')
  @RequirePermission('customer_receipts', 'record')
  async recordReceipt(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordCustomerReceiptDto,
  ) {
    return this.commercial.recordReceipt(this.actor(user, req), id, dto);
  }

  @Get('sales-orders/:id/customer-receipts')
  @RequirePermission('customer_receipts', 'view')
  async listReceipts(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.listReceipts(this.actor(user, req), id);
  }

  @Post('customer-receipts/:id/review')
  @RequirePermission('customer_receipts', 'review')
  async reviewReceipt(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewCustomerReceiptDto,
  ) {
    return this.commercial.reviewReceipt(this.actor(user, req), id, dto);
  }

  @Get('sales-orders/:id/procurement-gate')
  @RequirePermission('procurement_gate', 'view')
  async getGate(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.getProcurementGate(this.actor(user, req), id);
  }

  @Post('sales-orders/:id/procurement-gate/evaluate')
  @RequirePermission('procurement_gate', 'view')
  async evaluateGate(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.commercial.evaluateProcurementGate(this.actor(user, req), id);
  }
}

@Controller('api/commercial-settings')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class CommercialSettingsController extends CommercialControllerBase {
  constructor(private readonly commercial: CommercialService) {
    super();
  }

  @Get()
  @RequirePermission('tenant_settings', 'view')
  async getSettings(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.commercial.getSettings(this.actor(user, req));
  }

  @Put()
  @RequirePermission('tenant_settings', 'update')
  async updateSettings(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: UpdateCommercialSettingsDto,
  ) {
    return this.commercial.updateSettings(this.actor(user, req), dto);
  }
}
