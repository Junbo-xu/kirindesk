import { IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Quantity: numeric(18,3) — up to 15 integer digits + optional 1-3 decimals,
// strictly positive (enforced here and by chk_*_quantity). Kept as a string to
// avoid float precision loss; the > 0 rule is checked via regex (no all-zero).
const QUANTITY = /^\d{1,15}(\.\d{1,3})?$/;
// Unit price: numeric(18,4) — up to 14 integer digits + optional 1-4 decimals,
// non-negative.
const UNIT_PRICE = /^\d{1,14}(\.\d{1,4})?$/;

/**
 * A single order line as submitted by the client. line_total and the order's
 * total_amount are NOT accepted from the client — they are derived server-side
 * (line_total = round(quantity * unit_price, 2)). line_no is assigned by the
 * server in array order, so it is not part of the input either.
 */
export class OrderItemInputDto {
  @IsOptional()
  @IsUUID()
  product_id?: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  product_code?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(16)
  unit?: string;

  @IsString()
  @Matches(QUANTITY, {
    message: 'quantity must be a positive number with up to 3 decimals',
  })
  quantity!: string;

  @IsString()
  @Matches(UNIT_PRICE, {
    message: 'unit_price must be a non-negative number with up to 4 decimals',
  })
  unit_price!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// DB row shape for a persisted line item (numeric columns come back as strings).
export interface OrderItemRow {
  id: string;
  tenant_id: string;
  order_id: string;
  product_id: string | null;
  source_document_line_id: string | null;
  source_line_snapshot: Record<string, unknown> | null;
  line_no: number;
  description: string;
  product_code: string | null;
  unit: string | null;
  quantity: string;
  unit_price: string;
  line_total: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

// Public response shape for a line item: explicit allowlist, never exposes
// tenant_id / order_id / deleted_at.
export interface OrderItemResponse {
  id: string;
  product_id: string | null;
  source_document_line_id: string | null;
  line_no: number;
  description: string;
  product_code: string | null;
  unit: string | null;
  quantity: string;
  unit_price: string;
  line_total: string;
  notes: string | null;
}

export function toOrderItemResponse(row: OrderItemRow): OrderItemResponse {
  return {
    id: row.id,
    product_id: row.product_id,
    source_document_line_id: row.source_document_line_id,
    line_no: row.line_no,
    description: row.description,
    product_code: row.product_code,
    unit: row.unit,
    quantity: row.quantity,
    unit_price: row.unit_price,
    line_total: row.line_total,
    notes: row.notes,
  };
}
