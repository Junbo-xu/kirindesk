import type { PublicDocumentLineSnapshot } from './document.types';

export interface DocumentPackageSnapshot {
  package_no: string;
  line_nos: number[];
  total_weight_kg: string;
  total_volume_cbm: string;
}

function scaled(value: string, places: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(`${whole || '0'}${(fraction + '0'.repeat(places)).slice(0, places)}`);
}

function decimal(value: bigint, places: number): string {
  const text = value.toString().padStart(places + 1, '0');
  return `${text.slice(0, -places)}.${text.slice(-places)}`;
}

function sum(lines: PublicDocumentLineSnapshot[], key: 'total_weight_kg' | 'total_volume_cbm') {
  const places = key === 'total_weight_kg' ? 4 : 6;
  return decimal(
    lines.reduce((total, line) => total + scaled(line[key] ?? '0', places), 0n),
    places,
  );
}

function packageSnapshot(packageNo: string, lines: PublicDocumentLineSnapshot[]) {
  return {
    package_no: packageNo,
    line_nos: lines.map((line) => line.line_no),
    total_weight_kg: sum(lines, 'total_weight_kg'),
    total_volume_cbm: sum(lines, 'total_volume_cbm'),
  };
}

export function buildDocumentPackages(
  lines: PublicDocumentLineSnapshot[],
  packingMode: 'normal' | 'combined',
): DocumentPackageSnapshot[] {
  if (packingMode === 'normal') {
    return lines.map((line) =>
      packageSnapshot(line.package_no?.trim() || `PKG-${line.line_no}`, [line]),
    );
  }

  const groups = new Map<string, PublicDocumentLineSnapshot[]>();
  for (const line of lines) {
    const packageNo = line.package_no?.trim() || 'COMBINED-1';
    groups.set(packageNo, [...(groups.get(packageNo) ?? []), line]);
  }
  return [...groups.entries()].map(([packageNo, packageLines]) =>
    packageSnapshot(packageNo, packageLines),
  );
}
