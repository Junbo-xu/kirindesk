import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { PlatformBillingController } from './platform-billing.controller';
import { BillingService } from './billing.service';
import { MockPaymentProvider } from './mock-payment-provider';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { resolvePaymentProviderName } from './payment.config';

/**
 * Billing & payment (Phase 2A). The payment provider is wired behind
 * PAYMENT_PROVIDER via a factory that validates PAYMENT_PROVIDER at startup;
 * `mock` is the only binding this phase exposes and resolvePaymentProviderName
 * throws on anything else, so a misconfigured / unapproved gateway fails fast
 * rather than starting on a real backend (CLAUDE.md §7). Switching to a real
 * gateway is a deliberate, approved code change here — never a config fallback.
 */
@Module({
  imports: [RbacModule, AuditModule, AuthModule],
  controllers: [BillingController, PlatformBillingController],
  providers: [
    BillingService,
    {
      provide: PAYMENT_PROVIDER,
      useFactory: () => {
        resolvePaymentProviderName();
        return new MockPaymentProvider();
      },
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}
