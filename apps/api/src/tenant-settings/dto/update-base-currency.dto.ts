import { IsIn } from 'class-validator';

// Supported tenant base (reporting) currencies. Mirrors the order currency
// whitelist (ISO 4217 codes). Kept in sync with the FX resolution in the order
// services, which treat an order whose currency equals the base as rate=1.
export const SUPPORTED_BASE_CURRENCIES = ['RMB', 'USD', 'HKD', 'EUR'] as const;

export class UpdateBaseCurrencyDto {
  @IsIn(SUPPORTED_BASE_CURRENCIES, {
    message: `base_currency must be one of: ${SUPPORTED_BASE_CURRENCIES.join(', ')}`,
  })
  base_currency!: (typeof SUPPORTED_BASE_CURRENCIES)[number];
}
