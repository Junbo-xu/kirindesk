import { Body, Controller, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PlatformAuthGuard } from '../platform-auth/platform-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BillingService } from './billing.service';
import { IssueInvoiceDto } from './dto/issue-invoice.dto';

interface PlatformJwtUser {
  sub: string;
  email: string;
}

@Controller()
@UseGuards(PlatformAuthGuard)
export class PlatformBillingController {
  constructor(private readonly billing: BillingService) {}

  // Issues an invoice for a tenant's current plan. 201 on a fresh create, 200
  // when an existing pending invoice for the same plan+period is returned
  // idempotently (no double-billing).
  @Post('api/platform/tenants/:id/invoices')
  async issue(
    @Param('id') tenantId: string,
    @Body() dto: IssueInvoiceDto,
    @CurrentUser() user: PlatformJwtUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.billing.issueForTenant(
      user.sub,
      tenantId,
      dto.billingPeriod ?? 'monthly',
    );
    res.status(result.created ? 201 : 200);
    return result.invoice;
  }
}
