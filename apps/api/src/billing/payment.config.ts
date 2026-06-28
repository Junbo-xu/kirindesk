/**
 * Selects which payment provider implementation is wired (plan §2.3). The only
 * value this phase accepts is `mock`. Real WeChat Pay / Alipay / Stripe gateways
 * require explicit approval (CLAUDE.md §7) and are NOT reachable through config —
 * an unknown / unapproved name fails fast at startup rather than silently
 * falling back to a real gateway.
 */

export const SUPPORTED_PAYMENT_PROVIDERS = ['mock'] as const;
export type PaymentProviderName = (typeof SUPPORTED_PAYMENT_PROVIDERS)[number];

/** Env var that selects the provider. Defaults to `mock` when unset. */
export const PAYMENT_PROVIDER_ENV = 'PAYMENT_PROVIDER';

/**
 * Resolves the configured provider name, defaulting to `mock`. Throws at
 * startup on any value outside the supported set, so a typo or an unapproved
 * gateway name can never start the app on a real payment backend.
 */
export function resolvePaymentProviderName(): PaymentProviderName {
  const raw = process.env[PAYMENT_PROVIDER_ENV]?.trim() || 'mock';
  if (!SUPPORTED_PAYMENT_PROVIDERS.includes(raw as PaymentProviderName)) {
    throw new Error(
      `Unsupported ${PAYMENT_PROVIDER_ENV}=${raw}. ` +
        `Supported: ${SUPPORTED_PAYMENT_PROVIDERS.join(', ')}. ` +
        `Real gateways require explicit approval (CLAUDE.md §7).`,
    );
  }
  return raw as PaymentProviderName;
}
