import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TenantJwtStrategy } from './tenant-jwt.strategy';
import { TenantAuthGuard } from './tenant-auth.guard';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: process.env.TENANT_JWT_SECRET || 'tenant-jwt-fallback-dev',
      signOptions: { expiresIn: process.env.TENANT_JWT_EXPIRES_IN || '2h' } as any,
    }),
    UsersModule,
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, TenantJwtStrategy, TenantAuthGuard],
  exports: [TenantAuthGuard],
})
export class AuthModule {}
