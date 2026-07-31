import { describe, expect, it } from 'vitest';
import { SanitizedOutputInvalidException } from './inquiries.errors';
import { parseSanitizedQuoteTask, validateSanitizedQuoteTask } from './quote-task-sanitizer';
import type { InquiryItemRow } from './inquiries.response';

const ITEMS: InquiryItemRow[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    inquiry_id: '22222222-2222-2222-2222-222222222222',
    line_no: 1,
    description: 'Steel bottle',
    specifications: '750ml',
    quantity: '100.000',
    unit: 'pcs',
    target_price_usd: '2.5000',
    created_at: new Date('2026-07-31T00:00:00.000Z'),
  },
];

describe('quote task sanitizer', () => {
  it('accepts fenced structured output and preserves authoritative quantities', () => {
    const value = parseSanitizedQuoteTask(
      '```json\n' +
        JSON.stringify({
          summary: '750ml steel bottle required',
          items: [
            {
              inquiry_item_id: ITEMS[0].id,
              description: 'Steel bottle',
              specifications: '750ml',
              quantity: '100',
              unit: 'pcs',
            },
          ],
        }) +
        '\n```',
      ITEMS,
      'PRIVATE-CUSTOMER',
      'Contact buyer@example.test',
    );

    expect(value.payload.items[0].quantity).toBe('100.000');
    expect(value.payload.items[0].unit).toBe('pcs');
  });

  it.each([
    ['customer code', 'Quote for PRIVATE-CUSTOMER'],
    ['email', 'Send details to buyer@example.test'],
    ['phone', 'Call +86 138-0013-8000'],
  ])('rejects output containing %s', (_label, summary) => {
    expect(() =>
      validateSanitizedQuoteTask(
        {
          summary,
          items: [
            {
              inquiry_item_id: ITEMS[0].id,
              description: 'Steel bottle',
              specifications: '750ml',
              quantity: '100',
              unit: 'pcs',
            },
          ],
        },
        ITEMS,
        'PRIVATE-CUSTOMER',
        'Email buyer@example.test or call +86 138-0013-8000',
      ),
    ).toThrow(SanitizedOutputInvalidException);
  });

  it('rejects changed quantities, units, duplicate ids, and extra fields', () => {
    const base = {
      summary: 'Sanitized requirement',
      items: [
        {
          inquiry_item_id: ITEMS[0].id,
          description: 'Steel bottle',
          specifications: '750ml',
          quantity: '99',
          unit: 'pcs',
        },
      ],
    };

    expect(() => validateSanitizedQuoteTask(base, ITEMS, 'PRIVATE-CUSTOMER', 'hello')).toThrow(
      SanitizedOutputInvalidException,
    );
    expect(() =>
      validateSanitizedQuoteTask(
        { ...base, items: [{ ...base.items[0], quantity: '100', unit: 'carton' }] },
        ITEMS,
        'PRIVATE-CUSTOMER',
        'hello',
      ),
    ).toThrow(SanitizedOutputInvalidException);
    expect(() =>
      validateSanitizedQuoteTask(
        { ...base, items: [{ ...base.items[0], quantity: '100', extra: true }] },
        ITEMS,
        'PRIVATE-CUSTOMER',
        'hello',
      ),
    ).toThrow(SanitizedOutputInvalidException);
  });
});
