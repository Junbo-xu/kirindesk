import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformJwtStrategy } from './platform-jwt.strategy';
import { PlatformAuthGuard } from './platform-auth.guard';
import { AuditModule } from '../audit/audit.module';
import { requireEnv } from '../common/env';
import { AuthSessionModule } from '../auth-session/auth-session.module';
import { RedisModule } from '../redis/redis.module';
import { LoginRateLimitGuard } from '../auth/login-rate-limit.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: requireEnv('PLATFORM_JWT_SECRET'),
      signOptions: {
        expiresIn: (process.env.PLATFORM_JWT_EXPIRES_IN || '2h') as NonNullable<
          JwtModuleOptions['signOptions']
        >['expiresIn'],
      },
    }),
    AuditModule,
    AuthSessionModule,
    RedisModule,
  ],
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService, PlatformJwtStrategy, PlatformAuthGuard, LoginRateLimitGuard],
  exports: [PlatformAuthGuard],
})
export class PlatformAuthModule {}
