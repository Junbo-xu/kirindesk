import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
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
import { AuditViewerModule } from './audit/audit-viewer.module';
import { PlatformTenantsModule } from './platform-tenants/platform-tenants.module';
import { TenantLifecycleModule } from './tenant-lifecycle/tenant-lifecycle.module';
import { TenantStatusMiddleware } from './tenant-lifecycle/tenant-status.middleware';

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
    AuditViewerModule,
    PlatformTenantsModule,
    TenantLifecycleModule,
  ],
})
export class AppModule implements NestModule {
  // Global tenant-status gate: applies to every route, but no-ops unless the
  // request carries a valid tenant JWT (plan §3.6 / tenant-status.middleware).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantStatusMiddleware).forRoutes('*');
  }
}
