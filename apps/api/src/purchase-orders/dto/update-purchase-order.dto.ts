import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderItemInputDto } from '../../sales-orders/dto/order-item.dto';

// fx_rate: numeric(18,8), strictly positive. See CreatePurchaseOrderDto.
const FX_RATE = /^(?!0+(\.0+)?$)\d{1,10}(\.\d{1,8})?$/;

// Updatable fields only. supplier_id, order_number and pi_file_id are immutable
// in this phase and intentionally absent. total_amount is derived from items,
// never set directly by the client.
export class UpdatePurchaseOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  pi_number?: string;

  @IsOptional()
  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  currency?: string;

  // Optional manual exchange rate (original currency -> tenant base currency).
  // When omitted on update, the service re-resolves the rate from exchange_rates
  // (or forces 1 for same-currency) and re-derives total_amount_base.
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

  // When present, replaces the order's line set (full-array semantics): the
  // service soft-deletes existing lines and re-inserts, then re-derives
  // total_amount. Absent = lines unchanged.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];
}
