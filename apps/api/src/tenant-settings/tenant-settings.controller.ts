import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TenantSettingsService, RequestActor } from './tenant-settings.service';
import { UpdateBaseCurrencyDto } from './dto/update-base-currency.dto';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/tenant-settings')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class TenantSettingsController {
  constructor(private readonly service: TenantSettingsService) {}

  private actor(user: TenantJwtUser): RequestActor {
    return { userId: user.sub, tenantId: user.tenantId };
  }

  @Get('base-currency')
  @RequirePermission('tenant_settings', 'view')
  async getBaseCurrency(@CurrentUser() user: TenantJwtUser) {
    return this.service.getBaseCurrency(this.actor(user));
  }

  @Put('base-currency')
  @RequirePermission('tenant_settings', 'update')
  async setBaseCurrency(@CurrentUser() user: TenantJwtUser, @Body() dto: UpdateBaseCurrencyDto) {
    return this.service.setBaseCurrency(this.actor(user), dto.base_currency);
  }
}
