import type { DocumentPackageSnapshot } from './document-packing';

export const DOCUMENT_TYPES = ['quote', 'pi', 'sc', 'ci', 'pl'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type DocumentLanguage = 'zh' | 'en' | 'ru' | 'es' | 'de' | 'ar';

export interface DocumentCustomFieldSnapshot {
  field_key: string;
  label: string;
  value: unknown;
  document_types: string[];
}

export interface PublicDocumentLineSnapshot {
  id: string;
  line_no: number;
  sku: string;
  name: string;
  description: string | null;
  quantity: string;
  unit: string;
  unit_price: string;
  line_total: string;
  allocated_charges: string;
  weight_kg: string | null;
  volume_cbm: string | null;
  total_weight_kg: string | null;
  total_volume_cbm: string | null;
  package_no: string | null;
  thumbnail_file_id: string | null;
  custom_fields: DocumentCustomFieldSnapshot[];
}

export interface PublicDocumentSnapshot {
  document_set_id: string;
  source_version: number;
  quote_number: string;
  status: 'draft' | 'locked';
  language: DocumentLanguage;
  incoterm: 'FOB' | 'CIF' | 'EXW';
  pricing_currency: string;
  settlement_currency: string;
  exchange_rate: string;
  discount_type: 'none' | 'percent' | 'amount';
  discount_value: string;
  allocation_method: 'equal' | 'value' | 'weight' | 'volume';
  packing_mode: 'normal' | 'combined';
  template_key: 'fixed_default';
  theme_color: string;
  visible_fields: Record<string, boolean>;
  terms: string | null;
  bank_info: string | null;
  logo_file_id: string | null;
  signature_file_id: string | null;
  customer: {
    id: string;
    company_name: string;
    contact_name: string | null;
    email: string | null;
    phone: string | null;
    country: string | null;
  } | null;
  lines: PublicDocumentLineSnapshot[];
  packages: DocumentPackageSnapshot[];
  totals: {
    subtotal: string;
    discount_amount: string;
    freight_amount: string;
    insurance_amount: string;
    tax_amount: string;
    grand_total: string;
    settlement_total: string;
    total_weight_kg: string;
    total_volume_cbm: string;
  };
  generated_at: string;
}

export interface InternalDocumentSnapshot extends PublicDocumentSnapshot {
  sales_order_id: string | null;
  pricing_mode: 'final_price' | 'cost_profit';
  internal_expenses: string;
  lines: Array<
    PublicDocumentLineSnapshot & {
      cost_unit_price: string | null;
      cost_total: string | null;
    }
  >;
  internal_totals: {
    cost_total: string;
    internal_expenses: string;
    gross_profit: string;
    gross_margin_bps: number | null;
  };
}

export interface DocumentRenderAssets {
  logo?: string;
  signature?: string;
  thumbnails: Record<string, string>;
}

export function toPublicDocumentSnapshot(
  snapshot: InternalDocumentSnapshot,
): PublicDocumentSnapshot {
  return {
    document_set_id: snapshot.document_set_id,
    source_version: snapshot.source_version,
    quote_number: snapshot.quote_number,
    status: snapshot.status,
    language: snapshot.language,
    incoterm: snapshot.incoterm,
    pricing_currency: snapshot.pricing_currency,
    settlement_currency: snapshot.settlement_currency,
    exchange_rate: snapshot.exchange_rate,
    discount_type: snapshot.discount_type,
    discount_value: snapshot.discount_value,
    allocation_method: snapshot.allocation_method,
    packing_mode: snapshot.packing_mode,
    template_key: snapshot.template_key,
    theme_color: snapshot.theme_color,
    visible_fields: snapshot.visible_fields,
    terms: snapshot.terms,
    bank_info: snapshot.bank_info,
    logo_file_id: snapshot.logo_file_id,
    signature_file_id: snapshot.signature_file_id,
    customer: snapshot.customer,
    packages: snapshot.packages,
    lines: snapshot.lines.map((line) => ({
      id: line.id,
      line_no: line.line_no,
      sku: line.sku,
      name: line.name,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unit_price: line.unit_price,
      line_total: line.line_total,
      allocated_charges: line.allocated_charges,
      weight_kg: line.weight_kg,
      volume_cbm: line.volume_cbm,
      total_weight_kg: line.total_weight_kg,
      total_volume_cbm: line.total_volume_cbm,
      package_no: line.package_no,
      thumbnail_file_id: line.thumbnail_file_id,
      custom_fields: line.custom_fields,
    })),
    totals: snapshot.totals,
    generated_at: snapshot.generated_at,
  };
}
