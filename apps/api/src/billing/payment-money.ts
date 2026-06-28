// Billing money helpers. Plan prices are numeric(10,2) decimal strings; invoice
// amounts are stored as integer cents (bigint) so money never touches floating
// point — mirrors the commission-money / order-money BigInt-cents convention.

// Parses a numeric(…,2) decimal string into integer cents (scaled by 10^2).
export function decimalToCents(value: string): bigint {
  const neg = value.startsWith('-');
  const v = neg ? value.slice(1) : value;
  const [intPart, fracPart = ''] = v.split('.');
  const frac = (fracPart + '00').slice(0, 2);
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
