import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { RolesService, RequestActor } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { SetRolePermissionsDto } from './dto/set-role-permissions.dto';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

/**
 * Tenant role management (plan §3.2). Every route runs under tenant auth + RBAC;
 * reads/writes are tenant-isolated by RLS. The server-side guards (system-role
 * read-only, no privilege escalation, in-use protection) live in the service
 * (plan §4) — never trusted to the UI.
 */
@Controller('api/roles')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Get()
  @RequirePermission('roles', 'view')
  async list(@CurrentUser() user: TenantJwtUser, @Req() req: Request) {
    return this.rolesService.list(this.actor(user, req));
  }

  @Get(':id')
  @RequirePermission('roles', 'view')
  async getOne(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rolesService.getOne(this.actor(user, req), id);
  }

  @Post()
  @RequirePermission('roles', 'create')
  async create(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateRoleDto,
  ) {
    return this.rolesService.create(this.actor(user, req), dto);
  }

  @Patch(':id')
  @RequirePermission('roles', 'update')
  async update(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    // ValidationPipe(transform) instantiates the DTO with optional fields as
    // `undefined`, so Object.keys is never empty. Require at least one value.
    const hasUpdate = Object.values(dto).some((v) => v !== undefined);
    if (!hasUpdate) {
      throw new BadRequestException('At least one updatable field is required');
    }
    return this.rolesService.update(this.actor(user, req), id, dto);
  }

  // Full-replace the role's permission set (plan §3.2). Subset / system-role
  // guards are enforced in the service (plan §4.1). 归入 roles:update 语义.
  @Put(':id/permissions')
  @RequirePermission('roles', 'update')
  async setPermissions(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetRolePermissionsDto,
  ) {
    return this.rolesService.setPermissions(this.actor(user, req), id, dto.permissions);
  }

  // Delete a custom role (no users:delete-style code; 归入 roles:update 语义).
  // System-role + in-use guards apply (plan §4.1 guards 4 + 5).
  @Delete(':id')
  @RequirePermission('roles', 'update')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.rolesService.remove(this.actor(user, req), id);
    return { id, deleted: true };
  }
}
