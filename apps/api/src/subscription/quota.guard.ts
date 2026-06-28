import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { QuotaService, QuotaType, CHECK_QUOTA_KEY } from './quota.service';

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly quota: QuotaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const type = this.reflector.get<QuotaType>(CHECK_QUOTA_KEY, context.getHandler());
    if (!type) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user?.tenantId) return true;

    // For storage, extract file size from multipart header or body field.
    const pendingBytes =
      type === 'storage' ? Number(req.headers['content-length']) || 0 : undefined;

    await this.quota.checkQuota(user.tenantId, type, pendingBytes);
    return true;
  }
}
