import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (user && user.type === 'tenant_user' && user.tenantId) {
      request.tenantContext = {
        tenantId: user.tenantId,
        userId: user.sub,
        actorType: 'tenant_user' as const,
      };
    }
    return next.handle();
  }
}
