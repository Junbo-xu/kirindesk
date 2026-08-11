export interface CustomsDeclarationLine {
  line_no: number;
  sales_order_item_id: string;
  product_code: string;
  description: string;
  hs_code: string;
  declaration_elements: string;
  quantity: string;
  unit: string;
  unit_price: string;
  line_total: string;
  currency: string;
  package_no: string;
  net_weight_kg: string;
}

export interface CustomsDeclarationData {
  declaration_number: string;
  sales_order_id: string;
  order_number: string;
  port: string;
  trade_mode: string;
  package_type: string;
  package_count: number;
  gross_weight_kg: string;
  net_weight_kg: string;
  currency: string;
  total_amount: string;
  consignor: {
    name: string;
    uscc: string;
    contact: string;
    phone: string;
  };
  customs_broker: {
    name: string;
    uscc: string;
    contact: string;
    phone: string;
  };
  authorization_matters: string[];
  lines: CustomsDeclarationLine[];
}

export type CustomsDocumentType = 'pre_entry' | 'authorization';

export interface CustomsPdfSnapshot {
  version: number;
  generated_at: string;
  data: CustomsDeclarationData;
}
