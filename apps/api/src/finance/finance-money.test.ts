import { describe, expect, it } from 'vitest';
import { addMoney, multiplyMoneyByBps, nonNegativeMoney, subtractMoney } from './finance-money';

describe('Stage 2E finance money', () => {
  it('keeps additions and subtractions in integer cents', () => {
    expect(addMoney(['1000.00', '71.27', '12.35'])).toBe('1083.62');
    expect(subtractMoney('1000.00', '500.00', '71.27', '12.35')).toBe('416.38');
    expect(subtractMoney('10.00', '12.35')).toBe('-2.35');
  });

  it('rounds allocation and rates half up without floating point', () => {
    expect(multiplyMoneyByBps('1000.00', 3333)).toBe('333.30');
    expect(multiplyMoneyByBps('333.30', 500)).toBe('16.67');
    expect(nonNegativeMoney('-0.01')).toBe('0.00');
  });
});
