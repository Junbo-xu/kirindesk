import { describe, expect, it } from 'vitest';
import { AFTER_SALES_CASE_STATUSES, normalizeAfterSalesCaseStatus } from './after-sales-status';

describe('after-sales status normalization', () => {
  it.each(AFTER_SALES_CASE_STATUSES)('keeps the supported status %s', (status) => {
    expect(normalizeAfterSalesCaseStatus(status)).toEqual({
      status,
      status_diagnostic: null,
    });
  });

  it('returns an explicit unknown status with diagnostics', () => {
    expect(normalizeAfterSalesCaseStatus('legacy_waiting')).toEqual({
      status: 'unknown',
      status_diagnostic: {
        code: 'UNKNOWN_AFTER_SALES_STATUS',
        received_status: 'legacy_waiting',
        message: 'Unsupported after-sales status received: legacy_waiting',
      },
    });
  });
});
