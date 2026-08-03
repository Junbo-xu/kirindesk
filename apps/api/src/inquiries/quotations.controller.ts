import { Controller, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ModuleGuard, RequireModule } from '../subscription/module.guard';
import type { RequestActor } from './inquiries.service';
import { QuotationsService } from './quotations.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/quotations')
@UseGuards(TenantAuthGuard, PermissionGuard, ModuleGuard)
@RequireModule('procurement')
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Get(':id/overwrite-sequence')
  @RequirePermission('quotations', 'audit')
  async overwriteSequence(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const actor: RequestActor = {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
    return this.quotations.overwriteSequence(actor, id);
  }
}
