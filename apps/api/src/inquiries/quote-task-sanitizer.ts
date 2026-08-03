import { SanitizedOutputInvalidException } from './inquiries.errors';
import type { InquiryItemRow, SanitizedItem, SanitizedPayload } from './inquiries.response';

function normalizedDecimal(value: string): string {
  const [integerPart, fractionPart = ''] = value.split('.');
  const integer = integerPart.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionPart.replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new SanitizedOutputInvalidException();
  }
}

function identityTokens(customerCode: string, customerMessage: string): string[] {
  const tokens = new Set<string>();
  const code = customerCode.trim().toLowerCase();
  if (code.length >= 3) tokens.add(code);

  for (const match of customerMessage.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    tokens.add(match[0].toLowerCase());
  }
  for (const match of customerMessage.matchAll(/(?:\+?\d[\d\s().-]{6,}\d)/g)) {
    const compact = match[0].replace(/\D/g, '');
    if (compact.length >= 7) tokens.add(compact);
  }
  return [...tokens];
}

function assertNoKnownIdentity(
  summary: string,
  items: SanitizedItem[],
  customerCode: string,
  customerMessage: string,
): void {
  const lower = JSON.stringify({ summary, items }).toLowerCase();
  const digits = lower.replace(/\D/g, '');
  for (const token of identityTokens(customerCode, customerMessage)) {
    const found = /^\d+$/.test(token) ? digits.includes(token) : lower.includes(token);
    if (found) {
      throw new SanitizedOutputInvalidException('Sanitized output contains customer identity');
    }
  }
}

function validateItems(value: unknown, authoritative: InquiryItemRow[]): SanitizedItem[] {
  if (!Array.isArray(value) || value.length !== authoritative.length) {
    throw new SanitizedOutputInvalidException();
  }

  const authoritativeById = new Map(authoritative.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const items = value.map((candidate): SanitizedItem => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new SanitizedOutputInvalidException();
    }
    const item = candidate as Record<string, unknown>;
    assertExactKeys(item, ['inquiry_item_id', 'description', 'specifications', 'quantity', 'unit']);
    if (
      typeof item.inquiry_item_id !== 'string' ||
      typeof item.description !== 'string' ||
      !(typeof item.specifications === 'string' || item.specifications === null) ||
      typeof item.quantity !== 'string' ||
      typeof item.unit !== 'string'
    ) {
      throw new SanitizedOutputInvalidException();
    }
    const source = authoritativeById.get(item.inquiry_item_id);
    if (
      !source ||
      seen.has(item.inquiry_item_id) ||
      normalizedDecimal(item.quantity) !== normalizedDecimal(source.quantity) ||
      item.unit !== source.unit
    ) {
      throw new SanitizedOutputInvalidException();
    }
    const description = item.description.trim();
    const specifications = item.specifications?.trim() || null;
    if (
      description.length === 0 ||
      description.length > 500 ||
      (specifications !== null && specifications.length > 5000)
    ) {
      throw new SanitizedOutputInvalidException();
    }
    seen.add(item.inquiry_item_id);
    return {
      inquiry_item_id: item.inquiry_item_id,
      description,
      specifications,
      quantity: source.quantity,
      unit: source.unit,
    };
  });

  return authoritative.map((source) => {
    const item = items.find((candidate) => candidate.inquiry_item_id === source.id);
    if (!item) throw new SanitizedOutputInvalidException();
    return item;
  });
}

export function validateSanitizedQuoteTask(
  value: unknown,
  authoritative: InquiryItemRow[],
  customerCode: string,
  customerMessage: string,
): { summary: string; payload: SanitizedPayload } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SanitizedOutputInvalidException();
  }
  const output = value as Record<string, unknown>;
  assertExactKeys(output, ['summary', 'items']);
  if (typeof output.summary !== 'string') throw new SanitizedOutputInvalidException();
  const summary = output.summary.trim();
  if (summary.length === 0 || summary.length > 2000) {
    throw new SanitizedOutputInvalidException();
  }
  const items = validateItems(output.items, authoritative);
  assertNoKnownIdentity(summary, items, customerCode, customerMessage);
  return { summary, payload: { items } };
}

export function parseSanitizedQuoteTask(
  output: string,
  authoritative: InquiryItemRow[],
  customerCode: string,
  customerMessage: string,
): { summary: string; payload: SanitizedPayload } {
  const trimmed = output.trim();
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new SanitizedOutputInvalidException();
  }
  return validateSanitizedQuoteTask(parsed, authoritative, customerCode, customerMessage);
}

export function buildSanitizationPrompt(
  customerCountry: string,
  customerMessage: string,
  items: InquiryItemRow[],
): string {
  return JSON.stringify({
    instruction:
      'Return JSON only with keys summary and items. Remove all customer identity and contact data. ' +
      'Each item must contain exactly inquiry_item_id, description, specifications, quantity, unit. ' +
      'Keep every inquiry_item_id, quantity, and unit unchanged.',
    inquiry: {
      customer_country: customerCountry,
      customer_message: customerMessage,
      items: items.map((item) => ({
        inquiry_item_id: item.id,
        description: item.description,
        specifications: item.specifications,
        quantity: item.quantity,
        unit: item.unit,
      })),
    },
  });
}
