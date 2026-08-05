import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListSalesOrdersQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn([
    'draft',
    'pending_approval',
    'approved',
    'rejected',
    'confirmed',
    'completed',
    'customer_confirmed',
    'payment_gate_open',
    'procurement',
    'fulfillment',
    'delivered',
    'finance_review',
    'settled',
    'cancelled',
    'on_hold',
  ])
  status?: string;

  @IsOptional()
  @IsUUID()
  customer_id?: string;
}
