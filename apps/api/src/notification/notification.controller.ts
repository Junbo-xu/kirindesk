import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { PermissionGuard } from '../rbac/permission.guard';
import { RequirePermission } from '../rbac/require-permission.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NotificationService } from './notification.service';
import { UpdateNotificationSettingsDto } from './dto/update-notification-settings.dto';

interface TenantJwtUser {
  sub: string;
  tenantId: string;
}

@Controller('api/notifications')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class NotificationController {
  constructor(private readonly notification: NotificationService) {}

  @Get('settings')
  @RequirePermission('tenant_settings', 'view')
  getSettings(@CurrentUser() user: TenantJwtUser) {
    return this.notification.getSettings(user.tenantId, user.sub);
  }

  @Put('settings')
  @RequirePermission('tenant_settings', 'update')
  updateSettings(@CurrentUser() user: TenantJwtUser, @Body() dto: UpdateNotificationSettingsDto) {
    return this.notification.updateSettings(user.tenantId, user.sub, dto);
  }
}
