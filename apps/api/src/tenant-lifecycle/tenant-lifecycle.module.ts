import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireEnv } from '../common/env';
import { TenantStatusMiddleware } from './tenant-status.middleware';

/**
 * Houses the global tenant-status gate (1K-A). Registers a JwtModule with the
 * TENANT secret so the middleware can verify tenant tokens; APP_POOL comes from
 * the global DatabaseModule. AppModule imports this and applies the middleware
 * to all routes.
 */
@Module({
  imports: [JwtModule.register({ secret: requireEnv('TENANT_JWT_SECRET') })],
  providers: [TenantStatusMiddleware],
  exports: [TenantStatusMiddleware],
})
export class TenantLifecycleModule {}
