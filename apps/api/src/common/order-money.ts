// Shared money math for order line items. Uses BigInt integer arithmetic on
// scaled values so money never touches floating point. Used by both the sales
// and purchase order services so the derivation rules stay identical.

// Computes line_total = quantity * unit_price rounded to 2 decimals. quantity
// has up to 3 decimals, unit_price up to 4; both are scaled to integers,
// multiplied (product scaled by 10^7), then rounded to 2 decimals (round-half-
// up). Returns a numeric(…,2) string. Inputs are pre-validated by
// OrderItemInputDto regexes (non-negative, bounded decimals).
export function computeLineTotal(quantity: string, unitPrice: string): string {
  const scale = (s: string, places: number): bigint => {
    const [intPart, fracPart = ''] = s.split('.');
    const frac = (fracPart + '0'.repeat(places)).slice(0, places);
    return BigInt(intPart + frac);
  };
  const q = scale(quantity, 3); // scaled by 10^3
  const p = scale(unitPrice, 4); // scaled by 10^4
  const product = q * p; // scaled by 10^7
  // Round to 2 decimals: divide by 10^5 with round-half-up.
  const divisor = 10n ** 5n;
  const half = divisor / 2n;
  const rounded = (product + half) / divisor; // scaled by 10^2
  const cents = rounded.toString().padStart(3, '0');
  const whole = cents.slice(0, -2);
  const frac = cents.slice(-2);
  return `${whole}.${frac}`;
}

// Sums an array of numeric(…,2) strings into a numeric(…,2) string via integer
// cents, avoiding float accumulation error.
export function sumMoney(values: string[]): string {
  let cents = 0n;
  for (const v of values) {
    const [intPart, fracPart = ''] = v.split('.');
    const frac = (fracPart + '00').slice(0, 2);
    cents += BigInt(intPart + frac);
  }
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

// Converts a numeric(18,2) money amount to a base currency by multiplying by a
// numeric(18,8) exchange rate, rounded to 2 decimals (round-half-up). Pure
// BigInt integer arithmetic so no floating point is involved.
//   amount  scaled by 10^2  (cents)
//   rate    scaled by 10^8
//   base_cents = round( cents * rateScaled / 10^8 )
// Inputs are DB/DTO-validated (amount is a derived total >= 0; rate > 0).
export function multiplyMoneyByRate(amount: string, rate: string): string {
  const scale = (s: string, places: number): bigint => {
    const [intPart, fracPart = ''] = s.split('.');
    const frac = (fracPart + '0'.repeat(places)).slice(0, places);
    return BigInt(intPart + frac);
  };
  const cents = scale(amount, 2); // scaled by 10^2
  const rateScaled = scale(rate, 8); // scaled by 10^8
  const product = cents * rateScaled; // scaled by 10^10
  const divisor = 10n ** 8n;
  const half = divisor / 2n;
  const baseCents = (product + half) / divisor; // scaled by 10^2
  const s = baseCents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}
