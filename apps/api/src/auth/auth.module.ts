import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TenantJwtStrategy } from './tenant-jwt.strategy';
import { TenantAuthGuard } from './tenant-auth.guard';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';
import { requireEnv } from '../common/env';
import { AuthSessionModule } from '../auth-session/auth-session.module';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: requireEnv('TENANT_JWT_SECRET'),
      signOptions: {
        expiresIn: (process.env.TENANT_JWT_EXPIRES_IN || '2h') as NonNullable<
          JwtModuleOptions['signOptions']
        >['expiresIn'],
      },
    }),
    UsersModule,
    AuditModule,
    AuthSessionModule,
    RedisModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, TenantJwtStrategy, TenantAuthGuard, LoginRateLimitGuard],
  exports: [TenantAuthGuard],
})
export class AuthModule {}
// Note: UsersModule ↔ AuthModule form a cycle (auth needs UsersService; the
// users controller needs TenantAuthGuard). UsersModule uses forwardRef(()=>
// AuthModule); this side imports UsersModule directly, which Nest resolves.
