import { Global, Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { EMAIL_PROVIDER } from './email-provider.interface';
import { resolveEmailProvider } from './email-provider.factory';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [AuditModule, RbacModule, AuthModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    {
      provide: EMAIL_PROVIDER,
      // Auto-detect: SmtpEmailProvider when SMTP_HOST is set; MockEmailProvider
      // otherwise. useFactory keeps the provider singleton per module lifetime.
      useFactory: resolveEmailProvider,
    },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
