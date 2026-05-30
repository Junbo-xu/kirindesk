import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacService } from './rbac.service';
import { AuditService } from '../audit/audit.service';
import { PERMISSION_KEY, PermissionRequirement } from './require-permission.decorator';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rbacService: RbacService,
    private readonly auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<PermissionRequirement>(
      PERMISSION_KEY,
      context.getHandler(),
    );
    if (!requirement) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user || user.type !== 'tenant_user') {
      throw new ForbiddenException('Permission denied');
    }

    const code = `${requirement.resource}:${requirement.action}`;
    const result = await this.rbacService.checkPermission(user.sub, user.tenantId, code);

    if (!result.allowed) {
      await this.auditService
        .log({
          tenantId: user.tenantId,
          actorType: 'tenant_user',
          actorId: user.sub,
          action: 'rbac:permission_denied',
          resourceType: 'permission',
          resourceId: code,
          ipAddress: request.ip,
          userAgent: request.headers?.['user-agent'],
        })
        .catch(() => {});
      throw new ForbiddenException('Permission denied');
    }

    request.dataScope = result.dataScope;
    return true;
  }
}
