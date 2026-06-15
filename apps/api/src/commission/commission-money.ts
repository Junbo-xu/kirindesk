// Commission money math. Pure BigInt integer arithmetic so commission amounts
// never touch floating point (plan §8.1). Mirrors the order-money.ts approach.
//
//   basis  total_amount_base, numeric(18,2)  -> scaled by 10^2 (cents)
//   rate   commission rate,    numeric(7,4)   -> a PERCENT (5.0000 = 5%),
//          scaled by 10^4
//
// commission = round2( basis * rate / 100 )
//   = round( basis_cents * rateScaled / 10^6 )   (round-half-up)
// because rate/100 = rateScaled / 10^4 / 100 = rateScaled / 10^6.

function scale(value: string, places: number): bigint {
  const neg = value.startsWith('-');
  const v = neg ? value.slice(1) : value;
  const [intPart, fracPart = ''] = v.split('.');
  const frac = (fracPart + '0'.repeat(places)).slice(0, places);
  const n = BigInt((intPart || '0') + frac);
  return neg ? -n : n;
}

// Formats integer cents (scaled by 10^2) as a numeric(…,2) decimal string.
export function centsToDecimal(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const s = abs.toString().padStart(3, '0');
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
}

// Parses a numeric(18,2) decimal string into integer cents (scaled by 10^2).
export function decimalToCents(value: string): bigint {
  return scale(value, 2);
}

// commission(order) = round2(basisBase × rate%) in integer cents, round-half-up.
// `basisBase` is a numeric(18,2) string, `rate` a numeric(7,4) percent string.
export function commissionCents(basisBase: string, rate: string): bigint {
  const basisCents = scale(basisBase, 2); // scaled 10^2
  const rateScaled = scale(rate, 4); // scaled 10^4 (percent)
  const product = basisCents * rateScaled; // scaled 10^6
  const divisor = 10n ** 6n;
  if (product < 0n) {
    const half = divisor / 2n;
    return -((-product + half) / divisor);
  }
  const half = divisor / 2n;
  return (product + half) / divisor; // scaled 10^2
}

// Convenience: commission as a numeric(18,2) string.
export function commissionAmount(basisBase: string, rate: string): string {
  return centsToDecimal(commissionCents(basisBase, rate));
}
