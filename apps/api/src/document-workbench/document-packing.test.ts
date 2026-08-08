import { describe, expect, it } from 'vitest';
import { buildDocumentPackages } from './document-packing';
import type { PublicDocumentLineSnapshot } from './document.types';

function line(
  lineNo: number,
  packageNo: string,
  weight: string,
  volume: string,
): PublicDocumentLineSnapshot {
  return {
    id: `20000000-0000-4000-8000-00000000000${lineNo}`,
    line_no: lineNo,
    sku: `SKU-${lineNo}`,
    name: `Product ${lineNo}`,
    description: null,
    quantity: '1.000',
    unit: 'pcs',
    unit_price: '10.0000',
    line_total: '10.00',
    allocated_charges: '0.00',
    weight_kg: weight,
    volume_cbm: volume,
    total_weight_kg: weight,
    total_volume_cbm: volume,
    package_no: packageNo,
    thumbnail_file_id: null,
    custom_fields: [],
  };
}

describe('document packing model', () => {
  const lines = [line(1, 'BOX-A', '1.2500', '0.100000'), line(2, 'BOX-A', '2.7500', '0.200000')];

  it('keeps one package row per line in normal mode', () => {
    const packages = buildDocumentPackages(lines, 'normal');
    expect(packages).toHaveLength(2);
    expect(packages.map((documentPackage) => documentPackage.line_nos)).toEqual([[1], [2]]);
  });

  it('groups matching package numbers and sums measures in combined mode', () => {
    expect(buildDocumentPackages(lines, 'combined')).toEqual([
      {
        package_no: 'BOX-A',
        line_nos: [1, 2],
        total_weight_kg: '4.0000',
        total_volume_cbm: '0.300000',
      },
    ]);
  });
});
