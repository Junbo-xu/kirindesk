import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { PlatformAuthModule } from './platform-auth/platform-auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { RbacModule } from './rbac/rbac.module';
import { AuditModule } from './audit/audit.module';
import { CustomersModule } from './customers/customers.module';
import { SalesOrdersModule } from './sales-orders/sales-orders.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module';
import { StorageModule } from './storage/storage.module';
import { FilesModule } from './files/files.module';
import { TenantSettingsModule } from './tenant-settings/tenant-settings.module';
import { ReportsModule } from './reports/reports.module';
import { CommissionModule } from './commission/commission.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    AuthModule,
    PlatformAuthModule,
    UsersModule,
    RolesModule,
    RbacModule,
    AuditModule,
    CustomersModule,
    SalesOrdersModule,
    SuppliersModule,
    PurchaseOrdersModule,
    StorageModule,
    FilesModule,
    TenantSettingsModule,
    ReportsModule,
    CommissionModule,
    AiModule,
  ],
})
export class AppModule {}
