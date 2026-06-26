import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { requireEnv } from '../common/env';
import { TenantStatusMiddleware } from './tenant-status.middleware';

/**
 * Houses the global tenant-status gate (1K-A). Registers a JwtModule with the
 * TENANT secret so the middleware can verify tenant tokens; APP_POOL comes from
 * the global DatabaseModule.
 *
 * The middleware is applied here (not in AppModule) so Nest resolves its deps —
 * JwtService in particular — from this module's injector context, which is the
 * one that registered JwtModule. Applying it from AppModule fails because
 * AppModule has no JwtService of its own.
 */
@Module({
  imports: [JwtModule.register({ secret: requireEnv('TENANT_JWT_SECRET') })],
  providers: [TenantStatusMiddleware],
  exports: [TenantStatusMiddleware],
})
export class TenantLifecycleModule implements NestModule {
  // Global tenant-status gate: applies to every route, but no-ops unless the
  // request carries a valid tenant JWT (plan §3.6 / tenant-status.middleware).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantStatusMiddleware).forRoutes('*');
  }
}
