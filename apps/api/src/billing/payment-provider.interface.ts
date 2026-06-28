// Payment provider abstraction (Phase 2A, CLAUDE.md §7). The service depends on
// this interface, never on a concrete vendor. The only implementation this
// phase ships is MockPaymentProvider — no real WeChat Pay / Alipay / Stripe
// gateway is wired, and payment.config refuses to start on any non-`mock` value.

export interface ChargeRequest {
  tenantId: string;
  invoiceId: string;
  amountCents: bigint;
  currency: string;
}

export interface ChargeResult {
  // Opaque provider-side reference for the charge (e.g. a gateway transaction
  // id). For the mock this is a deterministic synthetic string.
  providerRef: string;
}

export interface PaymentProvider {
  // Charges the given amount. Resolves with a provider reference on success;
  // throws on failure (the service records a failed payment and leaves the
  // invoice untouched). Implementations must never mutate application state.
  charge(req: ChargeRequest): Promise<ChargeResult>;
  // Stable provider key persisted on each payment row (e.g. 'mock').
  readonly name: string;
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
