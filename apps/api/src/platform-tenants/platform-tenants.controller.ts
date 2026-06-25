import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { PlatformAuthGuard } from '../platform-auth/platform-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PlatformTenantsService } from './platform-tenants.service';
import { ListTenantsQuery } from './dto/list-tenants.query';
import { ActivateTenantDto, TenantReasonDto } from './dto/tenant-lifecycle.dto';

interface PlatformJwtUser {
  sub: string;
  email: string;
}

/**
 * Platform-side tenant lifecycle (plan §3.4). Platform identity only
 * (PlatformAuthGuard) — not gated by the tenant-status middleware, and not
 * subject to tenant RBAC. Returns/changes tenant metadata + status only.
 */
@Controller('api/platform/tenants')
@UseGuards(PlatformAuthGuard)
export class PlatformTenantsController {
  constructor(private readonly tenants: PlatformTenantsService) {}

  @Get()
  async list(@Query() query: ListTenantsQuery) {
    return this.tenants.list(query);
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    return this.tenants.getOne(id);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  async suspend(
    @CurrentUser() user: PlatformJwtUser,
    @Param('id') id: string,
    @Body() dto: TenantReasonDto,
  ) {
    return this.tenants.transition(user.sub, id, 'suspend', dto.reason);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate(
    @CurrentUser() user: PlatformJwtUser,
    @Param('id') id: string,
    @Body() dto: TenantReasonDto,
  ) {
    return this.tenants.transition(user.sub, id, 'deactivate', dto.reason);
  }

  @Post(':id/activate')
  @HttpCode(200)
  async activate(
    @CurrentUser() user: PlatformJwtUser,
    @Param('id') id: string,
    @Body() dto: ActivateTenantDto,
  ) {
    return this.tenants.transition(user.sub, id, 'activate', dto.reason ?? null);
  }
}
