import { IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { OrderItemInputDto } from './order-item.dto';

// Updatable fields only. customer_id, order_number and pi_file_id are immutable
// in this phase and intentionally absent. total_amount is derived from items,
// never set directly by the client.
export class UpdateSalesOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  pi_number?: string;

  @IsOptional()
  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  currency?: string;

  @IsOptional()
  @IsIn(['draft', 'confirmed', 'completed', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;

  // When present, replaces the order's line set (full-array semantics): the
  // service diffs against existing lines, soft-deletes removed ones, and
  // re-derives total_amount. Absent = lines unchanged.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items?: OrderItemInputDto[];
}
