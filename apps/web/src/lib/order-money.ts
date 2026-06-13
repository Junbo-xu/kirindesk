// Client-side money math for the order line-item editor. Mirrors the server's
// derivation (apps/api/src/common/order-money.ts) so the read-only total shown
// in the form matches what the API will compute and store. Uses BigInt integer
// arithmetic on scaled values to avoid floating-point drift.

// Returns line_total = quantity * unit_price rounded to 2 decimals, as a
// numeric(…,2) string. Returns null if either input is not a valid non-negative
// decimal (quantity up to 3 dp, unit_price up to 4 dp), so callers can show a
// blank subtotal for incomplete rows.
const QUANTITY_RE = /^\d{1,15}(\.\d{1,3})?$/;
const UNIT_PRICE_RE = /^\d{1,14}(\.\d{1,4})?$/;

function scale(s: string, places: number): bigint {
  const [intPart, fracPart = ''] = s.split('.');
  const frac = (fracPart + '0'.repeat(places)).slice(0, places);
  return BigInt(intPart + frac);
}

function centsToString(cents: bigint): string {
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export function computeLineTotal(quantity: string, unitPrice: string): string | null {
  if (!QUANTITY_RE.test(quantity) || !UNIT_PRICE_RE.test(unitPrice)) return null;
  const q = scale(quantity, 3); // scaled by 10^3
  const p = scale(unitPrice, 4); // scaled by 10^4
  const product = q * p; // scaled by 10^7
  const divisor = 10n ** 5n;
  const rounded = (product + divisor / 2n) / divisor; // round-half-up to 10^2
  return centsToString(rounded);
}

// Sums numeric(…,2) strings into a numeric(…,2) string. Non-numeric entries are
// treated as 0 (incomplete rows do not contribute to the running total).
export function sumMoney(values: Array<string | null>): string {
  let cents = 0n;
  for (const v of values) {
    if (!v) continue;
    const [intPart, fracPart = ''] = v.split('.');
    if (!/^\d+$/.test(intPart)) continue;
    const frac = (fracPart + '00').slice(0, 2);
    cents += BigInt(intPart + frac);
  }
  return centsToString(cents);
}
