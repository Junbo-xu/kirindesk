import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformJwtStrategy } from './platform-jwt.strategy';
import { PlatformAuthGuard } from './platform-auth.guard';
import { AuditModule } from '../audit/audit.module';
import { requireEnv } from '../common/env';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: requireEnv('PLATFORM_JWT_SECRET'),
      signOptions: { expiresIn: process.env.PLATFORM_JWT_EXPIRES_IN || '2h' } as any,
    }),
    AuditModule,
  ],
  controllers: [PlatformAuthController],
  providers: [PlatformAuthService, PlatformJwtStrategy, PlatformAuthGuard],
  exports: [PlatformAuthGuard],
})
export class PlatformAuthModule {}
