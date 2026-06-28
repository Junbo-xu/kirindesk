import { Injectable } from '@nestjs/common';
import { ChargeRequest, ChargeResult, PaymentProvider } from './payment-provider.interface';

/**
 * Deterministic mock payment provider for development and testing (CLAUDE.md
 * §7 — no real gateway). Charges always "succeed" with a synthetic reference,
 * except two test hooks for exercising the failure path:
 *   - currency === '__force_error__'  → throws (per-call sentinel)
 *   - MockPaymentProvider.failNext     → throws once, then auto-resets
 * Every attempt is recorded in the static `calls` array for assertions.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  static calls: ChargeRequest[] = [];
  // When true, the next charge() throws and the flag resets to false.
  static failNext = false;

  static reset(): void {
    MockPaymentProvider.calls = [];
    MockPaymentProvider.failNext = false;
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    MockPaymentProvider.calls.push(req);
    if (req.currency === '__force_error__') {
      throw new Error('MockPaymentProvider: forced error (currency sentinel)');
    }
    if (MockPaymentProvider.failNext) {
      MockPaymentProvider.failNext = false;
      throw new Error('MockPaymentProvider: forced error (failNext)');
    }
    return { providerRef: `MOCK-PAY-${req.invoiceId}` };
  }
}
