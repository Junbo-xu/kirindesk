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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UsersService, RequestActor } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ListUsersQuery } from './dto/list-users.query';
import { SetUserRolesDto } from './dto/set-user-roles.dto';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

/**
 * Tenant user management (plan §3.1). Every route runs under tenant auth + RBAC;
 * reads/writes are tenant-isolated by RLS and narrowed by dataScope. The
 * server-side guards (last-owner, self-lock, no privilege escalation) live in
 * the service (plan §4) — never trusted to the UI.
 */
@Controller('api/users')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  private actor(user: TenantJwtUser, req: Request): RequestActor {
    return {
      userId: user.sub,
      tenantId: user.tenantId,
      dataScope: (req as Request & { dataScope?: string }).dataScope ?? 'none',
    };
  }

  @Post()
  @RequirePermission('users', 'create')
  async create(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Body() dto: CreateUserDto,
  ) {
    return this.usersService.create(this.actor(user, req), dto);
  }

  @Get()
  @RequirePermission('users', 'view')
  async list(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Query() query: ListUsersQuery,
  ) {
    return this.usersService.list(this.actor(user, req), query);
  }

  @Get(':id')
  @RequirePermission('users', 'view')
  async getOne(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usersService.getOne(this.actor(user, req), id);
  }

  @Patch(':id')
  @RequirePermission('users', 'update')
  async update(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    // ValidationPipe(transform) instantiates the DTO with every optional field
    // present as `undefined` (ES2022 class fields), so Object.keys(dto).length
    // is never 0. Count fields that actually carry a value instead.
    const hasUpdate = Object.values(dto).some((v) => v !== undefined);
    if (!hasUpdate) {
      throw new BadRequestException('At least one updatable field is required');
    }
    return this.usersService.update(this.actor(user, req), id, dto);
  }

  // Full-replace the user's role set (plan §3.1). Subset / last-owner guards
  // are enforced in the service (plan §4.1).
  @Put(':id/roles')
  @RequirePermission('users', 'update')
  async setRoles(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetUserRolesDto,
  ) {
    return this.usersService.setRoles(this.actor(user, req), id, dto.roleIds);
  }

  // Deactivate / soft-delete (no hard delete). Last-owner + self-lock guards
  // apply (plan §4.1).归入 users:update 语义 — there is no users:delete code.
  @Delete(':id')
  @RequirePermission('users', 'update')
  @HttpCode(200)
  async remove(
    @CurrentUser() user: TenantJwtUser,
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.usersService.deactivate(this.actor(user, req), id);
    return { id, deleted: true };
  }
}
