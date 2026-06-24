import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesService, RequestActor } from './roles.service';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

/**
 * Read-only permission catalog (plan §3.3) — the data source for the web
 * permission matrix. Global dictionary (permissions × modules); still requires
 * login + roles:view so only role administrators can enumerate the catalog.
 */
@Controller('api/permissions')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class PermissionsController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @RequirePermission('roles', 'view')
  async catalog(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    const actor: RequestActor = {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
    return this.rolesService.listPermissionCatalog(actor);
  }
}
