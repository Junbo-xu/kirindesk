import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
import { SupportAccessService, RequestActor } from './support-access.service';
import { CreateSupportAccessDto } from './dto/create-support-access.dto';
import { RevokeSupportAccessDto } from './dto/revoke-support-access.dto';
import { ListSupportAccessQuery } from './dto/list-support-access.query';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

/**
 * Tenant-side support-access authorization (plan §3.1/§3.3). Every route runs
 * under tenant auth + RBAC (support_access:grant/view/revoke); reads/writes are
 * tenant-isolated by RLS. dataScope is 'all' for these endpoints — a grant is a
 * tenant-management record with no resource owner (plan §3.7) — but the
 * injected scope is passed through faithfully.
 */
@Controller('api/support-access')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class SupportAccessController {
  constructor(private readonly service: SupportAccessService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Post()
  @RequirePermission('support_access', 'grant')
  async create(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateSupportAccessDto,
  ) {
    return this.service.create(this.actor(user, req), dto);
  }

  @Get()
  @RequirePermission('support_access', 'view')
  async list(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListSupportAccessQuery,
  ) {
    return this.service.list(this.actor(user, req), query);
  }

  @Get(':id')
  @RequirePermission('support_access', 'view')
  async getOne(@CurrentUser() user: TenantJwtUser, @Req() req: Request, @Param('id') id: string) {
    return this.service.getOne(this.actor(user, req), id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @RequirePermission('support_access', 'revoke')
  async revoke(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: RevokeSupportAccessDto,
  ) {
    return this.service.revoke(this.actor(user, req), id, dto.reason);
  }
}
