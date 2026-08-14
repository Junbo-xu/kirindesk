import { describe, expect, it } from 'vitest';
import { buildDocumentPackages } from './document-packing';
import { renderDocumentHtml } from './document-pdf.renderer';
import { InternalDocumentSnapshot, toPublicDocumentSnapshot } from './document.types';

function internalSnapshot(): InternalDocumentSnapshot {
  return {
    document_set_id: '10000000-0000-4000-8000-000000000001',
    sales_order_id: null,
    source_version: 3,
    quote_number: 'QT-SECURITY',
    pricing_mode: 'cost_profit',
    status: 'draft',
    language: 'ar',
    incoterm: 'CIF',
    pricing_currency: 'USD',
    settlement_currency: 'EUR',
    exchange_rate: '0.9200000000',
    discount_type: 'none',
    discount_value: '0',
    allocation_method: 'weight',
    packing_mode: 'combined',
    template_key: 'fixed_default',
    theme_color: '#155EEF',
    visible_fields: { thumbnail: true },
    terms: '30% deposit',
    bank_info: 'Public bank details',
    logo_file_id: null,
    signature_file_id: null,
    customer: null,
    packages: [
      {
        package_no: 'A-1',
        line_nos: [1],
        total_weight_kg: '2.0000',
        total_volume_cbm: '0.200000',
      },
    ],
    lines: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        line_no: 1,
        sku: 'SKU-1',
        name: 'منتج',
        description: null,
        quantity: '2.000',
        unit: 'pcs',
        unit_price: '10.0000',
        line_total: '20.00',
        cost_unit_price: '98765.4321',
        cost_total: '197530.86',
        allocated_charges: '1.00',
        weight_kg: '1.0000',
        volume_cbm: '0.100000',
        total_weight_kg: '2.0000',
        total_volume_cbm: '0.200000',
        package_no: 'A-1',
        thumbnail_file_id: null,
        custom_fields: [],
      },
    ],
    totals: {
      subtotal: '20.00',
      discount_amount: '0.00',
      freight_amount: '1.00',
      insurance_amount: '0.00',
      tax_amount: '0.00',
      grand_total: '21.00',
      settlement_total: '19.32',
      total_weight_kg: '2.0000',
      total_volume_cbm: '0.200000',
    },
    internal_expenses: '43210.99',
    internal_totals: {
      cost_total: '197530.86',
      internal_expenses: '43210.99',
      gross_profit: '-240720.85',
      gross_margin_bps: -114629000,
    },
    generated_at: '2026-08-08T00:00:00.000Z',
  };
}

describe('customer document projection', () => {
  it('removes every internal financial field before HTML rendering', () => {
    const publicSnapshot = toPublicDocumentSnapshot(internalSnapshot());
    const serialized = JSON.stringify(publicSnapshot);
    const html = renderDocumentHtml(publicSnapshot, 'ci', { thumbnails: {} });

    expect(serialized).not.toContain('cost_unit_price');
    expect(serialized).not.toContain('internal_expenses');
    expect(serialized).not.toContain('gross_profit');
    expect(html).not.toContain('98765.4321');
    expect(html).not.toContain('43210.99');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('فاتورة تجارية');
  });

  it('renders normal packages separately and combines matching package numbers', () => {
    const source = internalSnapshot();
    const lines = [
      source.lines[0],
      {
        ...source.lines[0],
        id: '20000000-0000-4000-8000-000000000002',
        line_no: 2,
        sku: 'SKU-2',
        name: 'منتج 2',
      },
    ];
    const normal = toPublicDocumentSnapshot({
      ...source,
      packing_mode: 'normal',
      lines,
      packages: buildDocumentPackages(lines, 'normal'),
    });
    const combined = toPublicDocumentSnapshot({
      ...source,
      packing_mode: 'combined',
      lines,
      packages: buildDocumentPackages(lines, 'combined'),
    });

    const normalHtml = renderDocumentHtml(normal, 'pl', { thumbnails: {} });
    const combinedHtml = renderDocumentHtml(combined, 'pl', { thumbnails: {} });
    expect(normalHtml.match(/<td>A-1<\/td>/g)).toHaveLength(2);
    expect(combinedHtml.match(/<td>A-1<\/td>/g)).toHaveLength(1);
    expect(combinedHtml).toContain('SKU-1<br>SKU-2');
  });
});
