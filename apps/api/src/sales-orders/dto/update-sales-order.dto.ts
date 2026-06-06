import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

const MONEY = /^\d{1,16}(\.\d{1,2})?$/;

// Updatable fields only. customer_id, order_number and pi_file_id are immutable
// in this phase and intentionally absent.
export class UpdateSalesOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  pi_number?: string;

  @IsOptional()
  @IsIn(['RMB', 'USD', 'HKD', 'EUR'])
  currency?: string;

  @IsOptional()
  @IsString()
  @Matches(MONEY, { message: 'total_amount must be a non-negative amount with up to 2 decimals' })
  total_amount?: string;

  @IsOptional()
  @IsIn(['draft', 'confirmed', 'completed', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}
