import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Non-negative money matching numeric(18,2): up to 16 integer digits and an
// optional 1-2 digit fraction. Kept as a string to avoid float precision loss.
const MONEY = /^\d{1,16}(\.\d{1,2})?$/;

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

  @IsString()
  @Matches(MONEY, { message: 'total_amount must be a non-negative amount with up to 2 decimals' })
  total_amount!: string;

  @IsOptional()
  @IsIn(['draft', 'confirmed', 'completed', 'cancelled'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}
