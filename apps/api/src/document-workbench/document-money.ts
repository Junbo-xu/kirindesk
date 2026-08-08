export interface DocumentMoneyLineInput {
  quantity: string;
  unit_price: string;
  cost_unit_price?: string;
  weight_kg?: string;
  volume_cbm?: string;
}

export interface DocumentMoneyInput {
  lines: DocumentMoneyLineInput[];
  discount_type: 'none' | 'percent' | 'amount';
  discount_value: string;
  freight_amount: string;
  insurance_amount: string;
  tax_amount: string;
  internal_expenses: string;
  exchange_rate: string;
  allocation_method: 'equal' | 'value' | 'weight' | 'volume';
}

export interface DocumentMoneyLineResult {
  line_total: string;
  cost_total: string | null;
  allocated_charges: string;
  total_weight_kg: string | null;
  total_volume_cbm: string | null;
}

export interface DocumentMoneyResult {
  lines: DocumentMoneyLineResult[];
  subtotal: string;
  discount_amount: string;
  freight_amount: string;
  insurance_amount: string;
  tax_amount: string;
  grand_total: string;
  settlement_total: string;
  cost_total: string;
  internal_expenses: string;
  gross_profit: string;
  gross_margin_bps: number | null;
  total_weight_kg: string;
  total_volume_cbm: string;
}

function scaled(value: string, places: number): bigint {
  const negative = value.startsWith('-');
  const normalized = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = normalized.split('.');
  const result = BigInt(`${whole || '0'}${(fraction + '0'.repeat(places)).slice(0, places)}`);
  return negative ? -result : result;
}

function decimal(value: bigint, places: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const text = absolute.toString().padStart(places + 1, '0');
  const whole = places === 0 ? text : text.slice(0, -places);
  const fraction = places === 0 ? '' : `.${text.slice(-places)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  if (numerator < 0n) return -roundDivide(-numerator, denominator);
  return (numerator + denominator / 2n) / denominator;
}

function lineMoney(quantity: string, unitPrice: string): bigint {
  return roundDivide(scaled(quantity, 3) * scaled(unitPrice, 4), 100_000n);
}

function measure(quantity: string, value: string, valuePlaces: number): bigint {
  return roundDivide(scaled(quantity, 3) * scaled(value, valuePlaces), 1_000n);
}

function allocate(total: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const normalized = weights.some((weight) => weight > 0n) ? weights : weights.map(() => 1n);
  const sum = normalized.reduce((result, weight) => result + weight, 0n);
  let allocated = 0n;
  return normalized.map((weight, index) => {
    if (index === normalized.length - 1) return total - allocated;
    const share = (total * weight) / sum;
    allocated += share;
    return share;
  });
}

export function computeDocumentMoney(input: DocumentMoneyInput): DocumentMoneyResult {
  const lineTotals = input.lines.map((line) => lineMoney(line.quantity, line.unit_price));
  const costTotals = input.lines.map((line) =>
    line.cost_unit_price === undefined ? null : lineMoney(line.quantity, line.cost_unit_price),
  );
  const weightTotals = input.lines.map((line) =>
    line.weight_kg === undefined ? null : measure(line.quantity, line.weight_kg, 4),
  );
  const volumeTotals = input.lines.map((line) =>
    line.volume_cbm === undefined ? null : measure(line.quantity, line.volume_cbm, 6),
  );
  const subtotal = lineTotals.reduce((result, value) => result + value, 0n);
  const freight = scaled(input.freight_amount, 2);
  const insurance = scaled(input.insurance_amount, 2);
  const tax = scaled(input.tax_amount, 2);
  const charges = freight + insurance + tax;
  const discount =
    input.discount_type === 'none'
      ? 0n
      : input.discount_type === 'amount'
        ? scaled(input.discount_value, 2)
        : roundDivide(subtotal * scaled(input.discount_value, 4), 1_000_000n);
  const boundedDiscount = discount > subtotal ? subtotal : discount;
  const grandTotal = subtotal - boundedDiscount + charges;
  const costTotal = costTotals.reduce((result: bigint, value) => result + (value ?? 0n), 0n);
  const internalExpenses = scaled(input.internal_expenses, 2);
  const grossProfit = grandTotal - costTotal - internalExpenses - charges;
  const grossMarginBps =
    grandTotal === 0n ? null : Number(roundDivide(grossProfit * 10_000n, grandTotal));
  const settlementTotal = roundDivide(
    grandTotal * scaled(input.exchange_rate, 10),
    10_000_000_000n,
  );
  const weights =
    input.allocation_method === 'equal'
      ? input.lines.map(() => 1n)
      : input.allocation_method === 'value'
        ? lineTotals
        : input.allocation_method === 'weight'
          ? weightTotals.map((value) => value ?? 0n)
          : volumeTotals.map((value) => value ?? 0n);
  const allocatedCharges = allocate(charges, weights);

  return {
    lines: input.lines.map((_, index) => ({
      line_total: decimal(lineTotals[index], 2),
      cost_total: costTotals[index] === null ? null : decimal(costTotals[index]!, 2),
      allocated_charges: decimal(allocatedCharges[index], 2),
      total_weight_kg: weightTotals[index] === null ? null : decimal(weightTotals[index]!, 4),
      total_volume_cbm: volumeTotals[index] === null ? null : decimal(volumeTotals[index]!, 6),
    })),
    subtotal: decimal(subtotal, 2),
    discount_amount: decimal(boundedDiscount, 2),
    freight_amount: decimal(freight, 2),
    insurance_amount: decimal(insurance, 2),
    tax_amount: decimal(tax, 2),
    grand_total: decimal(grandTotal, 2),
    settlement_total: decimal(settlementTotal, 2),
    cost_total: decimal(costTotal, 2),
    internal_expenses: decimal(internalExpenses, 2),
    gross_profit: decimal(grossProfit, 2),
    gross_margin_bps: grossMarginBps,
    total_weight_kg: decimal(
      weightTotals.reduce((result: bigint, value) => result + (value ?? 0n), 0n),
      4,
    ),
    total_volume_cbm: decimal(
      volumeTotals.reduce((result: bigint, value) => result + (value ?? 0n), 0n),
      6,
    ),
  };
}
