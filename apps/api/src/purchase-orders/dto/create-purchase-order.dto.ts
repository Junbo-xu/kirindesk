import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { OrderItemInputDto } from '../../sales-orders/dto/order-item.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// fx_rate: numeric(18,8) — up to 10 integer digits + optional 1-8 decimals,
// strictly positive (no all-zero); the > 0 rule is also enforced by
// chk_purchase_orders_fx_rate and re-checked in the service. Kept as a string to
// avoid float precision loss.
const FX_RATE = /^(?!0+(\.0+)?$)\d{1,10}(\.\d{1,8})?$/;

export class CreatePurchaseOrderDto {
  @IsUUID()
  supplier_id!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  order_number!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  pi_number?: string;

  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  currency!: string;

  // total_amount is intentionally NOT accepted from the client. It is derived
  // server-side as the sum of line_total over the items below (Phase 1F-A §6).

  // Optional manual exchange rate (original currency -> tenant base currency).
  // When omitted, the service looks it up from exchange_rates; when the order is
  // already in the base currency, the service forces rate=1 and ignores this.
  // total_amount_base is always derived server-side, never accepted here.
  @IsOptional()
  @IsString()
  @Matches(FX_RATE, {
    message: 'fx_rate must be a positive number with up to 8 decimals',
  })
  fx_rate?: string;

  @IsOptional()
  @IsIn(['draft', 'confirmed', 'completed', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  // Order lines. Optional + may be empty for draft orders; the service enforces
  // "non-draft must have >= 1 line" and derives total_amount from these.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];
}
