import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { PlatformAuthModule } from './platform-auth/platform-auth.module';
import { UsersModule } from './users/users.module';
import { RbacModule } from './rbac/rbac.module';
import { AuditModule } from './audit/audit.module';
import { CustomersModule } from './customers/customers.module';

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    AuthModule,
    PlatformAuthModule,
    UsersModule,
    RbacModule,
    AuditModule,
    CustomersModule,
  ],
})
export class AppModule {}
