import { Global, Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { MockEmailProvider } from './mock-email-provider';
import { EMAIL_PROVIDER } from './email-provider.interface';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuditModule, RbacModule, AuthModule],
  controllers: [NotificationController],
  providers: [NotificationService, { provide: EMAIL_PROVIDER, useClass: MockEmailProvider }],
  exports: [NotificationService],
})
export class NotificationModule {}
