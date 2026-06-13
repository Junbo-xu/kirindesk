import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { OrderItemInputDto } from './order-item.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateSalesOrderDto {
  @IsUUID()
  customer_id!: string;

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
