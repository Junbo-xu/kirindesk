import { describe, expect, it } from 'vitest';
import { computeDocumentMoney } from './document-money';

describe('computeDocumentMoney', () => {
  it('keeps money exact and preserves allocated charge totals', () => {
    const result = computeDocumentMoney({
      lines: [
        {
          quantity: '2.000',
          unit_price: '10.0000',
          cost_unit_price: '6.0000',
          weight_kg: '1.0000',
          volume_cbm: '0.100000',
        },
        {
          quantity: '1.000',
          unit_price: '20.0000',
          cost_unit_price: '8.0000',
          weight_kg: '2.0000',
          volume_cbm: '0.200000',
        },
      ],
      discount_type: 'percent',
      discount_value: '10.0000',
      freight_amount: '3.00',
      insurance_amount: '1.00',
      tax_amount: '0.00',
      internal_expenses: '2.00',
      exchange_rate: '7.2000000000',
      allocation_method: 'value',
    });

    expect(result.lines.map((line) => line.line_total)).toEqual(['20.00', '20.00']);
    expect(result.lines.map((line) => line.allocated_charges)).toEqual(['2.00', '2.00']);
    expect(result.subtotal).toBe('40.00');
    expect(result.discount_amount).toBe('4.00');
    expect(result.grand_total).toBe('40.00');
    expect(result.settlement_total).toBe('288.00');
    expect(result.cost_total).toBe('20.00');
    expect(result.gross_profit).toBe('14.00');
    expect(result.gross_margin_bps).toBe(3500);
    expect(result.total_weight_kg).toBe('4.0000');
    expect(result.total_volume_cbm).toBe('0.400000');
  });

  it('caps amount discounts at subtotal and allocates remainder exactly', () => {
    const result = computeDocumentMoney({
      lines: [
        { quantity: '1', unit_price: '0.0100' },
        { quantity: '1', unit_price: '0.0100' },
        { quantity: '1', unit_price: '0.0100' },
      ],
      discount_type: 'amount',
      discount_value: '10.00',
      freight_amount: '0.01',
      insurance_amount: '0.00',
      tax_amount: '0.00',
      internal_expenses: '0.00',
      exchange_rate: '1',
      allocation_method: 'equal',
    });

    expect(result.discount_amount).toBe('0.03');
    expect(result.grand_total).toBe('0.01');
    expect(result.lines.map((line) => line.allocated_charges)).toEqual(['0.00', '0.00', '0.01']);
  });
});
