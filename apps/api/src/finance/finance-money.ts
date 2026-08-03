function toCents(value: string): bigint {
  const negative = value.startsWith('-');
  const normalized = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = BigInt(`${whole || '0'}${(fraction + '00').slice(0, 2)}`);
  return negative ? -cents : cents;
}

function fromCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const text = absolute.toString().padStart(3, '0');
  return `${negative ? '-' : ''}${text.slice(0, -2)}.${text.slice(-2)}`;
}

export function addMoney(values: string[]): string {
  return fromCents(values.reduce((total, value) => total + toCents(value), 0n));
}

export function subtractMoney(minuend: string, ...subtrahends: string[]): string {
  return fromCents(subtrahends.reduce((total, value) => total - toCents(value), toCents(minuend)));
}

export function nonNegativeMoney(value: string): string {
  return toCents(value) < 0n ? '0.00' : fromCents(toCents(value));
}

export function multiplyMoneyByBps(value: string, bps: number): string {
  const product = toCents(value) * BigInt(bps);
  const divisor = 10000n;
  const rounded =
    product < 0n ? -((-product + divisor / 2n) / divisor) : (product + divisor / 2n) / divisor;
  return fromCents(rounded);
}
